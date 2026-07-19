import type { Env } from "../types";

// 与上游 memos v0.29 对齐的认证实现（server/auth/token.go、auth_service.go）：
// - Access token: JWT HS256，15 分钟，aud="user.access-token"，claims 含 type/role/status/username
// - Refresh token: JWT HS256，30 天，aud="user.refresh-token"，claims 含 tid，
//   经 HttpOnly cookie "memos_refresh" 传输，对照 D1 refresh_token 表校验（可吊销）
// - 轮换：先插新、后标记旧（rotated_ts），旧 token 有 60s 宽限期以容忍多标签页并发刷新
// - PAT: "memos_pat_" 前缀，存 SHA-256，同走 Authorization: Bearer
// 注意：Pages 前端与 Worker 后端跨站部署时，cookie 必须 SameSite=None; Secure。

export const ACCESS_TOKEN_DURATION_SEC = 15 * 60;
export const REFRESH_TOKEN_DURATION_SEC = 30 * 24 * 60 * 60;
export const REFRESH_TOKEN_COOKIE = "memos_refresh";
export const PAT_PREFIX = "memos_pat_";
const ROTATION_GRACE_SEC = 60;
const ISSUER = "memos";
const ACCESS_AUDIENCE = "user.access-token";
const REFRESH_AUDIENCE = "user.refresh-token";

export interface AuthContext {
  userId: number;
  username: string;
  role: string;
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

export interface AccessTokenUser {
  id: number;
  username: string;
  role: string;
  row_status: string;
}

export const generateAccessToken = async (user: AccessTokenUser, secret: string) => {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ACCESS_TOKEN_DURATION_SEC;
  const token = await signJwt(
    {
      type: "access",
      role: user.role,
      status: user.row_status,
      username: user.username,
      name: user.username,
      iss: ISSUER,
      aud: [ACCESS_AUDIENCE],
      sub: String(user.id),
      iat: now,
      exp: expiresAt,
    },
    secret,
  );
  return { token, expiresAt };
};

const generateRefreshToken = async (userId: number, tokenId: string, secret: string) => {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + REFRESH_TOKEN_DURATION_SEC;
  const token = await signJwt(
    { type: "refresh", tid: tokenId, iss: ISSUER, aud: [REFRESH_AUDIENCE], sub: String(userId), iat: now, exp: expiresAt },
    secret,
  );
  return { token, expiresAt };
};

// ---------- 会话存储（refresh_token 表）----------

const clientInfoOf = (req: Request): string =>
  JSON.stringify({ userAgent: req.headers.get("User-Agent") || "", ipAddress: req.headers.get("CF-Connecting-IP") || "" });

export const createSession = async (env: Env, userId: number, req: Request) => {
  const tokenId = crypto.randomUUID();
  const { token, expiresAt } = await generateRefreshToken(userId, tokenId, env.JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO refresh_token (token_id, user_id, created_ts, expires_ts, client_info) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(tokenId, userId, now, expiresAt, clientInfoOf(req))
    .run();
  return { token, expiresAt };
};

/** 校验并轮换 refresh token。旧 token 标记 rotated_ts，宽限期内仍可复用（多标签页并发）。 */
export const rotateSession = async (
  env: Env,
  refreshToken: string,
  req: Request,
): Promise<{ userId: number; token: string; expiresAt: number } | null> => {
  const claims = await verifyJwt(refreshToken, env.JWT_SECRET);
  if (!claims || claims.type !== "refresh" || !claims.tid) return null;
  const aud: string[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(REFRESH_AUDIENCE) || claims.iss !== ISSUER) return null;

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT user_id, expires_ts, rotated_ts FROM refresh_token WHERE token_id = ?")
    .bind(claims.tid)
    .first<{ user_id: number; expires_ts: number; rotated_ts: number | null }>();
  if (!row || row.expires_ts < now) return null;
  if (row.rotated_ts != null && now - row.rotated_ts > ROTATION_GRACE_SEC) return null;

  const newTokenId = crypto.randomUUID();
  const { token, expiresAt } = await generateRefreshToken(row.user_id, newTokenId, env.JWT_SECRET);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO refresh_token (token_id, user_id, created_ts, expires_ts, client_info) VALUES (?, ?, ?, ?, ?)",
    ).bind(newTokenId, row.user_id, now, expiresAt, clientInfoOf(req)),
    env.DB.prepare("UPDATE refresh_token SET rotated_ts = ? WHERE token_id = ? AND rotated_ts IS NULL").bind(now, claims.tid),
    // 顺带清理该用户已过期/过宽限期的旧记录
    env.DB.prepare("DELETE FROM refresh_token WHERE user_id = ? AND (expires_ts < ? OR (rotated_ts IS NOT NULL AND rotated_ts < ?))")
      .bind(row.user_id, now, now - ROTATION_GRACE_SEC),
  ]);
  return { userId: row.user_id, token, expiresAt };
};

export const revokeSessionByToken = async (env: Env, refreshToken: string): Promise<void> => {
  const claims = await verifyJwt(refreshToken, env.JWT_SECRET);
  if (claims?.tid) {
    await env.DB.prepare("DELETE FROM refresh_token WHERE token_id = ?").bind(claims.tid).run();
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

// ---------- 请求鉴权（access JWT 或 PAT）----------

const sha256hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

export const authenticate = async (req: Request, env: Env): Promise<AuthContext | null> => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);

  if (token.startsWith(PAT_PREFIX)) {
    const hash = await sha256hex(token);
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      `SELECT p.uid, u.id, u.username, u.role, p.expires_ts FROM personal_access_token p
       JOIN user u ON u.id = p.user_id AND u.row_status = 'NORMAL'
       WHERE p.token_hash = ?`,
    )
      .bind(hash)
      .first<{ uid: string; id: number; username: string; role: string; expires_ts: number | null }>();
    if (!row || (row.expires_ts != null && row.expires_ts < now)) return null;
    await env.DB.prepare("UPDATE personal_access_token SET last_used_ts = ? WHERE uid = ?").bind(now, row.uid).run();
    return { userId: row.id, username: row.username, role: row.role };
  }

  const claims = await verifyJwt(token, env.JWT_SECRET);
  if (!claims || !claims.sub) return null;
  const aud: string[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(ACCESS_AUDIENCE)) return null;
  return { userId: Number(claims.sub), username: claims.username || claims.name || "", role: claims.role || "USER" };
};

export const generatePatToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const rand = btoa(bin).replace(/\+/g, "A").replace(/\//g, "B").replace(/=+$/, "").slice(0, 32);
  return `${PAT_PREFIX}${rand}`;
};

export { sha256hex };
