// 密码哈希：PBKDF2-SHA256（WebCrypto 原生，适配 Workers CPU 限制）。
// 上游用 bcrypt，但纯 JS bcrypt 在 Workers 免费版 10ms CPU 配额下不可行；
// 哈希算法是服务端实现细节，不影响 API 兼容性。
// 存储格式: pbkdf2$<iterations>$<salt_b64>$<hash_b64>
// 兼容迁移：v1 的 64 位 hex（无盐 SHA-256）仍可校验，登录成功后调用方应触发 rehash。

const ITERATIONS = 100_000;

const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

const pbkdf2 = async (password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as ArrayBuffer, iterations },
    key,
    256,
  );
};

export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(derived)}`;
};

const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

/** 校验密码。返回 { valid, needsRehash }：legacy SHA-256 命中时 needsRehash=true */
export const verifyPassword = async (password: string, stored: string): Promise<{ valid: boolean; needsRehash: boolean }> => {
  if (stored.startsWith("pbkdf2$")) {
    const [, iterStr, saltB64, hashB64] = stored.split("$");
    const derived = await pbkdf2(password, fromB64(saltB64), Number(iterStr));
    return { valid: timingSafeEqual(new Uint8Array(derived), fromB64(hashB64)), needsRehash: false };
  }
  // v1 遗留：无盐 SHA-256 hex
  if (/^[0-9a-f]{64}$/.test(stored)) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return { valid: hex === stored, needsRehash: hex === stored };
  }
  return { valid: false, needsRehash: false };
};
