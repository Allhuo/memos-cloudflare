import { invalidArgument } from "./connect";

// ListMemos filter 的 CEL 子集解析器 → SQL WHERE。
// 覆盖上游 internal/filter/schema.go 中前端实际会生成的形态（见规格书 §2.6）：
//   标识符: content/creator/creator_id/created_ts/updated_ts/pinned/visibility/
//           tag/tags/has_task_list/has_link/has_code/has_incomplete_tasks
//   运算:   == != < <= > >= in .contains() && || ! ( )
// SQL 假定 memo 别名 m、user 别名 u（已 JOIN）。

type Token =
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "op"; value: string };

const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < input.length && input[j] !== ch) {
        if (input[j] === "\\" && j + 1 < input.length) {
          value += input[j + 1];
          j += 2;
        } else {
          value += input[j];
          j++;
        }
      }
      if (j >= input.length) throw invalidArgument("filter: unterminated string");
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = input.slice(i).match(/^\d+(\.\d+)?/)!;
      tokens.push({ kind: "number", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = input.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)!;
      tokens.push({ kind: "ident", value: m[0] });
      i += m[0].length;
      continue;
    }
    const three = input.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(three)) {
      tokens.push({ kind: "op", value: three });
      i += 2;
      continue;
    }
    if ("()[]<>!,.".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    throw invalidArgument(`filter: unexpected character '${ch}'`);
  }
  return tokens;
};

const FIELD_SQL: Record<string, string> = {
  content: "m.content",
  creator_id: "m.creator_id",
  created_ts: "m.created_ts",
  updated_ts: "m.updated_ts",
  visibility: "m.visibility",
  creator: "u.username",
};

const BOOL_SQL: Record<string, string> = {
  pinned: "m.pinned = 1",
  has_task_list: "json_extract(m.payload, '$.property.hasTaskList') = 1",
  has_link: "json_extract(m.payload, '$.property.hasLink') = 1",
  has_code: "json_extract(m.payload, '$.property.hasCode') = 1",
  has_incomplete_tasks: "json_extract(m.payload, '$.property.hasIncompleteTasks') = 1",
};

// creator == "users/{username}" → username 比较
const creatorValue = (v: unknown): unknown => (typeof v === "string" && v.startsWith("users/") ? v.slice(6) : v);

export class FilterParser {
  private tokens: Token[];
  private pos = 0;
  readonly params: unknown[] = [];

  constructor(filter: string) {
    this.tokens = tokenize(filter);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw invalidArgument("filter: unexpected end of expression");
    return t;
  }

  private expectOp(value: string) {
    const t = this.next();
    if (t.kind !== "op" || t.value !== value) throw invalidArgument(`filter: expected '${value}'`);
  }

  parse(): string {
    const sql = this.parseOr();
    if (this.pos < this.tokens.length) throw invalidArgument("filter: trailing tokens");
    return sql;
  }

  private parseOr(): string {
    let left = this.parseAnd();
    while (this.peek()?.kind === "op" && this.peek()!.value === "||") {
      this.next();
      left = `(${left} OR ${this.parseAnd()})`;
    }
    return left;
  }

  private parseAnd(): string {
    let left = this.parseUnary();
    while (this.peek()?.kind === "op" && this.peek()!.value === "&&") {
      this.next();
      left = `(${left} AND ${this.parseUnary()})`;
    }
    return left;
  }

  private parseUnary(): string {
    const t = this.peek();
    if (t?.kind === "op" && t.value === "!") {
      this.next();
      return `NOT (${this.parseUnary()})`;
    }
    if (t?.kind === "op" && t.value === "(") {
      this.next();
      const inner = this.parseOr();
      this.expectOp(")");
      return `(${inner})`;
    }
    return this.parsePredicate();
  }

  private parsePredicate(): string {
    const t = this.next();
    if (t.kind !== "ident") throw invalidArgument("filter: expected identifier");
    const field = t.value;

    // 裸布尔
    if (BOOL_SQL[field] && !(this.peek()?.kind === "op" && [".", "==", "!=", "in"].some((op) => this.peek()!.value === op))) {
      return BOOL_SQL[field];
    }

    const nextTok = this.peek();

    // content.contains("x")
    if (nextTok?.kind === "op" && nextTok.value === ".") {
      this.next();
      const method = this.next();
      if (method.kind !== "ident" || method.value !== "contains") throw invalidArgument("filter: only .contains() is supported");
      this.expectOp("(");
      const arg = this.next();
      if (arg.kind !== "string") throw invalidArgument("filter: contains() expects a string");
      this.expectOp(")");
      if (field !== "content") throw invalidArgument(`filter: ${field}.contains() not supported`);
      this.params.push(`%${escapeLike(arg.value)}%`);
      return `m.content LIKE ? ESCAPE '\\'`;
    }

    // tag in ["a","b"] / visibility in [...]
    if (nextTok?.kind === "ident" && nextTok.value === "in") {
      this.next();
      const values = this.parseList();
      if (field === "tag" || field === "tags") {
        const conds = values.map(() => `EXISTS (SELECT 1 FROM json_each(m.payload, '$.tags') WHERE json_each.value = ?)`);
        this.params.push(...values);
        return `(${conds.join(" OR ")})`;
      }
      const sqlField = FIELD_SQL[field];
      if (!sqlField) throw invalidArgument(`filter: unknown field '${field}'`);
      this.params.push(...values.map(field === "creator" ? creatorValue : (v: unknown) => v));
      return `${sqlField} IN (${values.map(() => "?").join(",")})`;
    }

    // 比较运算
    if (nextTok?.kind === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(nextTok.value)) {
      const op = (this.next() as { value: string }).value;
      const sqlOp = op === "==" ? "=" : op;
      const valueTok = this.next();
      let value: unknown;
      if (valueTok.kind === "string") value = valueTok.value;
      else if (valueTok.kind === "number") value = valueTok.value;
      else if (valueTok.kind === "ident" && (valueTok.value === "true" || valueTok.value === "false"))
        value = valueTok.value === "true";
      else throw invalidArgument("filter: expected literal value");

      if (field === "tag" || field === "tags") {
        if (op !== "==" && op !== "!=") throw invalidArgument("filter: tag only supports ==/!=/in");
        this.params.push(value);
        const exists = `EXISTS (SELECT 1 FROM json_each(m.payload, '$.tags') WHERE json_each.value = ?)`;
        return op === "==" ? exists : `NOT ${exists}`;
      }
      if (BOOL_SQL[field]) {
        const positive = value === true;
        const sql = BOOL_SQL[field];
        return (op === "==") === positive ? sql : `NOT (${sql})`;
      }
      const sqlField = FIELD_SQL[field];
      if (!sqlField) throw invalidArgument(`filter: unknown field '${field}'`);
      this.params.push(field === "creator" ? creatorValue(value) : value);
      return `${sqlField} ${sqlOp} ?`;
    }

    throw invalidArgument(`filter: cannot parse predicate for '${field}'`);
  }

  private parseList(): unknown[] {
    this.expectOp("[");
    const values: unknown[] = [];
    for (;;) {
      const t = this.next();
      if (t.kind === "string" || t.kind === "number") values.push(t.value);
      else throw invalidArgument("filter: list expects literals");
      const sep = this.next();
      if (sep.kind === "op" && sep.value === "]") break;
      if (!(sep.kind === "op" && sep.value === ",")) throw invalidArgument("filter: expected ',' or ']'");
    }
    if (values.length === 0) throw invalidArgument("filter: empty list");
    return values;
  }
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** 解析 filter → { where, params }。空 filter 返回恒真。 */
export const parseMemoFilter = (filter: string | undefined): { where: string; params: unknown[] } => {
  if (!filter?.trim()) return { where: "1=1", params: [] };
  const parser = new FilterParser(filter);
  const where = parser.parse();
  return { where, params: parser.params };
};
