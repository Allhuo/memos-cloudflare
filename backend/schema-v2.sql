-- ============================================================
-- memos-cloudflare v2 schema（对齐上游 Memos v0.29 数据模型）
-- 适用于 Cloudflare D1（SQLite 方言）
-- 初始化:npx wrangler d1 execute memos --remote --file schema-v2.sql
-- 与 v1 schema.sql 不兼容;迁移脚本见 docs/migrate-v1-to-v2.md（规划中）
-- ============================================================

-- ============ memos-cloudflare D1 schema (SQLite dialect) ============
PRAGMA defer_foreign_keys = ON;

-- instance settings: name ∈ GENERAL/STORAGE/MEMO_RELATED/TAGS/NOTIFICATION/AI, value = JSON
CREATE TABLE system_setting (
  name        TEXT NOT NULL,
  value       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  UNIQUE(name)
);

CREATE TABLE user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts    BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts    BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  row_status    TEXT NOT NULL CHECK (row_status IN ('NORMAL', 'ARCHIVED')) DEFAULT 'NORMAL',
  username      TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'USER',          -- 'ADMIN' | 'USER'
  email         TEXT NOT NULL DEFAULT '',
  nickname      TEXT NOT NULL DEFAULT '',              -- 对应 API displayName
  password_hash TEXT NOT NULL,                          -- bcrypt
  avatar_url    TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT ''
);

-- key ∈ GENERAL / WEBHOOKS (SHORTCUTS/REFRESH_TOKENS/PAT 已拆独立表), value = JSON
CREATE TABLE user_setting (
  user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  UNIQUE(user_id, key)
);

CREATE TABLE memo (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT NOT NULL UNIQUE,                      -- memos/{uid}
  creator_id INTEGER NOT NULL REFERENCES user(id),
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  row_status TEXT NOT NULL CHECK (row_status IN ('NORMAL', 'ARCHIVED')) DEFAULT 'NORMAL',
  content    TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'PROTECTED', 'PRIVATE')) DEFAULT 'PRIVATE',
  pinned     INTEGER NOT NULL CHECK (pinned IN (0, 1)) DEFAULT 0,
  -- payload JSON: {"tags":[...],"property":{"hasLink":..,"hasTaskList":..,"hasCode":..,"hasIncompleteTasks":..,"title":".."},"location":{...},"snippet":".."}
  payload    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_memo_creator_id ON memo(creator_id);
CREATE INDEX idx_memo_visibility ON memo(visibility);
CREATE INDEX idx_memo_created_ts ON memo(created_ts);

CREATE TABLE memo_relation (
  memo_id         INTEGER NOT NULL REFERENCES memo(id) ON DELETE CASCADE,
  related_memo_id INTEGER NOT NULL REFERENCES memo(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,                        -- 'REFERENCE' | 'COMMENT'
  UNIQUE(memo_id, related_memo_id, type)
);

CREATE TABLE attachment (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  uid          TEXT NOT NULL UNIQUE,                    -- attachments/{uid}
  creator_id   INTEGER NOT NULL REFERENCES user(id),
  created_ts   BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts   BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  filename     TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT '',                -- MIME
  size         INTEGER NOT NULL DEFAULT 0,
  memo_id      INTEGER REFERENCES memo(id) ON DELETE SET NULL,
  storage_type TEXT NOT NULL DEFAULT 'R2',              -- 'R2' | 'S3' | 'EXTERNAL'
  reference    TEXT NOT NULL DEFAULT '',                -- R2 object key 或 external URL
  payload      TEXT NOT NULL DEFAULT '{}'               -- {"motionMedia":{...},"thumbnailKey":".."}
);
CREATE INDEX idx_attachment_creator_id ON attachment(creator_id);
CREATE INDEX idx_attachment_memo_id ON attachment(memo_id);

CREATE TABLE idp (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  uid               TEXT NOT NULL UNIQUE,               -- identity-providers/{uid}
  name              TEXT NOT NULL,                      -- title
  type              TEXT NOT NULL,                      -- 'OAUTH2'
  identifier_filter TEXT NOT NULL DEFAULT '',
  config            TEXT NOT NULL DEFAULT '{}'          -- OAuth2Config JSON
);

-- 通知(API: UserNotification;上游表名 inbox)
CREATE TABLE inbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts  BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  sender_id   INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,                            -- 'UNREAD' | 'ARCHIVED'
  message     TEXT NOT NULL DEFAULT '{}'                -- {"type":"MEMO_COMMENT"|"MEMO_MENTION","memo":"memos/x","relatedMemo":"memos/y",...}
);
CREATE INDEX idx_inbox_receiver_id ON inbox(receiver_id);

CREATE TABLE reaction (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts    BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  creator_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  content_id    TEXT NOT NULL,                          -- "memos/{uid}"
  reaction_type TEXT NOT NULL,
  UNIQUE(creator_id, content_id, reaction_type)
);

CREATE TABLE memo_share (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT NOT NULL UNIQUE,                      -- share token
  memo_id    INTEGER NOT NULL REFERENCES memo(id) ON DELETE CASCADE,
  creator_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  expires_ts BIGINT DEFAULT NULL
);
CREATE INDEX idx_memo_share_memo_id ON memo_share(memo_id);

CREATE TABLE user_identity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,                             -- idp.uid
  extern_uid TEXT NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE (provider, extern_uid),
  UNIQUE (user_id, provider)
);
CREATE INDEX idx_user_identity_user_id ON user_identity(user_id);

-- ==== 以下两表替代上游 user_setting 里的 REFRESH_TOKENS / PERSONAL_ACCESS_TOKENS JSON ====

CREATE TABLE refresh_token (
  token_id    TEXT PRIMARY KEY,                         -- JWT 的 tid (uuid)
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_ts  BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  expires_ts  BIGINT NOT NULL,
  rotated_ts  BIGINT DEFAULT NULL,                      -- 被轮换时间;非 NULL 且超过宽限期(60s)后拒绝
  client_info TEXT NOT NULL DEFAULT '{}'                -- {"userAgent":"","ipAddress":"","deviceType":"","os":"","browser":""}
);
CREATE INDEX idx_refresh_token_user_id ON refresh_token(user_id);

CREATE TABLE personal_access_token (
  uid          TEXT PRIMARY KEY,                        -- users/{u}/personalAccessTokens/{uid}
  user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,                    -- SHA-256(memos_pat_xxx)
  description  TEXT NOT NULL DEFAULT '',
  created_ts   BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  expires_ts   BIGINT DEFAULT NULL,                     -- NULL = 永不过期
  last_used_ts BIGINT DEFAULT NULL
);
CREATE INDEX idx_pat_user_id ON personal_access_token(user_id);

-- shortcut(上游存 user_setting JSON,D1 拆表)
CREATE TABLE shortcut (
  uid        TEXT PRIMARY KEY,                          -- users/{u}/shortcuts/{uid}
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  filter     TEXT NOT NULL DEFAULT '',
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX idx_shortcut_user_id ON shortcut(user_id);

-- 默认管理员 admin / 123456（PBKDF2-SHA256; 首次登录后请立即修改密码）
-- 格式: pbkdf2$<iterations>$<salt_b64>$<hash_b64>，由后端 v2/password.ts 生成与校验
INSERT INTO user (username, role, nickname, password_hash)
VALUES ('admin', 'ADMIN', 'Administrator', 'pbkdf2$100000$UMwJUlX+C0KYrCbG1r8H6A==$SP5js+HSEHyvYH30GMBZIygmbqktKmorLJtdztfX72Y=');
