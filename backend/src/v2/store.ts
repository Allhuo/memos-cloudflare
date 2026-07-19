import type { Env } from "../types";
import { toTimestamp } from "./connect";

// v2 共享存储层：uid/分页/资源名/payload 计算与 行 → API JSON 转换。
// 字段名一律为 proto3 JSON 映射（camelCase）；int64 输出为字符串；时间为 RFC3339。

// ---------- uid / 资源名 ----------

export const newUid = (): string => crypto.randomUUID().replace(/-/g, "").slice(0, 22);

export const parseName = (name: string, prefix: string): string | null => {
  if (!name?.startsWith(`${prefix}/`)) return null;
  return name.slice(prefix.length + 1);
};

/** users/{username}/child/{id} → { username, id } */
export const parseChildName = (name: string, child: string): { username: string; id: string } | null => {
  const m = name?.match(new RegExp(`^users/([^/]+)/${child}/(.+)$`));
  return m ? { username: m[1], id: m[2] } : null;
};

export const UID_MATCHER = /^[A-Za-z0-9-]+$/;

// ---------- 分页 ----------

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 1000;

export const decodePageToken = (token: string | undefined): { limit: number; offset: number } | null => {
  if (!token) return null;
  try {
    const parsed = JSON.parse(atob(token));
    if (typeof parsed.limit === "number" && typeof parsed.offset === "number") return parsed;
  } catch {
    /* fallthrough */
  }
  return null;
};

export const encodePageToken = (limit: number, offset: number): string => btoa(JSON.stringify({ limit, offset }));

export const resolvePage = (req: { pageSize?: number; pageToken?: string }) => {
  const fromToken = decodePageToken(req.pageToken);
  const limit = Math.min(fromToken?.limit ?? (req.pageSize && req.pageSize > 0 ? req.pageSize : DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const offset = fromToken?.offset ?? 0;
  return { limit, offset };
};

// ---------- memo payload 计算（写入时调用）----------

export interface MemoPayload {
  tags: string[];
  property: { hasLink: boolean; hasTaskList: boolean; hasCode: boolean; hasIncompleteTasks: boolean; title: string };
  snippet: string;
  location?: { placeholder?: string; latitude?: number; longitude?: number };
}

export const computePayload = (content: string, location?: MemoPayload["location"]): MemoPayload => {
  const tags = new Set<string>();
  // #tag 提取：跳过代码块与行内代码
  const withoutCode = content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of withoutCode.matchAll(/(?:^|\s)#([^\s#,;.!?"'()[\]{}]+)/g)) tags.add(m[1]);

  const hasLink = /\[[^\]]*\]\([^)]+\)/.test(content) || /https?:\/\/\S+/.test(withoutCode);
  const hasTaskList = /^[ \t]*[-*+] \[[ xX]\] /m.test(content);
  const hasIncompleteTasks = /^[ \t]*[-*+] \[ \] /m.test(content);
  const hasCode = /```/.test(content) || /`[^`\n]+`/.test(content);

  const firstLine = content.split("\n").find((l) => l.trim().length > 0) || "";
  const title = firstLine.replace(/^#+\s*/, "").trim().slice(0, 256);

  const plain = withoutCode
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const snippet = plain.length > 64 ? `${plain.slice(0, 64)}…` : plain;

  return {
    tags: [...tags],
    property: { hasLink, hasTaskList, hasCode, hasIncompleteTasks, title },
    snippet,
    ...(location ? { location } : {}),
  };
};

// ---------- 行类型 ----------

export interface UserRow {
  id: number;
  created_ts: number;
  updated_ts: number;
  row_status: string;
  username: string;
  role: string;
  email: string;
  nickname: string;
  password_hash: string;
  avatar_url: string;
  description: string;
}

export interface MemoRow {
  id: number;
  uid: string;
  creator_id: number;
  creator_username: string;
  created_ts: number;
  updated_ts: number;
  row_status: string;
  content: string;
  visibility: string;
  pinned: number;
  payload: string;
}

export interface AttachmentRow {
  id: number;
  uid: string;
  creator_id: number;
  created_ts: number;
  filename: string;
  type: string;
  size: number;
  memo_id: number | null;
  memo_uid?: string | null;
  storage_type: string;
  reference: string;
  payload: string;
}

// ---------- 行 → API JSON ----------

export const userToApi = (row: UserRow, opts: { includeSensitive: boolean }): Record<string, unknown> => ({
  name: `users/${row.username}`,
  role: row.role,
  username: row.username,
  email: opts.includeSensitive ? row.email : "",
  displayName: row.nickname,
  avatarUrl: row.avatar_url,
  description: row.description,
  state: row.row_status,
  createTime: toTimestamp(row.created_ts),
  updateTime: toTimestamp(row.updated_ts),
});

export const attachmentToApi = (row: AttachmentRow): Record<string, unknown> => {
  const payload = safeParse(row.payload);
  return {
    name: `attachments/${row.uid}`,
    createTime: toTimestamp(row.created_ts),
    filename: row.filename,
    externalLink: row.storage_type === "EXTERNAL" ? row.reference : "",
    type: row.type,
    size: String(row.size),
    ...(row.memo_uid ? { memo: `memos/${row.memo_uid}` } : {}),
    ...(payload.motionMedia ? { motionMedia: payload.motionMedia } : {}),
  };
};

export const safeParse = (json: string | null | undefined): Record<string, any> => {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
};

/** memo 行 → API Memo。attachments/relations/reactions 需调用方批量查询后传入。 */
export const memoToApi = (
  row: MemoRow,
  extra: {
    attachments?: Record<string, unknown>[];
    relations?: Record<string, unknown>[];
    reactions?: Record<string, unknown>[];
    parent?: string;
  } = {},
): Record<string, unknown> => {
  const payload = safeParse(row.payload) as Partial<MemoPayload>;
  return {
    name: `memos/${row.uid}`,
    state: row.row_status,
    creator: `users/${row.creator_username}`,
    createTime: toTimestamp(row.created_ts),
    updateTime: toTimestamp(row.updated_ts),
    content: row.content,
    visibility: row.visibility,
    tags: payload.tags ?? [],
    pinned: row.pinned === 1,
    attachments: extra.attachments ?? [],
    relations: extra.relations ?? [],
    reactions: extra.reactions ?? [],
    property: payload.property ?? { hasLink: false, hasTaskList: false, hasCode: false, hasIncompleteTasks: false, title: "" },
    ...(extra.parent ? { parent: extra.parent } : {}),
    snippet: payload.snippet ?? "",
    ...(payload.location ? { location: payload.location } : {}),
  };
};

// ---------- 常用查询 ----------

export const getUserById = (env: Env, id: number) =>
  env.DB.prepare("SELECT * FROM user WHERE id = ?").bind(id).first<UserRow>();

export const getUserByUsername = (env: Env, username: string) =>
  env.DB.prepare("SELECT * FROM user WHERE username = ?").bind(username).first<UserRow>();

export const MEMO_SELECT = `SELECT m.*, u.username AS creator_username FROM memo m JOIN user u ON u.id = m.creator_id`;

export const getMemoByUid = (env: Env, uid: string) =>
  env.DB.prepare(`${MEMO_SELECT} WHERE m.uid = ?`).bind(uid).first<MemoRow>();

/** 可见性 SQL 条件。返回 [whereSql, params]，别名假定 memo 表为 m。 */
export const visibilityWhere = (auth: { userId: number } | null): [string, unknown[]] => {
  if (!auth) return ["m.visibility = 'PUBLIC'", []];
  return ["(m.visibility IN ('PUBLIC', 'PROTECTED') OR m.creator_id = ?)", [auth.userId]];
};

/** 批量装配 memo 的 attachments/relations/reactions，返回 memoToApi 完整结果列表 */
export const memosToApiWithExtras = async (env: Env, rows: MemoRow[]): Promise<Record<string, unknown>[]> => {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const uids = rows.map((r) => `memos/${r.uid}`);
  const ph = ids.map(() => "?").join(",");

  const [attachments, relations, reactions, parents] = await Promise.all([
    env.DB.prepare(
      `SELECT a.*, m.uid AS memo_uid FROM attachment a JOIN memo m ON m.id = a.memo_id WHERE a.memo_id IN (${ph}) ORDER BY a.id`,
    )
      .bind(...ids)
      .all<AttachmentRow>(),
    env.DB.prepare(
      `SELECT r.type, r.memo_id, r.related_memo_id,
              sm.uid AS memo_uid, json_extract(sm.payload,'$.snippet') AS memo_snippet,
              tm.uid AS related_uid, json_extract(tm.payload,'$.snippet') AS related_snippet
       FROM memo_relation r JOIN memo sm ON sm.id = r.memo_id JOIN memo tm ON tm.id = r.related_memo_id
       WHERE r.memo_id IN (${ph}) OR r.related_memo_id IN (${ph})`,
    )
      .bind(...ids, ...ids)
      .all<any>(),
    env.DB.prepare(
      `SELECT r.id, r.created_ts, r.content_id, r.reaction_type, u.username FROM reaction r JOIN user u ON u.id = r.creator_id
       WHERE r.content_id IN (${uids.map(() => "?").join(",")}) ORDER BY r.id`,
    )
      .bind(...uids)
      .all<any>(),
    env.DB.prepare(
      `SELECT r.memo_id, tm.uid AS parent_uid FROM memo_relation r JOIN memo tm ON tm.id = r.related_memo_id
       WHERE r.type = 'COMMENT' AND r.memo_id IN (${ph})`,
    )
      .bind(...ids)
      .all<any>(),
  ]);

  const attachmentsByMemo = new Map<number, Record<string, unknown>[]>();
  for (const a of attachments.results ?? []) {
    const list = attachmentsByMemo.get(a.memo_id!) ?? [];
    list.push(attachmentToApi(a));
    attachmentsByMemo.set(a.memo_id!, list);
  }

  const relationsByMemo = new Map<number, Record<string, unknown>[]>();
  for (const r of relations.results ?? []) {
    const api = {
      memo: { name: `memos/${r.memo_uid}`, snippet: r.memo_snippet ?? "" },
      relatedMemo: { name: `memos/${r.related_uid}`, snippet: r.related_snippet ?? "" },
      type: r.type,
    };
    for (const id of [r.memo_id, r.related_memo_id]) {
      if (!ids.includes(id)) continue;
      const list = relationsByMemo.get(id) ?? [];
      list.push(api);
      relationsByMemo.set(id, list);
    }
  }

  const reactionsByContent = new Map<string, Record<string, unknown>[]>();
  for (const r of reactions.results ?? []) {
    const list = reactionsByContent.get(r.content_id) ?? [];
    list.push({
      name: `${r.content_id}/reactions/${r.id}`,
      creator: `users/${r.username}`,
      contentId: r.content_id,
      reactionType: r.reaction_type,
      createTime: toTimestamp(r.created_ts),
    });
    reactionsByContent.set(r.content_id, list);
  }

  const parentByMemo = new Map<number, string>();
  for (const p of parents.results ?? []) parentByMemo.set(p.memo_id, `memos/${p.parent_uid}`);

  return rows.map((row) =>
    memoToApi(row, {
      attachments: attachmentsByMemo.get(row.id) ?? [],
      relations: relationsByMemo.get(row.id) ?? [],
      reactions: reactionsByContent.get(`memos/${row.uid}`) ?? [],
      parent: parentByMemo.get(row.id),
    }),
  );
};
