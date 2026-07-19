// AuthService — 对齐上游 memos v0.29 auth_service.go 语义(见规格书 §2.4 / §3)。
// SignIn / SignOut / RefreshToken / GetCurrentUser。
import type { Env } from "../../types";
import { rpc } from "../router";
import { ConnectError, invalidArgument, notFound, permissionDenied, toTimestamp, unauthenticated } from "../connect";
import {
  buildClearRefreshCookie,
  buildRefreshCookie,
  createSession,
  extractRefreshToken,
  generateAccessToken,
  revokeSessionByToken,
  rotateSession,
} from "../auth";
import { hashPassword, verifyPassword } from "../password";
import { getUserById, getUserByUsername, parseName, safeParse, userToApi, type UserRow } from "../store";

// ---------- helpers ----------

const loadGeneralSetting = async (env: Env): Promise<Record<string, any>> => {
  const row = await env.DB.prepare("SELECT value FROM system_setting WHERE name = 'GENERAL'").first<{ value: string }>();
  return row ? safeParse(row.value) : {};
};

/** 建会话 + 下发 refresh cookie + 生成 access token,返回 SignIn 响应体 */
const startSession = async (
  env: Env,
  user: UserRow,
  req: Request,
  responseHeaders: Headers,
): Promise<Record<string, unknown>> => {
  const session = await createSession(env, user.id, req);
  responseHeaders.append("Set-Cookie", buildRefreshCookie(session.token, session.expiresAt));
  const access = await generateAccessToken(user, env.JWT_SECRET);
  return {
    user: userToApi(user, { includeSensitive: true }),
    accessToken: access.token,
    accessTokenExpiresAt: toTimestamp(access.expiresAt),
  };
};

// ---------- SignIn ----------

interface PasswordCredentials {
  username?: string;
  password?: string;
}

interface SsoCredentials {
  idpName?: string;
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
}

const signInWithPassword = async (
  credentials: PasswordCredentials,
  ctx: { env: Env; req: Request; responseHeaders: Headers },
): Promise<Record<string, unknown>> => {
  const { username, password } = credentials;
  // 失败统一文案,防用户名枚举
  const failed = () => invalidArgument("unmatched username and password");
  if (!username || !password) throw failed();

  const user = await getUserByUsername(ctx.env, username);
  if (!user) throw failed();
  const { valid, needsRehash } = await verifyPassword(password, user.password_hash);
  if (!valid) throw failed();

  const general = await loadGeneralSetting(ctx.env);
  if (general.disallowPasswordAuth === true && user.role === "USER") {
    throw permissionDenied("password auth is not allowed");
  }
  if (user.row_status === "ARCHIVED") {
    throw permissionDenied(`user has been archived with username ${user.username}`);
  }

  // 透明升级 legacy 哈希
  if (needsRehash) {
    const newHash = await hashPassword(password);
    await ctx.env.DB.prepare("UPDATE user SET password_hash = ? WHERE id = ?").bind(newHash, user.id).run();
  }

  return startSession(ctx.env, user, ctx.req, ctx.responseHeaders);
};

interface IdpRow {
  id: number;
  uid: string;
  name: string;
  type: string;
  identifier_filter: string;
  config: string;
}

const signInWithSso = async (
  credentials: SsoCredentials,
  ctx: { env: Env; req: Request; responseHeaders: Headers },
): Promise<Record<string, unknown>> => {
  const { idpName, code, redirectUri, codeVerifier } = credentials;
  if (!idpName || !code) throw invalidArgument("missing sso credentials");

  // idpName 可能是资源名 identity-providers/{uid},也可能是 idp 标题
  const uid = parseName(idpName, "identity-providers");
  const idp = await ctx.env.DB.prepare("SELECT * FROM idp WHERE uid = ? OR name = ? LIMIT 1")
    .bind(uid ?? idpName, idpName)
    .first<IdpRow>();
  if (!idp) throw notFound(`identity provider not found: ${idpName}`);

  const config = safeParse(idp.config);
  const oauth2 = (config.oauth2Config ?? config) as Record<string, any>;
  if (!oauth2.tokenUrl || !oauth2.userInfoUrl) throw invalidArgument("identity provider is misconfigured");

  // 1) 授权码换 access token
  const form = new URLSearchParams({
    client_id: oauth2.clientId ?? "",
    client_secret: oauth2.clientSecret ?? "",
    code,
    redirect_uri: redirectUri ?? "",
    grant_type: "authorization_code",
  });
  if (codeVerifier) form.set("code_verifier", codeVerifier);

  const tokenResp = await fetch(oauth2.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  if (!tokenResp.ok) throw invalidArgument("failed to exchange authorization code");
  const tokenBody = (await tokenResp.json().catch(() => null)) as Record<string, any> | null;
  const oauthAccessToken = tokenBody?.access_token;
  if (!oauthAccessToken || typeof oauthAccessToken !== "string") {
    throw invalidArgument("failed to exchange authorization code");
  }

  // 2) 拉取用户信息
  const userInfoResp = await fetch(oauth2.userInfoUrl, {
    headers: { Authorization: `Bearer ${oauthAccessToken}`, Accept: "application/json" },
  });
  if (!userInfoResp.ok) throw invalidArgument("failed to fetch user info");
  const userInfo = (await userInfoResp.json().catch(() => null)) as Record<string, any> | null;
  if (!userInfo) throw invalidArgument("failed to fetch user info");

  // 3) 按 fieldMapping 取 identifier
  const identifierKey: string = oauth2.fieldMapping?.identifier || "sub";
  const identifier = userInfo[identifierKey];
  if (identifier == null || identifier === "") throw invalidArgument("missing identifier in user info");

  // 4) 查已绑定身份
  const identity = await ctx.env.DB.prepare("SELECT user_id FROM user_identity WHERE provider = ? AND extern_uid = ?")
    .bind(idp.uid, String(identifier))
    .first<{ user_id: number }>();
  if (!identity) throw notFound("identity not linked");

  const user = await getUserById(ctx.env, identity.user_id);
  if (!user) throw notFound("identity not linked");
  if (user.row_status === "ARCHIVED") {
    throw permissionDenied(`user has been archived with username ${user.username}`);
  }

  return startSession(ctx.env, user, ctx.req, ctx.responseHeaders);
};

rpc("AuthService", "SignIn", "optional", async (request, ctx) => {
  if (request?.passwordCredentials) return signInWithPassword(request.passwordCredentials, ctx);
  if (request?.ssoCredentials) return signInWithSso(request.ssoCredentials, ctx);
  throw invalidArgument("missing credentials");
});

// ---------- SignOut ----------

rpc("AuthService", "SignOut", "optional", async (_request, ctx) => {
  const refreshToken = extractRefreshToken(ctx.req);
  if (refreshToken) {
    try {
      await revokeSessionByToken(ctx.env, refreshToken);
    } catch {
      // 撤销失败不阻断登出
    }
  }
  ctx.responseHeaders.append("Set-Cookie", buildClearRefreshCookie());
  return {};
});

// ---------- RefreshToken ----------

rpc("AuthService", "RefreshToken", "optional", async (_request, ctx) => {
  const refreshToken = extractRefreshToken(ctx.req);
  if (!refreshToken) throw unauthenticated("refresh token not found");

  const rotated = await rotateSession(ctx.env, refreshToken, ctx.req);
  if (!rotated) throw unauthenticated("invalid refresh token");

  const user = await getUserById(ctx.env, rotated.userId);
  if (!user || user.row_status !== "NORMAL") {
    ctx.responseHeaders.append("Set-Cookie", buildClearRefreshCookie());
    throw unauthenticated("user not found");
  }

  ctx.responseHeaders.append("Set-Cookie", buildRefreshCookie(rotated.token, rotated.expiresAt));
  const access = await generateAccessToken(user, ctx.env.JWT_SECRET);
  // 注意:此处字段名是 expiresAt(SignIn 响应里是 accessTokenExpiresAt)
  return { accessToken: access.token, expiresAt: toTimestamp(access.expiresAt) };
});

// ---------- GetCurrentUser ----------

rpc("AuthService", "GetCurrentUser", "required", async (_request, ctx) => {
  const auth = ctx.auth;
  if (!auth) throw unauthenticated();
  const user = await getUserById(ctx.env, auth.userId);
  if (!user || user.row_status === "ARCHIVED") {
    ctx.responseHeaders.append("Set-Cookie", buildClearRefreshCookie());
    throw new ConnectError("unauthenticated", "user not found");
  }
  return { user: userToApi(user, { includeSensitive: true }) };
});
