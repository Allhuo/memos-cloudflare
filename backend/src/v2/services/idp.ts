// IdentityProviderService — SSO 身份提供方 CRUD(idp 表,config 存 OAuth2Config JSON)。
// 对齐 memos v0.29 proto/api/v1/idp_service.proto(规格书 §2.9)。
// - ListIdentityProviders 公开(登录页需要);非 ADMIN(含匿名)时 clientSecret 脱敏置空。
// - Create/Update/Delete 仅 ADMIN;Update 时 clientSecret 传空保留旧值。
// GetIdentityProvider 前端未调用,不注册。

import type { Env } from "../../types";
import { invalidArgument, notFound, permissionDenied } from "../connect";
import { rpc } from "../router";
import { newUid, parseName, safeParse } from "../store";

interface IdpRow {
  id: number;
  uid: string;
  name: string; // title
  type: string; // 'OAUTH2'
  identifier_filter: string;
  config: string; // OAuth2Config JSON
}

/** config 列存 OAuth2Config 本体;API 形态为 config: { oauth2Config: {...} }。 */
const idpToApi = (row: IdpRow, opts: { maskSecret: boolean }): Record<string, unknown> => {
  const oauth2Config = safeParse(row.config);
  if (opts.maskSecret) oauth2Config.clientSecret = "";
  return {
    name: `identity-providers/${row.uid}`,
    type: row.type || "OAUTH2",
    title: row.name,
    identifierFilter: row.identifier_filter,
    config: { oauth2Config },
  };
};

const requireAdmin = (auth: { role: string } | null): void => {
  if (auth?.role !== "ADMIN") throw permissionDenied("only admin can manage identity providers");
};

const getIdpByName = async (env: Env, name: string): Promise<IdpRow> => {
  const uid = parseName(name, "identity-providers");
  if (!uid) throw invalidArgument(`invalid identity provider name: ${name}`);
  const row = await env.DB.prepare("SELECT * FROM idp WHERE uid = ?").bind(uid).first<IdpRow>();
  if (!row) throw notFound(`identity provider ${name} not found`);
  return row;
};

rpc("IdentityProviderService", "ListIdentityProviders", "optional", async (_request, ctx) => {
  const rows = await ctx.env.DB.prepare("SELECT * FROM idp ORDER BY id").all<IdpRow>();
  const maskSecret = ctx.auth?.role !== "ADMIN";
  return { identityProviders: (rows.results ?? []).map((row) => idpToApi(row, { maskSecret })) };
});

rpc("IdentityProviderService", "CreateIdentityProvider", "required", async (request, ctx) => {
  requireAdmin(ctx.auth);
  const idp = request.identityProvider;
  if (!idp || typeof idp !== "object") throw invalidArgument("identityProvider is required");
  const title: string = idp.title || "";
  if (!title) throw invalidArgument("title is required");
  const type: string = idp.type || "OAUTH2";
  const identifierFilter: string = idp.identifierFilter || "";
  const oauth2Config = idp.config?.oauth2Config ?? {};

  const uid = newUid();
  await ctx.env.DB.prepare("INSERT INTO idp (uid, name, type, identifier_filter, config) VALUES (?, ?, ?, ?, ?)")
    .bind(uid, title, type, identifierFilter, JSON.stringify(oauth2Config))
    .run();
  return idpToApi(
    { id: 0, uid, name: title, type, identifier_filter: identifierFilter, config: JSON.stringify(oauth2Config) },
    { maskSecret: false },
  );
});

rpc("IdentityProviderService", "UpdateIdentityProvider", "required", async (request, ctx) => {
  requireAdmin(ctx.auth);
  const idp = request.identityProvider;
  if (!idp?.name) throw invalidArgument("identityProvider.name is required");
  const row = await getIdpByName(ctx.env, idp.name);

  // updateMask 为 top-level 字段;缺省时全部可更新字段生效
  const paths: string[] = request.updateMask?.paths?.length
    ? request.updateMask.paths
    : ["title", "identifier_filter", "config"];

  let title = row.name;
  let identifierFilter = row.identifier_filter;
  let oauth2Config = safeParse(row.config);
  for (const path of paths) {
    if (path === "title") {
      title = idp.title ?? "";
    } else if (path === "identifier_filter" || path === "identifierFilter") {
      identifierFilter = idp.identifierFilter ?? "";
    } else if (path === "config") {
      const incoming = { ...(idp.config?.oauth2Config ?? {}) };
      // clientSecret 传空 → 保留旧值(前端编辑表单不回显 secret)
      if (!incoming.clientSecret) incoming.clientSecret = oauth2Config.clientSecret ?? "";
      oauth2Config = incoming;
    }
  }
  if (!title) throw invalidArgument("title is required");

  const configJson = JSON.stringify(oauth2Config);
  await ctx.env.DB.prepare("UPDATE idp SET name = ?, identifier_filter = ?, config = ? WHERE uid = ?")
    .bind(title, identifierFilter, configJson, row.uid)
    .run();
  return idpToApi(
    { ...row, name: title, identifier_filter: identifierFilter, config: configJson },
    { maskSecret: false },
  );
});

rpc("IdentityProviderService", "DeleteIdentityProvider", "required", async (request, ctx) => {
  requireAdmin(ctx.auth);
  if (!request.name) throw invalidArgument("name is required");
  const row = await getIdpByName(ctx.env, request.name);
  await ctx.env.DB.prepare("DELETE FROM idp WHERE uid = ?").bind(row.uid).run();
  return {};
});
