import type { Env } from "../types";

// 与上游 memos v0.29 对齐的认证实现（server/auth/token.go）：
// - Access token: JWT HS256，15 分钟，aud = "user.access-token"
// - Refresh token: JWT HS256，30 天，aud = "user.refresh-token"，claims 含 tid，
//   经 HttpOnly cookie "memos_refresh" 传输，并对照 D1 的 user_session 表校验（可吊销）
// 注意：Pages 前端与 Worker 后端跨站部署时，cookie 必须 SameSite=None; Secure。

export const ACCESS_TOKEN_DURATION_SEC = 15 * 60;
export const REFRESH_TOKEN_DURATION_SEC = 30 * 24 * 60 * 60;
export const REFRESH_TOKEN_COOKIE = "memos_refresh";
const ISSUER = "memos";
const ACCESS_AUDIENCE = "user.access-token";
const REFRESH_AUDIENCE = "user.refresh-token";

export interface AuthContext {
  userId: number;
  username: string;
}

// ---------- JWT (HS256, WebCrypto) ----------

const b64url = (data: ArrayBuffer | Uint8Array | string): string => {
  let bytes: Uint8Array;
  if (typeof data === "string") bytes = new TextEncoder().encode(data);
  else bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (s: string): Uint8Array => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};

const hmacKey = async (secret: string) =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

const signJwt = async (claims: Record<string, unknown>, secret: string): Promise<string> => {
  const header = { alg: "HS256", kid: "v1", typ: "JWT" };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
};

const verifyJwt = async (token: string, secret: string): Promise<Record<string, any> | null> => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    b64urlDecode(parts[2]) as unknown as ArrayBuffer,
    new TextEncoder().encode(data),
  );
  if (!valid) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
};

// ---------- Token 生成 ----------

export const generateAccessToken = async (username: string, userId: number, secret: string) => {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ACCESS_TOKEN_DURATION_SEC;
  const token = await signJwt(
    { name: username, iss: ISSUER, aud: [ACCESS_AUDIENCE], sub: String(userId), iat: now, exp: expiresAt },
    secret,
  );
  return { token, expiresAt };
};

export const generateRefreshToken = async (userId: number, tokenId: string, secret: string) => {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + REFRESH_TOKEN_DURATION_SEC;
  const token = await signJwt(
    { type: "refresh", tid: tokenId, iss: ISSUER, aud: [REFRESH_AUDIENCE], sub: String(userId), iat: now, exp: expiresAt },
    secret,
  );
  return { token, expiresAt };
};

// ---------- 会话存储（D1）----------

export const createSession = async (env: Env, userId: number): Promise<{ token: string; expiresAt: number }> => {
  const tokenId = crypto.randomUUID();
  const { token, expiresAt } = await generateRefreshToken(userId, tokenId, env.JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO user_session (token_id, user_id, created_ts, expires_ts, last_accessed_ts) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(tokenId, userId, now, expiresAt, now)
    .run();
  return { token, expiresAt };
};

/** 校验 refresh token 并轮换会话；返回新 refresh token（轮换）与用户 id */
export const rotateSession = async (
  env: Env,
  refreshToken: string,
): Promise<{ userId: number; token: string; expiresAt: number } | null> => {
  const claims = await verifyJwt(refreshToken, env.JWT_SECRET);
  if (!claims || claims.type !== "refresh" || !claims.tid) return null;
  const row = await env.DB.prepare("SELECT user_id, expires_ts FROM user_session WHERE token_id = ?")
    .bind(claims.tid)
    .first<{ user_id: number; expires_ts: number }>();
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.expires_ts < now) return null;

  // 轮换：换新 token_id、滑动过期窗口
  const newTokenId = crypto.randomUUID();
  const { token, expiresAt } = await generateRefreshToken(row.user_id, newTokenId, env.JWT_SECRET);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_session WHERE token_id = ?").bind(claims.tid),
    env.DB.prepare(
      "INSERT INTO user_session (token_id, user_id, created_ts, expires_ts, last_accessed_ts) VALUES (?, ?, ?, ?, ?)",
    ).bind(newTokenId, row.user_id, now, expiresAt, now),
  ]);
  return { userId: row.user_id, token, expiresAt };
};

export const revokeSessionByToken = async (env: Env, refreshToken: string): Promise<void> => {
  const claims = await verifyJwt(refreshToken, env.JWT_SECRET);
  if (claims?.tid) {
    await env.DB.prepare("DELETE FROM user_session WHERE token_id = ?").bind(claims.tid).run();
  }
};

// ---------- Cookie ----------

export const buildRefreshCookie = (token: string, expiresAtSec: number): string => {
  const expires = new Date(expiresAtSec * 1000).toUTCString();
  // 跨站部署（Pages ↔ Worker 不同域）必须 SameSite=None; Secure
  return `${REFRESH_TOKEN_COOKIE}=${token}; Path=/; Expires=${expires}; HttpOnly; Secure; SameSite=None`;
};

export const buildClearRefreshCookie = (): string =>
  `${REFRESH_TOKEN_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=None`;

export const extractRefreshToken = (req: Request): string | null => {
  const cookie = req.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${REFRESH_TOKEN_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
};

// ---------- 请求鉴权 ----------

export const authenticate = async (req: Request, env: Env): Promise<AuthContext | null> => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  const claims = await verifyJwt(token, env.JWT_SECRET);
  if (!claims || !claims.sub) return null;
  const aud: string[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(ACCESS_AUDIENCE)) return null;
  return { userId: Number(claims.sub), username: claims.name || "" };
};
