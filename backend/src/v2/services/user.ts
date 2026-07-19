// UserService（memos.api.v1.UserService）— 规格见 claude-oss-plan/4-v029-api-spec.md §2.5/§4.2/§4.6/§4.7
// 公开方法（§1.9 白名单）：CreateUser / GetUser / BatchGetUsers / GetUserStats / ListAllUserStats → "optional"
// 其余方法 → "required"

import type { Env } from "../../types";
import { rpc, type RpcContext } from "../router";
import { invalidArgument, notFound, permissionDenied, unauthenticated, toTimestamp, ConnectError } from "../connect";
import { generatePatToken, sha256hex, type AuthContext } from "../auth";
import { hashPassword } from "../password";
import {
  newUid,
  parseName,
  parseChildName,
  resolvePage,
  encodePageToken,
  userToApi,
  getUserByUsername,
  UID_MATCHER,
  safeParse,
  visibilityWhere,
  type UserRow,
  type MemoPayload,
} from "../store";

// ---------- 通用辅助 ----------

const requireAuth = (ctx: RpcContext): AuthContext => {
  if (!ctx.auth) throw unauthenticated();
  return ctx.auth;
};

const isAdmin = (auth: AuthContext | null): boolean => auth?.role === "ADMIN";

const canSeeSensitive = (auth: AuthContext | null, targetUsername: string): boolean =>
  !!auth && (auth.username === targetUsername || auth.role === "ADMIN");

/** system_setting 里的 GENERAL（instance/settings/GENERAL），未持久化时为空对象 */
const getInstanceGeneralSetting = async (env: Env): Promise<Record<string, any>> => {
  const row = await env.DB.prepare("SELECT value FROM system_setting WHERE name = 'GENERAL'").first<{ value: string }>();
  return safeParse(row?.value);
};

/** 校验 name = "users/{username}" 并取用户，不存在抛 not_found */
const mustGetUserByName = async (env: Env, name: string): Promise<UserRow> => {
  const username = parseName(name, "users");
  if (!username) throw invalidArgument(`invalid user name: ${name}`);
  const user = await getUserByUsername(env, username);
  if (!user) throw notFound(`user not found: ${name}`);
  return user;
};

/** updateMask paths 统一为 snake_case */
const normalizePaths = (req: any): string[] =>
  ((req?.updateMask?.paths ?? []) as string[]).map((p) => p.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));

const validateUsername = (username: unknown): string => {
  if (typeof username !== "string" || username.length === 0) throw invalidArgument("username is required");
  if (/^\d+$/.test(username)) throw invalidArgument("username cannot be pure numbers");
  if (!UID_MATCHER.test(username)) throw invalidArgument("username can only contain letters, numbers and hyphens");
  return username;
};

// ---------- GetUser / BatchGetUsers / ListUsers ----------

rpc("UserService", "GetUser", "optional", async (req, ctx) => {
  const user = await mustGetUserByName(ctx.env, req.name);
  return userToApi(user, { includeSensitive: canSeeSensitive(ctx.auth, user.username) });
});

rpc("UserService", "BatchGetUsers", "optional", async (req, ctx) => {
  // 规格书请求为 {usernames: string[]}；兼容 proto 的 {names: ["users/x"]}
  const usernames: string[] = Array.isArray(req.usernames)
    ? req.usernames
    : Array.isArray(req.names)
      ? req.names.map((n: string) => parseName(n, "users") ?? n)
      : [];
  if (usernames.length === 0) return { users: [] };

  const ph = usernames.map(() => "?").join(",");
  const rows = await ctx.env.DB.prepare(
    `SELECT * FROM user WHERE username IN (${ph}) AND row_status = 'NORMAL'`,
  )
    .bind(...usernames)
    .all<UserRow>();
  return {
    users: (rows.results ?? []).map((u) => userToApi(u, { includeSensitive: canSeeSensitive(ctx.auth, u.username) })),
  };
});

rpc("UserService", "ListUsers", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  if (!isAdmin(auth)) throw permissionDenied("only admin can list users");

  const where: string[] = [];
  const params: unknown[] = [];
  if (!req.showDeleted) where.push("row_status = 'NORMAL'");
  // filter 仅支持 username == 'x'
  if (typeof req.filter === "string" && req.filter.trim()) {
    const m = req.filter.match(/username\s*==\s*["']([^"']*)["']/);
    if (!m) throw invalidArgument(`unsupported filter: ${req.filter}`);
    where.push("username = ?");
    params.push(m[1]);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { limit, offset } = resolvePage(req);
  const [rows, count] = await Promise.all([
    ctx.env.DB.prepare(`SELECT * FROM user ${whereSql} ORDER BY id ASC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<UserRow>(),
    ctx.env.DB.prepare(`SELECT COUNT(*) AS c FROM user ${whereSql}`)
      .bind(...params)
      .first<{ c: number }>(),
  ]);
  const users = (rows.results ?? []).map((u) => userToApi(u, { includeSensitive: true }));
  const totalSize = count?.c ?? users.length;
  return {
    users,
    nextPageToken: offset + users.length < totalSize && users.length === limit ? encodePageToken(limit, offset + limit) : "",
    totalSize,
  };
});

// ---------- CreateUser / UpdateUser / DeleteUser ----------

rpc("UserService", "CreateUser", "optional", async (req, ctx) => {
  const user = req.user ?? {};
  const username = validateUsername(user.username);
  if (typeof user.password !== "string" || user.password.length === 0) throw invalidArgument("password is required");

  const countRow = await ctx.env.DB.prepare("SELECT COUNT(*) AS c FROM user").first<{ c: number }>();
  const isFirstUser = (countRow?.c ?? 0) === 0;

  let role = "USER";
  if (isFirstUser) {
    role = "ADMIN";
  } else if (isAdmin(ctx.auth)) {
    if (user.role === "ADMIN" || user.role === "USER") role = user.role;
  } else {
    const general = await getInstanceGeneralSetting(ctx.env);
    if (general.disallowUserRegistration) throw permissionDenied("user registration is not allowed");
    if (general.disallowPasswordAuth) throw permissionDenied("password authentication is not allowed");
  }

  const existing = await getUserByUsername(ctx.env, username);
  if (existing) throw new ConnectError("already_exists", `username already exists: ${username}`);

  const email = typeof user.email === "string" ? user.email : "";
  const nickname = typeof user.displayName === "string" ? user.displayName : "";
  const now = Math.floor(Date.now() / 1000);

  if (req.validateOnly) {
    return {
      name: `users/${username}`,
      role,
      username,
      email,
      displayName: nickname,
      avatarUrl: "",
      description: "",
      state: "NORMAL",
      createTime: toTimestamp(now),
      updateTime: toTimestamp(now),
    };
  }

  const passwordHash = await hashPassword(user.password);
  await ctx.env.DB.prepare(
    `INSERT INTO user (created_ts, updated_ts, row_status, username, role, email, nickname, password_hash, avatar_url, description)
     VALUES (?, ?, 'NORMAL', ?, ?, ?, ?, ?, '', '')`,
  )
    .bind(now, now, username, role, email, nickname, passwordHash)
    .run();

  const created = await getUserByUsername(ctx.env, username);
  if (!created) throw new ConnectError("internal", "failed to create user");
  return userToApi(created, { includeSensitive: true });
});

rpc("UserService", "UpdateUser", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const target = await mustGetUserByName(ctx.env, req.user?.name);
  const admin = isAdmin(auth);
  if (!admin && auth.userId !== target.id) throw permissionDenied("cannot update other user");

  const paths = normalizePaths(req);
  if (paths.length === 0) throw invalidArgument("update_mask is required");

  const general = await getInstanceGeneralSetting(ctx.env);
  const sets: string[] = [];
  const params: unknown[] = [];
  const user = req.user ?? {};

  for (const path of paths) {
    switch (path) {
      case "username": {
        if (!admin && general.disallowChangeUsername) throw permissionDenied("changing username is not allowed");
        const username = validateUsername(user.username);
        if (username !== target.username) {
          const dup = await getUserByUsername(ctx.env, username);
          if (dup) throw new ConnectError("already_exists", `username already exists: ${username}`);
        }
        sets.push("username = ?");
        params.push(username);
        break;
      }
      case "password": {
        if (typeof user.password !== "string" || user.password.length === 0) throw invalidArgument("password is required");
        sets.push("password_hash = ?");
        params.push(await hashPassword(user.password));
        break;
      }
      case "role": {
        if (!admin) throw permissionDenied("only admin can update role");
        if (user.role !== "ADMIN" && user.role !== "USER") throw invalidArgument(`invalid role: ${user.role}`);
        sets.push("role = ?");
        params.push(user.role);
        break;
      }
      case "state": {
        if (!admin) throw permissionDenied("only admin can update state");
        if (user.state !== "NORMAL" && user.state !== "ARCHIVED") throw invalidArgument(`invalid state: ${user.state}`);
        sets.push("row_status = ?");
        params.push(user.state);
        break;
      }
      case "email":
        sets.push("email = ?");
        params.push(typeof user.email === "string" ? user.email : "");
        break;
      case "display_name": {
        if (!admin && general.disallowChangeNickname) throw permissionDenied("changing nickname is not allowed");
        sets.push("nickname = ?");
        params.push(typeof user.displayName === "string" ? user.displayName : "");
        break;
      }
      case "description":
        sets.push("description = ?");
        params.push(typeof user.description === "string" ? user.description : "");
        break;
      case "avatar_url":
        sets.push("avatar_url = ?");
        params.push(typeof user.avatarUrl === "string" ? user.avatarUrl : "");
        break;
      default:
        throw invalidArgument(`unsupported update path: ${path}`);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  sets.push("updated_ts = ?");
  params.push(now);
  await ctx.env.DB.prepare(`UPDATE user SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...params, target.id)
    .run();

  const updated = await ctx.env.DB.prepare("SELECT * FROM user WHERE id = ?").bind(target.id).first<UserRow>();
  if (!updated) throw new ConnectError("internal", "failed to update user");
  return userToApi(updated, { includeSensitive: true });
});

rpc("UserService", "DeleteUser", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const target = await mustGetUserByName(ctx.env, req.name);
  if (!isAdmin(auth) && auth.userId !== target.id) throw permissionDenied("cannot delete other user");

  // 手动级联（memo/attachment 的 creator_id 外键无 CASCADE）；
  // memo 删除会级联 memo_relation / memo_share；user 删除会级联
  // user_setting / inbox / refresh_token / personal_access_token / shortcut / user_identity / reaction。
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM reaction WHERE content_id IN (SELECT 'memos/' || uid FROM memo WHERE creator_id = ?)").bind(
      target.id,
    ),
    ctx.env.DB.prepare("DELETE FROM attachment WHERE creator_id = ?").bind(target.id),
    ctx.env.DB.prepare("DELETE FROM memo WHERE creator_id = ?").bind(target.id),
    ctx.env.DB.prepare("DELETE FROM user WHERE id = ?").bind(target.id),
  ]);
  return {};
});

// ---------- UserStats ----------

interface StatsMemoRow {
  uid: string;
  created_ts: number;
  updated_ts: number;
  pinned: number;
  payload: string;
}

const emptyStats = (username: string): Record<string, unknown> => ({
  name: `users/${username}`,
  memoTypeStats: { linkCount: 0, codeCount: 0, todoCount: 0, undoCount: 0 },
  tagCount: {} as Record<string, number>,
  memoCreatedTimestamps: [] as string[],
  memoUpdatedTimestamps: [] as string[],
  pinnedMemos: [] as string[],
  totalMemoCount: 0,
});

const accumulateStats = (stats: Record<string, any>, row: StatsMemoRow): void => {
  const payload = safeParse(row.payload) as Partial<MemoPayload>;
  const property = payload.property;
  if (property?.hasLink) stats.memoTypeStats.linkCount += 1;
  if (property?.hasCode) stats.memoTypeStats.codeCount += 1;
  if (property?.hasTaskList) stats.memoTypeStats.todoCount += 1;
  if (property?.hasIncompleteTasks) stats.memoTypeStats.undoCount += 1;
  for (const tag of payload.tags ?? []) {
    stats.tagCount[tag] = (stats.tagCount[tag] ?? 0) + 1;
  }
  stats.memoCreatedTimestamps.push(toTimestamp(row.created_ts));
  stats.memoUpdatedTimestamps.push(toTimestamp(row.updated_ts));
  if (row.pinned === 1) stats.pinnedMemos.push(`memos/${row.uid}`);
  stats.totalMemoCount += 1;
};

rpc("UserService", "GetUserStats", "optional", async (req, ctx) => {
  const target = await mustGetUserByName(ctx.env, req.name);
  const [visSql, visParams] = visibilityWhere(ctx.auth);
  const rows = await ctx.env.DB.prepare(
    `SELECT m.uid, m.created_ts, m.updated_ts, m.pinned, m.payload FROM memo m
     WHERE m.creator_id = ? AND m.row_status = 'NORMAL' AND ${visSql} ORDER BY m.created_ts DESC`,
  )
    .bind(target.id, ...visParams)
    .all<StatsMemoRow>();

  const stats = emptyStats(target.username);
  for (const row of rows.results ?? []) accumulateStats(stats, row);
  return stats;
});

rpc("UserService", "ListAllUserStats", "optional", async (_req, ctx) => {
  const [visSql, visParams] = visibilityWhere(ctx.auth);
  const [users, memos] = await Promise.all([
    ctx.env.DB.prepare("SELECT id, username FROM user WHERE row_status = 'NORMAL'").all<{ id: number; username: string }>(),
    ctx.env.DB.prepare(
      `SELECT m.creator_id, m.uid, m.created_ts, m.updated_ts, m.pinned, m.payload FROM memo m
       WHERE m.row_status = 'NORMAL' AND ${visSql} ORDER BY m.created_ts DESC`,
    )
      .bind(...visParams)
      .all<StatsMemoRow & { creator_id: number }>(),
  ]);

  const statsByUserId = new Map<number, Record<string, any>>();
  for (const u of users.results ?? []) statsByUserId.set(u.id, emptyStats(u.username));
  for (const row of memos.results ?? []) {
    const stats = statsByUserId.get(row.creator_id);
    if (stats) accumulateStats(stats, row);
  }
  return { stats: [...statsByUserId.values()] };
});

// ---------- UserSetting（user_setting 表 key=GENERAL/WEBHOOKS）----------

const DEFAULT_GENERAL_SETTING = { locale: "en", memoVisibility: "PRIVATE", theme: "" };

const getUserSettingValue = async (env: Env, userId: number, key: string): Promise<Record<string, any> | null> => {
  const row = await env.DB.prepare("SELECT value FROM user_setting WHERE user_id = ? AND key = ?")
    .bind(userId, key)
    .first<{ value: string }>();
  return row ? safeParse(row.value) : null;
};

const upsertUserSetting = (env: Env, userId: number, key: string, value: Record<string, any>) =>
  env.DB.prepare(
    `INSERT INTO user_setting (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
  )
    .bind(userId, key, JSON.stringify(value))
    .run();

const getGeneralSetting = async (env: Env, userId: number): Promise<Record<string, any>> => ({
  ...DEFAULT_GENERAL_SETTING,
  ...((await getUserSettingValue(env, userId, "GENERAL")) ?? {}),
});

/** 解析 users/{u}/settings/{KEY}，并校验 caller 为本人或 ADMIN，返回目标用户 */
const mustGetSettingTarget = async (ctx: RpcContext, username: string): Promise<UserRow> => {
  const auth = requireAuth(ctx);
  const target = await getUserByUsername(ctx.env, username);
  if (!target) throw notFound(`user not found: users/${username}`);
  if (!isAdmin(auth) && auth.userId !== target.id) throw permissionDenied("permission denied");
  return target;
};

rpc("UserService", "ListUserSettings", "required", async (req, ctx) => {
  const username = parseName(req.parent, "users");
  if (!username) throw invalidArgument(`invalid parent: ${req.parent}`);
  const target = await mustGetSettingTarget(ctx, username);

  const settings = [
    { name: `users/${target.username}/settings/GENERAL`, generalSetting: await getGeneralSetting(ctx.env, target.id) },
    { name: `users/${target.username}/settings/WEBHOOKS`, webhooksSetting: { webhooks: await loadWebhooks(ctx.env, target) } },
  ];
  return { settings, nextPageToken: "", totalSize: settings.length };
});

rpc("UserService", "UpdateUserSetting", "required", async (req, ctx) => {
  const parsed = parseChildName(req.setting?.name, "settings");
  if (!parsed) throw invalidArgument(`invalid setting name: ${req.setting?.name}`);
  if (parsed.id !== "GENERAL") throw invalidArgument(`unsupported setting key: ${parsed.id}`);
  const target = await mustGetSettingTarget(ctx, parsed.username);

  const paths = normalizePaths(req);
  if (paths.length === 0) throw invalidArgument("update_mask is required");

  const current = await getGeneralSetting(ctx.env, target.id);
  const incoming = req.setting?.generalSetting ?? {};
  for (const path of paths) {
    switch (path) {
      case "locale":
        current.locale = typeof incoming.locale === "string" ? incoming.locale : current.locale;
        break;
      case "memo_visibility":
        current.memoVisibility = typeof incoming.memoVisibility === "string" ? incoming.memoVisibility : current.memoVisibility;
        break;
      case "theme":
        current.theme = typeof incoming.theme === "string" ? incoming.theme : current.theme;
        break;
      default:
        throw invalidArgument(`unsupported update path: ${path}`);
    }
  }
  await upsertUserSetting(ctx.env, target.id, "GENERAL", current);
  return { name: `users/${target.username}/settings/GENERAL`, generalSetting: current };
});

// ---------- Webhook（存 user_setting key=WEBHOOKS 的 JSON）----------

interface StoredWebhook {
  name: string;
  url: string;
  displayName: string;
  createTime: string;
  updateTime: string;
}

const loadWebhooks = async (env: Env, user: UserRow): Promise<StoredWebhook[]> => {
  const value = await getUserSettingValue(env, user.id, "WEBHOOKS");
  const webhooks = Array.isArray(value?.webhooks) ? (value.webhooks as StoredWebhook[]) : [];
  return webhooks;
};

const saveWebhooks = (env: Env, userId: number, webhooks: StoredWebhook[]) =>
  upsertUserSetting(env, userId, "WEBHOOKS", { webhooks });

rpc("UserService", "ListUserWebhooks", "required", async (req, ctx) => {
  const username = parseName(req.parent, "users");
  if (!username) throw invalidArgument(`invalid parent: ${req.parent}`);
  const target = await mustGetSettingTarget(ctx, username);
  return { webhooks: await loadWebhooks(ctx.env, target) };
});

rpc("UserService", "CreateUserWebhook", "required", async (req, ctx) => {
  const username = parseName(req.parent, "users");
  if (!username) throw invalidArgument(`invalid parent: ${req.parent}`);
  const target = await mustGetSettingTarget(ctx, username);

  const url = req.webhook?.url;
  if (typeof url !== "string" || url.length === 0) throw invalidArgument("webhook url is required");

  const webhooks = await loadWebhooks(ctx.env, target);
  let id = Date.now();
  while (webhooks.some((w) => w.name.endsWith(`/webhooks/${id}`))) id += 1;
  const now = toTimestamp(Math.floor(Date.now() / 1000))!;
  const webhook: StoredWebhook = {
    name: `users/${target.username}/webhooks/${id}`,
    url,
    displayName: typeof req.webhook?.displayName === "string" ? req.webhook.displayName : "",
    createTime: now,
    updateTime: now,
  };
  webhooks.push(webhook);
  await saveWebhooks(ctx.env, target.id, webhooks);
  return webhook as unknown as Record<string, unknown>;
});

rpc("UserService", "UpdateUserWebhook", "required", async (req, ctx) => {
  const parsed = parseChildName(req.webhook?.name, "webhooks");
  if (!parsed) throw invalidArgument(`invalid webhook name: ${req.webhook?.name}`);
  const target = await mustGetSettingTarget(ctx, parsed.username);

  const webhooks = await loadWebhooks(ctx.env, target);
  const webhook = webhooks.find((w) => w.name === req.webhook.name);
  if (!webhook) throw notFound(`webhook not found: ${req.webhook.name}`);

  const paths = normalizePaths(req);
  const apply = (path: string) => {
    if (path === "url") {
      if (typeof req.webhook.url === "string" && req.webhook.url.length > 0) webhook.url = req.webhook.url;
    } else if (path === "display_name") {
      if (typeof req.webhook.displayName === "string") webhook.displayName = req.webhook.displayName;
    } else {
      throw invalidArgument(`unsupported update path: ${path}`);
    }
  };
  if (paths.length > 0) {
    for (const path of paths) apply(path);
  } else {
    // 无 mask 时按提供的字段更新
    if (typeof req.webhook.url === "string" && req.webhook.url.length > 0) webhook.url = req.webhook.url;
    if (typeof req.webhook.displayName === "string") webhook.displayName = req.webhook.displayName;
  }
  webhook.updateTime = toTimestamp(Math.floor(Date.now() / 1000))!;
  await saveWebhooks(ctx.env, target.id, webhooks);
  return webhook as unknown as Record<string, unknown>;
});

rpc("UserService", "DeleteUserWebhook", "required", async (req, ctx) => {
  const parsed = parseChildName(req.name, "webhooks");
  if (!parsed) throw invalidArgument(`invalid webhook name: ${req.name}`);
  const target = await mustGetSettingTarget(ctx, parsed.username);

  const webhooks = await loadWebhooks(ctx.env, target);
  const next = webhooks.filter((w) => w.name !== req.name);
  if (next.length === webhooks.length) throw notFound(`webhook not found: ${req.name}`);
  await saveWebhooks(ctx.env, target.id, next);
  return {};
});

// ---------- PersonalAccessToken ----------

interface PatRow {
  uid: string;
  user_id: number;
  description: string;
  created_ts: number;
  expires_ts: number | null;
  last_used_ts: number | null;
}

const patToApi = (username: string, row: PatRow): Record<string, unknown> => ({
  name: `users/${username}/personalAccessTokens/${row.uid}`,
  description: row.description,
  createdAt: toTimestamp(row.created_ts),
  ...(row.expires_ts != null ? { expiresAt: toTimestamp(row.expires_ts) } : {}),
  ...(row.last_used_ts != null ? { lastUsedAt: toTimestamp(row.last_used_ts) } : {}),
});

rpc("UserService", "ListPersonalAccessTokens", "required", async (req, ctx) => {
  const username = parseName(req.parent, "users");
  if (!username) throw invalidArgument(`invalid parent: ${req.parent}`);
  const target = await mustGetSettingTarget(ctx, username);

  const rows = await ctx.env.DB.prepare(
    "SELECT * FROM personal_access_token WHERE user_id = ? ORDER BY created_ts DESC",
  )
    .bind(target.id)
    .all<PatRow>();
  const tokens = (rows.results ?? []).map((r) => patToApi(target.username, r));
  return { personalAccessTokens: tokens, nextPageToken: "", totalSize: tokens.length };
});

rpc("UserService", "CreatePersonalAccessToken", "required", async (req, ctx) => {
  const username = parseName(req.parent, "users");
  if (!username) throw invalidArgument(`invalid parent: ${req.parent}`);
  const target = await mustGetSettingTarget(ctx, username);

  const token = generatePatToken();
  const tokenHash = await sha256hex(token);
  const uid = newUid();
  const now = Math.floor(Date.now() / 1000);
  const expiresInDays = Number(req.expiresInDays ?? 0);
  const expiresTs = Number.isFinite(expiresInDays) && expiresInDays > 0 ? now + expiresInDays * 24 * 60 * 60 : null;

  await ctx.env.DB.prepare(
    `INSERT INTO personal_access_token (uid, user_id, token_hash, description, created_ts, expires_ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(uid, target.id, tokenHash, typeof req.description === "string" ? req.description : "", now, expiresTs)
    .run();

  return {
    personalAccessToken: patToApi(target.username, {
      uid,
      user_id: target.id,
      description: typeof req.description === "string" ? req.description : "",
      created_ts: now,
      expires_ts: expiresTs,
      last_used_ts: null,
    }),
    token, // 仅创建时返回一次
  };
});

rpc("UserService", "DeletePersonalAccessToken", "required", async (req, ctx) => {
  const parsed = parseChildName(req.name, "personalAccessTokens");
  if (!parsed) throw invalidArgument(`invalid token name: ${req.name}`);
  const target = await mustGetSettingTarget(ctx, parsed.username);

  const result = await ctx.env.DB.prepare("DELETE FROM personal_access_token WHERE uid = ? AND user_id = ?")
    .bind(parsed.id, target.id)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw notFound(`personal access token not found: ${req.name}`);
  return {};
});

// ---------- LinkedIdentity（user_identity 表）----------

interface IdentityRow {
  id: number;
  user_id: number;
  provider: string;
  extern_uid: number | string;
  created_ts: number;
}

const identityToApi = (username: string, row: IdentityRow): Record<string, unknown> => ({
  name: `users/${username}/linkedIdentities/${row.id}`,
  idpName: `identity-providers/${row.provider}`,
  externUid: String(row.extern_uid),
});

rpc("UserService", "ListLinkedIdentities", "required", async (req, ctx) => {
  const username = parseName(req.parent, "users");
  if (!username) throw invalidArgument(`invalid parent: ${req.parent}`);
  const target = await mustGetSettingTarget(ctx, username);

  const rows = await ctx.env.DB.prepare("SELECT * FROM user_identity WHERE user_id = ? ORDER BY id ASC")
    .bind(target.id)
    .all<IdentityRow>();
  return { linkedIdentities: (rows.results ?? []).map((r) => identityToApi(target.username, r)) };
});

rpc("UserService", "CreateLinkedIdentity", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const username = parseName(req.parent, "users");
  if (!username) throw invalidArgument(`invalid parent: ${req.parent}`);
  if (auth.username !== username) throw permissionDenied("can only link identity for yourself");
  const target = await getUserByUsername(ctx.env, username);
  if (!target) throw notFound(`user not found: ${req.parent}`);

  const idpUid = parseName(req.idpName, "identity-providers");
  if (!idpUid) throw invalidArgument(`invalid idp name: ${req.idpName}`);
  if (typeof req.code !== "string" || !req.code) throw invalidArgument("code is required");

  const idp = await ctx.env.DB.prepare("SELECT * FROM idp WHERE uid = ?")
    .bind(idpUid)
    .first<{ uid: string; type: string; config: string }>();
  if (!idp) throw notFound(`identity provider not found: ${req.idpName}`);

  const config = safeParse(idp.config);
  const oauth2 = (config.oauth2Config ?? config) as Record<string, any>;
  if (!oauth2.tokenUrl || !oauth2.userInfoUrl || !oauth2.clientId) {
    throw invalidArgument("identity provider is not configured for OAuth2");
  }

  // OAuth2 authorization_code 交换
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: req.code,
    redirect_uri: typeof req.redirectUri === "string" ? req.redirectUri : "",
    client_id: String(oauth2.clientId),
    client_secret: String(oauth2.clientSecret ?? ""),
  });
  if (typeof req.codeVerifier === "string" && req.codeVerifier) form.set("code_verifier", req.codeVerifier);

  const tokenResp = await fetch(String(oauth2.tokenUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  if (!tokenResp.ok) throw invalidArgument(`failed to exchange OAuth2 code: ${tokenResp.status}`);
  const tokenBody = (await tokenResp.json().catch(() => ({}))) as Record<string, any>;
  const accessToken = tokenBody.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw invalidArgument("OAuth2 token response missing access_token");

  const userInfoResp = await fetch(String(oauth2.userInfoUrl), {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!userInfoResp.ok) throw invalidArgument(`failed to fetch OAuth2 user info: ${userInfoResp.status}`);
  const userInfo = (await userInfoResp.json().catch(() => ({}))) as Record<string, any>;
  const identifierField = oauth2.fieldMapping?.identifier || "sub";
  const externUid = userInfo[identifierField] != null ? String(userInfo[identifierField]) : "";
  if (!externUid) throw invalidArgument(`OAuth2 user info missing identifier field: ${identifierField}`);

  const now = Math.floor(Date.now() / 1000);
  let insertResult;
  try {
    insertResult = await ctx.env.DB.prepare(
      "INSERT INTO user_identity (user_id, provider, extern_uid, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(target.id, idp.uid, externUid, now, now)
      .run();
  } catch {
    throw new ConnectError("already_exists", "identity is already linked");
  }

  return identityToApi(target.username, {
    id: Number(insertResult.meta.last_row_id),
    user_id: target.id,
    provider: idp.uid,
    extern_uid: externUid,
    created_ts: now,
  });
});

rpc("UserService", "DeleteLinkedIdentity", "required", async (req, ctx) => {
  const parsed = parseChildName(req.name, "linkedIdentities");
  if (!parsed) throw invalidArgument(`invalid linked identity name: ${req.name}`);
  const target = await mustGetSettingTarget(ctx, parsed.username);

  const id = Number(parsed.id);
  if (!Number.isInteger(id)) throw invalidArgument(`invalid linked identity id: ${parsed.id}`);

  // 无密码用户不允许解绑最后一个身份（对齐上游保护）
  if (!target.password_hash) {
    const count = await ctx.env.DB.prepare("SELECT COUNT(*) AS c FROM user_identity WHERE user_id = ?")
      .bind(target.id)
      .first<{ c: number }>();
    if ((count?.c ?? 0) <= 1) {
      throw new ConnectError("failed_precondition", "cannot unlink the last identity of a passwordless user");
    }
  }

  const result = await ctx.env.DB.prepare("DELETE FROM user_identity WHERE id = ? AND user_id = ?")
    .bind(id, target.id)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw notFound(`linked identity not found: ${req.name}`);
  return {};
});

// ---------- Notification（inbox 表）----------

interface InboxRow {
  id: number;
  created_ts: number;
  sender_id: number;
  receiver_id: number;
  status: string;
  message: string;
  s_username: string;
  s_role: string;
  s_email: string;
  s_nickname: string;
  s_avatar_url: string;
  s_description: string;
  s_row_status: string;
  s_created_ts: number;
  s_updated_ts: number;
}

const INBOX_SELECT = `SELECT i.*, u.username AS s_username, u.role AS s_role, u.email AS s_email, u.nickname AS s_nickname,
  u.avatar_url AS s_avatar_url, u.description AS s_description, u.row_status AS s_row_status,
  u.created_ts AS s_created_ts, u.updated_ts AS s_updated_ts
  FROM inbox i JOIN user u ON u.id = i.sender_id`;

const notificationToApi = (
  receiverUsername: string,
  row: InboxRow,
  auth: AuthContext,
  snippets: Map<string, string>,
): Record<string, unknown> => {
  const message = safeParse(row.message);
  const type = message.type === "MEMO_MENTION" ? "MEMO_MENTION" : "MEMO_COMMENT";
  const payloadKey = type === "MEMO_MENTION" ? "memoMention" : "memoComment";
  const senderRow: UserRow = {
    id: row.sender_id,
    created_ts: row.s_created_ts,
    updated_ts: row.s_updated_ts,
    row_status: row.s_row_status,
    username: row.s_username,
    role: row.s_role,
    email: row.s_email,
    nickname: row.s_nickname,
    password_hash: "",
    avatar_url: row.s_avatar_url,
    description: row.s_description,
  };
  const memoName = typeof message.memo === "string" ? message.memo : "";
  const relatedMemoName = typeof message.relatedMemo === "string" ? message.relatedMemo : "";
  return {
    name: `users/${receiverUsername}/notifications/${row.id}`,
    sender: `users/${row.s_username}`,
    senderUser: userToApi(senderRow, { includeSensitive: canSeeSensitive(auth, row.s_username) }),
    status: row.status,
    createTime: toTimestamp(row.created_ts),
    type,
    [payloadKey]: {
      memo: memoName,
      relatedMemo: relatedMemoName,
      memoSnippet: snippets.get(memoName) ?? (typeof message.memoSnippet === "string" ? message.memoSnippet : ""),
      relatedMemoSnippet:
        snippets.get(relatedMemoName) ?? (typeof message.relatedMemoSnippet === "string" ? message.relatedMemoSnippet : ""),
    },
  };
};

/** 批量查 memo snippet：入参与返回均为 "memos/{uid}" 维度 */
const loadMemoSnippets = async (env: Env, memoNames: string[]): Promise<Map<string, string>> => {
  const uids = [...new Set(memoNames.filter((n) => n.startsWith("memos/")).map((n) => n.slice("memos/".length)))];
  const map = new Map<string, string>();
  if (uids.length === 0) return map;
  const rows = await env.DB.prepare(
    `SELECT uid, json_extract(payload, '$.snippet') AS snippet FROM memo WHERE uid IN (${uids.map(() => "?").join(",")})`,
  )
    .bind(...uids)
    .all<{ uid: string; snippet: string | null }>();
  for (const r of rows.results ?? []) map.set(`memos/${r.uid}`, r.snippet ?? "");
  return map;
};

rpc("UserService", "ListUserNotifications", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const username = parseName(req.parent, "users");
  if (!username) throw invalidArgument(`invalid parent: ${req.parent}`);
  if (auth.username !== username) throw permissionDenied("can only list your own notifications");

  const where: string[] = ["i.receiver_id = ?"];
  const params: unknown[] = [auth.userId];
  if (typeof req.filter === "string" && req.filter.trim()) {
    const m = req.filter.match(/status\s*==\s*["'](UNREAD|ARCHIVED)["']/);
    if (!m) throw invalidArgument(`unsupported filter: ${req.filter}`);
    where.push("i.status = ?");
    params.push(m[1]);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const { limit, offset } = resolvePage(req);
  const [rows, count] = await Promise.all([
    ctx.env.DB.prepare(`${INBOX_SELECT} ${whereSql} ORDER BY i.id DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<InboxRow>(),
    ctx.env.DB.prepare(`SELECT COUNT(*) AS c FROM inbox i ${whereSql}`)
      .bind(...params)
      .first<{ c: number }>(),
  ]);

  const results = rows.results ?? [];
  const memoNames = results.flatMap((r) => {
    const message = safeParse(r.message);
    return [message.memo, message.relatedMemo].filter((n): n is string => typeof n === "string");
  });
  const snippets = await loadMemoSnippets(ctx.env, memoNames);

  const notifications = results.map((r) => notificationToApi(username, r, auth, snippets));
  const totalSize = count?.c ?? notifications.length;
  return {
    notifications,
    nextPageToken:
      offset + notifications.length < totalSize && notifications.length === limit ? encodePageToken(limit, offset + limit) : "",
    totalSize,
  };
});

rpc("UserService", "UpdateUserNotification", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const parsed = parseChildName(req.notification?.name, "notifications");
  if (!parsed) throw invalidArgument(`invalid notification name: ${req.notification?.name}`);
  if (auth.username !== parsed.username) throw permissionDenied("can only update your own notifications");

  const id = Number(parsed.id);
  if (!Number.isInteger(id)) throw invalidArgument(`invalid notification id: ${parsed.id}`);

  const paths = normalizePaths(req);
  if (paths.length > 0 && !paths.includes("status")) throw invalidArgument("only status can be updated");
  const status = req.notification?.status;
  if (status !== "UNREAD" && status !== "ARCHIVED") throw invalidArgument(`invalid status: ${status}`);

  const result = await ctx.env.DB.prepare("UPDATE inbox SET status = ? WHERE id = ? AND receiver_id = ?")
    .bind(status, id, auth.userId)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw notFound(`notification not found: ${req.notification.name}`);

  const row = await ctx.env.DB.prepare(`${INBOX_SELECT} WHERE i.id = ?`).bind(id).first<InboxRow>();
  if (!row) throw notFound(`notification not found: ${req.notification.name}`);
  const message = safeParse(row.message);
  const memoNames = [message.memo, message.relatedMemo].filter((n): n is string => typeof n === "string");
  const snippets = await loadMemoSnippets(ctx.env, memoNames);
  return notificationToApi(parsed.username, row, auth, snippets);
});

rpc("UserService", "DeleteUserNotification", "required", async (req, ctx) => {
  const auth = requireAuth(ctx);
  const parsed = parseChildName(req.name, "notifications");
  if (!parsed) throw invalidArgument(`invalid notification name: ${req.name}`);
  if (auth.username !== parsed.username) throw permissionDenied("can only delete your own notifications");

  const id = Number(parsed.id);
  if (!Number.isInteger(id)) throw invalidArgument(`invalid notification id: ${parsed.id}`);

  const result = await ctx.env.DB.prepare("DELETE FROM inbox WHERE id = ? AND receiver_id = ?").bind(id, auth.userId).run();
  if ((result.meta.changes ?? 0) === 0) throw notFound(`notification not found: ${req.name}`);
  return {};
});
