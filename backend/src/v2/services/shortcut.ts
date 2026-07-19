// ShortcutService — 用户快捷过滤器 CRUD(独立 shortcut 表,上游存 user_setting JSON)。
// 对齐 memos v0.29 proto/api/v1/shortcut_service.proto(规格书 §2.8 / §4.4)。
// 所有方法仅限本人(parent/name 中的 username 必须等于当前用户)。
// GetShortcut 前端未调用,不注册。

import type { Env } from "../../types";
import { rpc } from "../router";
import { invalidArgument, notFound, permissionDenied } from "../connect";
import { newUid, parseChildName, parseName } from "../store";

interface ShortcutRow {
  uid: string;
  user_id: number;
  title: string;
  filter: string;
  created_ts: number;
}

const shortcutToApi = (row: ShortcutRow, username: string): Record<string, unknown> => ({
  name: `users/${username}/shortcuts/${row.uid}`,
  title: row.title,
  filter: row.filter,
});

/** 校验 parent = "users/{username}" 且为本人,返回 username。 */
const requireOwnParent = (parent: string, auth: { username: string }): string => {
  const username = parseName(parent, "users");
  if (!username) throw invalidArgument(`invalid parent: ${parent}`);
  if (username !== auth.username) throw permissionDenied("cannot access another user's shortcuts");
  return username;
};

/** 校验 name = "users/{username}/shortcuts/{uid}" 且为本人,返回本人名下的行。 */
const requireOwnShortcut = async (env: Env, name: string, auth: { userId: number; username: string }): Promise<ShortcutRow> => {
  const parsed = parseChildName(name, "shortcuts");
  if (!parsed) throw invalidArgument(`invalid shortcut name: ${name}`);
  if (parsed.username !== auth.username) throw permissionDenied("cannot access another user's shortcuts");
  const row = await env.DB.prepare("SELECT * FROM shortcut WHERE uid = ? AND user_id = ?")
    .bind(parsed.id, auth.userId)
    .first<ShortcutRow>();
  if (!row) throw notFound(`shortcut ${name} not found`);
  return row;
};

rpc("ShortcutService", "ListShortcuts", "required", async (request, ctx) => {
  const auth = ctx.auth!;
  const username = requireOwnParent(request.parent || "", auth);
  const rows = await ctx.env.DB.prepare("SELECT * FROM shortcut WHERE user_id = ? ORDER BY created_ts DESC, uid")
    .bind(auth.userId)
    .all<ShortcutRow>();
  return { shortcuts: (rows.results ?? []).map((row) => shortcutToApi(row, username)) };
});

rpc("ShortcutService", "CreateShortcut", "required", async (request, ctx) => {
  const auth = ctx.auth!;
  const username = requireOwnParent(request.parent || "", auth);
  const shortcut = request.shortcut;
  if (!shortcut || typeof shortcut !== "object") throw invalidArgument("shortcut is required");
  const title: string = shortcut.title || "";
  if (!title) throw invalidArgument("title is required");
  const filter: string = shortcut.filter || "";

  const uid = newUid();
  const now = Math.floor(Date.now() / 1000);
  await ctx.env.DB.prepare("INSERT INTO shortcut (uid, user_id, title, filter, created_ts) VALUES (?, ?, ?, ?, ?)")
    .bind(uid, auth.userId, title, filter, now)
    .run();
  return shortcutToApi({ uid, user_id: auth.userId, title, filter, created_ts: now }, username);
});

rpc("ShortcutService", "UpdateShortcut", "required", async (request, ctx) => {
  const auth = ctx.auth!;
  const shortcut = request.shortcut;
  if (!shortcut?.name) throw invalidArgument("shortcut.name is required");
  const row = await requireOwnShortcut(ctx.env, shortcut.name, auth);

  // updateMask 缺省时 title/filter 都更新(规格书 §2.8)
  const paths: string[] = request.updateMask?.paths?.length ? request.updateMask.paths : ["title", "filter"];
  let title = row.title;
  let filter = row.filter;
  for (const path of paths) {
    if (path === "title") title = shortcut.title ?? "";
    else if (path === "filter") filter = shortcut.filter ?? "";
  }
  if (!title) throw invalidArgument("title is required");

  await ctx.env.DB.prepare("UPDATE shortcut SET title = ?, filter = ? WHERE uid = ? AND user_id = ?")
    .bind(title, filter, row.uid, auth.userId)
    .run();
  return shortcutToApi({ ...row, title, filter }, auth.username);
});

rpc("ShortcutService", "DeleteShortcut", "required", async (request, ctx) => {
  const auth = ctx.auth!;
  if (!request.name) throw invalidArgument("name is required");
  const row = await requireOwnShortcut(ctx.env, request.name, auth);
  await ctx.env.DB.prepare("DELETE FROM shortcut WHERE uid = ? AND user_id = ?").bind(row.uid, auth.userId).run();
  return {};
});
