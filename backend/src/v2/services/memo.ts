import type { Env } from "../../types";
import { rpc, type RpcContext } from "../router";
import { ConnectError, invalidArgument, notFound, permissionDenied, toTimestamp, fromTimestamp, unauthenticated } from "../connect";
import type { AuthContext } from "../auth";
import {
  newUid,
  parseName,
  resolvePage,
  encodePageToken,
  computePayload,
  getMemoByUid,
  MEMO_SELECT,
  visibilityWhere,
  memosToApiWithExtras,
  safeParse,
  UID_MATCHER,
  type MemoRow,
  type MemoPayload,
} from "../store";
import { parseMemoFilter } from "../filter";

// MemoService（memos v0.29 Connect API）。规格见 claude-oss-plan/4-v029-api-spec.md §2.6。

const nowSec = () => Math.floor(Date.now() / 1000);

const VISIBILITIES = new Set(["PRIVATE", "PROTECTED", "PUBLIC"]);
const DEFAULT_CONTENT_LENGTH_LIMIT = 8192;

// ---------- 通用辅助 ----------

const requireAuth = (ctx: RpcContext): AuthContext => {
  if (!ctx.auth) throw unauthenticated();
  return ctx.auth;
};

/** 创建者或 ADMIN */
const canManage = (auth: AuthContext, row: { creator_id: number }): boolean =>
  auth.userId === row.creator_id || auth.role === "ADMIN";

/** 按可见性规则校验单条 memo 的读取权限 */
const assertVisible = (auth: AuthContext | null, row: MemoRow): void => {
  if (row.visibility === "PUBLIC") return;
  if (!auth) throw notFound(`memo not found`);
  if (row.visibility === "PROTECTED") return;
  // PRIVATE
  if (!canManage(auth, row)) throw notFound(`memo not found`);
};

const memoUidFromName = (name: string | undefined): string => {
  const uid = name ? parseName(name, "memos") : null;
  if (!uid) throw invalidArgument(`invalid memo name: ${name ?? ""}`);
  return uid;
};

const getMemoOrThrow = async (env: Env, uid: string): Promise<MemoRow> => {
  const row = await getMemoByUid(env, uid);
  if (!row) throw notFound(`memo not found: memos/${uid}`);
  return row;
};

const getContentLengthLimit = async (env: Env): Promise<number> => {
  const row = await env.DB.prepare("SELECT value FROM system_setting WHERE name = 'MEMO_RELATED'").first<{ value: string }>();
  const limit = row ? safeParse(row.value).contentLengthLimit : undefined;
  return typeof limit === "number" && limit > 0 ? limit : DEFAULT_CONTENT_LENGTH_LIMIT;
};

const assertContentLength = async (env: Env, content: string): Promise<void> => {
  const limit = await getContentLengthLimit(env);
  if (content.length > limit) throw invalidArgument(`content too long (max ${limit} characters)`);
};

/** 从请求的 attachments[].name 提取 uid 列表 */
const attachmentUids = (attachments: unknown): string[] => {
  if (!Array.isArray(attachments)) return [];
  const uids: string[] = [];
  for (const a of attachments) {
    const uid = typeof a?.name === "string" ? parseName(a.name, "attachments") : null;
    if (!uid) throw invalidArgument(`invalid attachment name: ${a?.name ?? ""}`);
    uids.push(uid);
  }
  return uids;
};

/** 全量重设 memo 的附件绑定：先解绑全部，再绑定列表中属于 caller 的附件 */
const rebindAttachments = async (env: Env, memoId: number, callerId: number, uids: string[]): Promise<void> => {
  const stmts = [env.DB.prepare("UPDATE attachment SET memo_id = NULL WHERE memo_id = ?").bind(memoId)];
  if (uids.length > 0) {
    const ph = uids.map(() => "?").join(",");
    stmts.push(
      env.DB.prepare(`UPDATE attachment SET memo_id = ? WHERE uid IN (${ph}) AND creator_id = ?`).bind(
        memoId,
        ...uids,
        callerId,
      ),
    );
  }
  await env.DB.batch(stmts);
};

/** 从请求的 relations[] 提取 REFERENCE 目标 memo uid 列表（COMMENT 不允许由客户端直接写入） */
const referenceRelationUids = (relations: unknown): string[] => {
  if (!Array.isArray(relations)) return [];
  const uids: string[] = [];
  for (const r of relations) {
    if (r?.type === "COMMENT") continue;
    const name = r?.relatedMemo?.name;
    const uid = typeof name === "string" ? parseName(name, "memos") : null;
    if (!uid) throw invalidArgument(`invalid relation relatedMemo name: ${name ?? ""}`);
    uids.push(uid);
  }
  return uids;
};

/** 全量重设该 memo 为源的 REFERENCE 关系（COMMENT 关系不动） */
const resetReferenceRelations = async (env: Env, memoId: number, relatedUids: string[]): Promise<void> => {
  const stmts = [env.DB.prepare("DELETE FROM memo_relation WHERE memo_id = ? AND type = 'REFERENCE'").bind(memoId)];
  for (const uid of relatedUids) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO memo_relation (memo_id, related_memo_id, type)
         SELECT ?, id, 'REFERENCE' FROM memo WHERE uid = ?`,
      ).bind(memoId, uid),
    );
  }
  await env.DB.batch(stmts);
};

const normalizeLocation = (location: unknown): MemoPayload["location"] | undefined => {
  if (!location || typeof location !== "object") return undefined;
  const l = location as Record<string, unknown>;
  const out: NonNullable<MemoPayload["location"]> = {};
  if (typeof l.placeholder === "string" && l.placeholder) out.placeholder = l.placeholder;
  if (typeof l.latitude === "number") out.latitude = l.latitude;
  if (typeof l.longitude === "number") out.longitude = l.longitude;
  return Object.keys(out).length > 0 ? out : undefined;
};

const memoToApiFull = async (env: Env, row: MemoRow): Promise<Record<string, unknown>> => {
  const [api] = await memosToApiWithExtras(env, [row]);
  return api;
};

// ---------- orderBy（AIP-132，防注入白名单） ----------

const ORDER_FIELD_SQL: Record<string, string> = {
  pinned: "m.pinned",
  create_time: "m.created_ts",
  update_time: "m.updated_ts",
  name: "m.uid",
};

const parseOrderBy = (orderBy: string | undefined, fallback = "create_time desc"): string => {
  const spec = orderBy?.trim() || fallback;
  const clauses: string[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z_]+)(?:\s+(asc|desc))?$/i);
    const column = m ? ORDER_FIELD_SQL[m[1]] : undefined;
    if (!m || !column) throw invalidArgument(`unsupported order by: "${part}"`);
    clauses.push(`${column} ${m[2]?.toLowerCase() === "asc" ? "ASC" : m[2] ? "DESC" : "ASC"}`);
  }
  if (clauses.length === 0) throw invalidArgument("empty order by");
  clauses.push("m.id DESC"); // 稳定排序
  return clauses.join(", ");
};

// ---------- memo 创建（CreateMemo / CreateMemoComment 共用） ----------

interface CreateMemoInput {
  memo: any;
  memoId?: string;
}

const insertMemo = async (env: Env, auth: AuthContext, input: CreateMemoInput): Promise<MemoRow> => {
  const memo = input.memo ?? {};
  const content = typeof memo.content === "string" ? memo.content : "";
  await assertContentLength(env, content);

  const visibility = memo.visibility && memo.visibility !== "VISIBILITY_UNSPECIFIED" ? memo.visibility : "PRIVATE";
  if (!VISIBILITIES.has(visibility)) throw invalidArgument(`invalid visibility: ${visibility}`);

  let uid = newUid();
  if (input.memoId) {
    if (!UID_MATCHER.test(input.memoId)) throw invalidArgument(`invalid memo id: ${input.memoId}`);
    const existing = await getMemoByUid(env, input.memoId);
    if (existing) throw new ConnectError("already_exists", `memo already exists: memos/${input.memoId}`);
    uid = input.memoId;
  }

  const now = nowSec();
  const createdTs = fromTimestamp(memo.createTime) ?? now;
  const updatedTs = fromTimestamp(memo.updateTime) ?? now;
  const payload = computePayload(content, normalizeLocation(memo.location));

  await env.DB.prepare(
    `INSERT INTO memo (uid, creator_id, created_ts, updated_ts, row_status, content, visibility, pinned, payload)
     VALUES (?, ?, ?, ?, 'NORMAL', ?, ?, 0, ?)`,
  )
    .bind(uid, auth.userId, createdTs, updatedTs, content, visibility, JSON.stringify(payload))
    .run();

  const row = await getMemoOrThrow(env, uid);

  const uids = attachmentUids(memo.attachments);
  if (uids.length > 0) await rebindAttachments(env, row.id, auth.userId, uids);

  const relUids = referenceRelationUids(memo.relations);
  if (relUids.length > 0) await resetReferenceRelations(env, row.id, relUids);

  return row;
};

// ============================================================
// CreateMemo
// ============================================================
rpc("MemoService", "CreateMemo", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const row = await insertMemo(ctx.env, auth, { memo: req.memo, memoId: req.memoId });
  return memoToApiFull(ctx.env, row);
});

// ============================================================
// ListMemos（公开）
// ============================================================
rpc("MemoService", "ListMemos", "optional", async (req, ctx) => {
  const state = req.state && req.state !== "STATE_UNSPECIFIED" ? req.state : "NORMAL";
  if (state !== "NORMAL" && state !== "ARCHIVED") throw invalidArgument(`invalid state: ${state}`);

  const { where: filterWhere, params: filterParams } = parseMemoFilter(req.filter);
  const [visWhere, visParams] = visibilityWhere(ctx.auth);
  const orderSql = parseOrderBy(req.orderBy);
  const { limit, offset } = resolvePage(req);

  // 对齐上游：主列表排除 COMMENT 子 memo
  const notComment = `NOT EXISTS (SELECT 1 FROM memo_relation mr WHERE mr.memo_id = m.id AND mr.type = 'COMMENT')`;

  const sql = `${MEMO_SELECT}
    WHERE m.row_status = ? AND ${visWhere} AND ${notComment} AND ${filterWhere}
    ORDER BY ${orderSql} LIMIT ? OFFSET ?`;
  const res = await ctx.env.DB.prepare(sql)
    .bind(state, ...visParams, ...filterParams, limit + 1, offset)
    .all<MemoRow>();

  const rows = res.results ?? [];
  const hasNext = rows.length > limit;
  const memos = await memosToApiWithExtras(ctx.env, rows.slice(0, limit));
  return {
    memos,
    nextPageToken: hasNext ? encodePageToken(limit, offset + limit) : "",
  };
});

// ============================================================
// GetMemo（公开；PRIVATE 仅创建者/ADMIN，PROTECTED 需登录）
// ============================================================
rpc("MemoService", "GetMemo", "optional", async (req, ctx) => {
  const uid = memoUidFromName(req.name);
  const row = await getMemoOrThrow(ctx.env, uid);
  assertVisible(ctx.auth, row);
  return memoToApiFull(ctx.env, row);
});

// ============================================================
// UpdateMemo
// ============================================================
rpc("MemoService", "UpdateMemo", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const memo = req.memo ?? {};
  const uid = memoUidFromName(memo.name);
  const row = await getMemoOrThrow(ctx.env, uid);
  if (!canManage(auth, row)) throw permissionDenied();

  const paths: string[] = Array.isArray(req.updateMask?.paths) ? req.updateMask.paths : [];
  if (paths.length === 0) throw invalidArgument("update_mask is required");

  const sets: string[] = [];
  const params: unknown[] = [];
  let payload = safeParse(row.payload) as Partial<MemoPayload>;
  let payloadDirty = false;
  let updateTimeSet = false;

  // location 与 content 有先后耦合：content 重算 payload 时保留 location
  const newLocation = paths.includes("location") ? normalizeLocation(memo.location) : payload.location;

  for (const path of paths) {
    switch (path) {
      case "content": {
        const content = typeof memo.content === "string" ? memo.content : "";
        await assertContentLength(ctx.env, content);
        payload = computePayload(content, newLocation);
        payloadDirty = true;
        sets.push("content = ?");
        params.push(content);
        break;
      }
      case "location": {
        if (newLocation) payload.location = newLocation;
        else delete payload.location;
        payloadDirty = true;
        break;
      }
      case "visibility": {
        if (!VISIBILITIES.has(memo.visibility)) throw invalidArgument(`invalid visibility: ${memo.visibility}`);
        sets.push("visibility = ?");
        params.push(memo.visibility);
        break;
      }
      case "pinned": {
        sets.push("pinned = ?");
        params.push(memo.pinned ? 1 : 0);
        break;
      }
      case "state": {
        if (memo.state !== "NORMAL" && memo.state !== "ARCHIVED") throw invalidArgument(`invalid state: ${memo.state}`);
        sets.push("row_status = ?");
        params.push(memo.state);
        break;
      }
      case "create_time": {
        const ts = fromTimestamp(memo.createTime);
        if (ts == null) throw invalidArgument("invalid create_time");
        sets.push("created_ts = ?");
        params.push(ts);
        break;
      }
      case "update_time": {
        const ts = fromTimestamp(memo.updateTime);
        if (ts == null) throw invalidArgument("invalid update_time");
        sets.push("updated_ts = ?");
        params.push(ts);
        updateTimeSet = true;
        break;
      }
      case "attachments": {
        await rebindAttachments(ctx.env, row.id, auth.userId, attachmentUids(memo.attachments));
        break;
      }
      case "relations": {
        await resetReferenceRelations(ctx.env, row.id, referenceRelationUids(memo.relations));
        break;
      }
      default:
        // 未知 path 忽略（与上游宽松语义一致）
        break;
    }
  }

  if (payloadDirty) {
    sets.push("payload = ?");
    params.push(JSON.stringify(payload));
  }
  if (!updateTimeSet) {
    sets.push("updated_ts = ?");
    params.push(nowSec());
  }

  await ctx.env.DB.prepare(`UPDATE memo SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...params, row.id)
    .run();

  const updated = await getMemoOrThrow(ctx.env, uid);
  return memoToApiFull(ctx.env, updated);
});

// ============================================================
// DeleteMemo（级联删 COMMENT 子树、reactions、shares，解绑附件）
// ============================================================

/** 收集 memo 及其 COMMENT 子树的全部 id */
const collectCommentTree = async (env: Env, rootId: number): Promise<number[]> => {
  const all = new Set<number>([rootId]);
  let frontier = [rootId];
  while (frontier.length > 0) {
    const ph = frontier.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT memo_id FROM memo_relation WHERE type = 'COMMENT' AND related_memo_id IN (${ph})`,
    )
      .bind(...frontier)
      .all<{ memo_id: number }>();
    frontier = (res.results ?? []).map((r) => r.memo_id).filter((id) => !all.has(id));
    for (const id of frontier) all.add(id);
  }
  return [...all];
};

rpc("MemoService", "DeleteMemo", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const uid = memoUidFromName(req.name);
  const row = await getMemoOrThrow(ctx.env, uid);
  if (!canManage(auth, row)) throw permissionDenied();

  const ids = await collectCommentTree(ctx.env, row.id);
  const ph = ids.map(() => "?").join(",");
  const uidRes = await ctx.env.DB.prepare(`SELECT uid FROM memo WHERE id IN (${ph})`)
    .bind(...ids)
    .all<{ uid: string }>();
  const contentIds = (uidRes.results ?? []).map((r) => `memos/${r.uid}`);
  const cph = contentIds.map(() => "?").join(",");

  const stmts = [
    ctx.env.DB.prepare(`UPDATE attachment SET memo_id = NULL WHERE memo_id IN (${ph})`).bind(...ids),
    ctx.env.DB.prepare(`DELETE FROM memo_share WHERE memo_id IN (${ph})`).bind(...ids),
    ctx.env.DB.prepare(`DELETE FROM memo_relation WHERE memo_id IN (${ph}) OR related_memo_id IN (${ph})`).bind(
      ...ids,
      ...ids,
    ),
    ctx.env.DB.prepare(`DELETE FROM memo WHERE id IN (${ph})`).bind(...ids),
  ];
  if (contentIds.length > 0) {
    stmts.unshift(ctx.env.DB.prepare(`DELETE FROM reaction WHERE content_id IN (${cph})`).bind(...contentIds));
  }
  await ctx.env.DB.batch(stmts);
  return {};
});

// ============================================================
// CreateMemoComment
// ============================================================
rpc("MemoService", "CreateMemoComment", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const parentUid = memoUidFromName(req.name);
  const parent = await getMemoOrThrow(ctx.env, parentUid);
  assertVisible(ctx.auth, parent);

  const commentRow = await insertMemo(ctx.env, auth, { memo: req.comment, memoId: req.commentId });

  await ctx.env.DB.prepare(
    `INSERT OR IGNORE INTO memo_relation (memo_id, related_memo_id, type) VALUES (?, ?, 'COMMENT')`,
  )
    .bind(commentRow.id, parent.id)
    .run();

  // 父 memo 作者收到 MEMO_COMMENT 通知（自评不通知）
  if (parent.creator_id !== auth.userId) {
    const commentPayload = safeParse(commentRow.payload) as Partial<MemoPayload>;
    const parentPayload = safeParse(parent.payload) as Partial<MemoPayload>;
    const message = JSON.stringify({
      type: "MEMO_COMMENT",
      memo: `memos/${commentRow.uid}`,
      relatedMemo: `memos/${parent.uid}`,
      memoSnippet: commentPayload.snippet ?? "",
      relatedMemoSnippet: parentPayload.snippet ?? "",
    });
    await ctx.env.DB.prepare(
      `INSERT INTO inbox (created_ts, sender_id, receiver_id, status, message) VALUES (?, ?, ?, 'UNREAD', ?)`,
    )
      .bind(nowSec(), auth.userId, parent.creator_id, message)
      .run();
  }

  return memoToApiFull(ctx.env, commentRow);
});

// ============================================================
// ListMemoComments（公开，随父 memo 可见性）
// ============================================================
rpc("MemoService", "ListMemoComments", "optional", async (req, ctx) => {
  const parentUid = memoUidFromName(req.name);
  const parent = await getMemoOrThrow(ctx.env, parentUid);
  assertVisible(ctx.auth, parent);

  const [visWhere, visParams] = visibilityWhere(ctx.auth);
  const orderSql = parseOrderBy(req.orderBy, "create_time asc");
  const { limit, offset } = resolvePage(req);

  const baseWhere = `EXISTS (SELECT 1 FROM memo_relation r WHERE r.memo_id = m.id AND r.related_memo_id = ? AND r.type = 'COMMENT')
    AND m.row_status = 'NORMAL' AND ${visWhere}`;

  const [listRes, countRes] = await Promise.all([
    ctx.env.DB.prepare(`${MEMO_SELECT} WHERE ${baseWhere} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
      .bind(parent.id, ...visParams, limit + 1, offset)
      .all<MemoRow>(),
    ctx.env.DB.prepare(`SELECT COUNT(*) AS c FROM memo m JOIN user u ON u.id = m.creator_id WHERE ${baseWhere}`)
      .bind(parent.id, ...visParams)
      .first<{ c: number }>(),
  ]);

  const rows = listRes.results ?? [];
  const hasNext = rows.length > limit;
  const memos = await memosToApiWithExtras(ctx.env, rows.slice(0, limit));
  return {
    memos,
    nextPageToken: hasNext ? encodePageToken(limit, offset + limit) : "",
    totalSize: countRes?.c ?? memos.length,
  };
});

// ============================================================
// Reactions
// ============================================================

interface ReactionRow {
  id: number;
  created_ts: number;
  creator_id: number;
  content_id: string;
  reaction_type: string;
  username?: string;
}

const reactionToApi = (row: ReactionRow, username: string): Record<string, unknown> => ({
  name: `${row.content_id}/reactions/${row.id}`,
  creator: `users/${username}`,
  contentId: row.content_id,
  reactionType: row.reaction_type,
  createTime: toTimestamp(row.created_ts),
});

rpc("MemoService", "UpsertMemoReaction", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const memoUid = memoUidFromName(req.name);
  const memo = await getMemoOrThrow(ctx.env, memoUid);
  assertVisible(ctx.auth, memo);

  const reactionType = req.reaction?.reactionType;
  if (typeof reactionType !== "string" || !reactionType) throw invalidArgument("reaction_type is required");
  const contentId = `memos/${memoUid}`;

  await ctx.env.DB.prepare(
    `INSERT INTO reaction (created_ts, creator_id, content_id, reaction_type) VALUES (?, ?, ?, ?)
     ON CONFLICT (creator_id, content_id, reaction_type) DO NOTHING`,
  )
    .bind(nowSec(), auth.userId, contentId, reactionType)
    .run();

  const row = await ctx.env.DB.prepare(
    `SELECT * FROM reaction WHERE creator_id = ? AND content_id = ? AND reaction_type = ?`,
  )
    .bind(auth.userId, contentId, reactionType)
    .first<ReactionRow>();
  if (!row) throw notFound("reaction not found after upsert");
  return reactionToApi(row, auth.username);
});

rpc("MemoService", "DeleteMemoReaction", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const m = typeof req.name === "string" ? req.name.match(/^memos\/([^/]+)\/reactions\/(\d+)$/) : null;
  if (!m) throw invalidArgument(`invalid reaction name: ${req.name ?? ""}`);
  const reactionId = Number(m[2]);

  const row = await ctx.env.DB.prepare("SELECT * FROM reaction WHERE id = ?").bind(reactionId).first<ReactionRow>();
  if (!row || row.content_id !== `memos/${m[1]}`) throw notFound(`reaction not found: ${req.name}`);
  if (row.creator_id !== auth.userId && auth.role !== "ADMIN") throw permissionDenied();

  await ctx.env.DB.prepare("DELETE FROM reaction WHERE id = ?").bind(reactionId).run();
  return {};
});

// ============================================================
// Shares
// ============================================================

interface MemoShareRow {
  id: number;
  uid: string;
  memo_id: number;
  creator_id: number;
  created_ts: number;
  expires_ts: number | null;
}

const shareToApi = (row: MemoShareRow, memoUid: string): Record<string, unknown> => ({
  name: `memos/${memoUid}/shares/${row.uid}`,
  createTime: toTimestamp(row.created_ts),
  ...(row.expires_ts != null ? { expireTime: toTimestamp(row.expires_ts) } : {}),
});

rpc("MemoService", "CreateMemoShare", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const memoUid = memoUidFromName(req.parent);
  const memo = await getMemoOrThrow(ctx.env, memoUid);
  if (!canManage(auth, memo)) throw permissionDenied();

  const token = newUid();
  const expiresTs = fromTimestamp(req.memoShare?.expireTime) ?? null;
  await ctx.env.DB.prepare(
    `INSERT INTO memo_share (uid, memo_id, creator_id, created_ts, expires_ts) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(token, memo.id, auth.userId, nowSec(), expiresTs)
    .run();

  const row = await ctx.env.DB.prepare("SELECT * FROM memo_share WHERE uid = ?").bind(token).first<MemoShareRow>();
  if (!row) throw notFound("share not found after create");
  return shareToApi(row, memoUid);
});

rpc("MemoService", "ListMemoShares", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const memoUid = memoUidFromName(req.parent);
  const memo = await getMemoOrThrow(ctx.env, memoUid);
  if (!canManage(auth, memo)) throw permissionDenied();

  const res = await ctx.env.DB.prepare("SELECT * FROM memo_share WHERE memo_id = ? ORDER BY id DESC")
    .bind(memo.id)
    .all<MemoShareRow>();
  return { memoShares: (res.results ?? []).map((row) => shareToApi(row, memoUid)) };
});

rpc("MemoService", "DeleteMemoShare", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const m = typeof req.name === "string" ? req.name.match(/^memos\/([^/]+)\/shares\/([A-Za-z0-9-]+)$/) : null;
  if (!m) throw invalidArgument(`invalid share name: ${req.name ?? ""}`);

  const memo = await getMemoOrThrow(ctx.env, m[1]);
  if (!canManage(auth, memo)) throw permissionDenied();

  const share = await ctx.env.DB.prepare("SELECT * FROM memo_share WHERE uid = ? AND memo_id = ?")
    .bind(m[2], memo.id)
    .first<MemoShareRow>();
  if (!share) throw notFound(`share not found: ${req.name}`);

  await ctx.env.DB.prepare("DELETE FROM memo_share WHERE id = ?").bind(share.id).run();
  return {};
});

// GetMemoByShare（公开，凭 token；过期/不存在 → not_found；无视可见性返回完整 memo）
rpc("MemoService", "GetMemoByShare", "optional", async (req, ctx) => {
  const shareId = req.shareId;
  if (typeof shareId !== "string" || !shareId) throw invalidArgument("share_id is required");

  const share = await ctx.env.DB.prepare("SELECT * FROM memo_share WHERE uid = ?").bind(shareId).first<MemoShareRow>();
  if (!share || (share.expires_ts != null && share.expires_ts < nowSec())) {
    throw notFound("share not found or expired");
  }

  const row = await ctx.env.DB.prepare(`${MEMO_SELECT} WHERE m.id = ?`).bind(share.memo_id).first<MemoRow>();
  if (!row) throw notFound("memo not found");
  return memoToApiFull(ctx.env, row);
});

// ============================================================
// GetLinkMetadata（公开；抓取 OG 标签，失败返回空字段）
// ============================================================

const PRIVATE_IPV4 =
  /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** SSRF 防护：只允许 http(s)，拒绝 localhost 与私网 IP 字面量 */
const assertSafeUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidArgument(`invalid url: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidArgument(`unsupported url protocol: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  const bareV6 = host.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    PRIVATE_IPV4.test(host) ||
    bareV6 === "::1" ||
    bareV6 === "::" ||
    /^(?:fc|fd)/.test(bareV6) ||
    bareV6.startsWith("fe80:")
  ) {
    throw invalidArgument("url target is not allowed");
  }
  return url;
};

const decodeEntities = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");

/** 提取 <meta property|name="og:x" content="..."> ，兼容属性顺序颠倒 */
const extractMeta = (html: string, property: string): string => {
  const p = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]*(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${p}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1].trim());
  }
  return "";
};

rpc("MemoService", "GetLinkMetadata", "optional", async (req, ctx) => {
  const rawUrl = req.url;
  if (typeof rawUrl !== "string" || !rawUrl) throw invalidArgument("url is required");
  const url = assertSafeUrl(rawUrl);

  const empty = { url: rawUrl, title: "", description: "", image: "" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);
    if (!resp.ok) return empty;
    const contentType = resp.headers.get("Content-Type") ?? "";
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return empty;
    // 只取前 512KB，避免超大页面拖垮 Worker
    const html = (await resp.text()).slice(0, 512 * 1024);

    let title = extractMeta(html, "og:title");
    if (!title) {
      const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (m?.[1]) title = decodeEntities(m[1].replace(/\s+/g, " ").trim());
    }
    return {
      url: rawUrl,
      title,
      description: extractMeta(html, "og:description") || extractMeta(html, "description"),
      image: extractMeta(html, "og:image"),
    };
  } catch {
    return empty;
  }
});
