# v1 → v2 数据迁移指南（草案）

v2（`feat/upstream-v0.29` 分支）对齐上游 Memos v0.29 数据模型，与 v1 schema 不兼容。
本文档描述从 v1（`schema.sql`）迁移到 v2（`schema-v2.sql`）的步骤。

> ⚠️ 迁移前务必备份：`npx wrangler d1 export memos --remote --output backup.sql`

## 差异总览

| | v1 | v2 |
|---|---|---|
| 用户角色 | `HOST` / `USER` | `ADMIN` / `USER`（上游 v0.26 重命名） |
| 密码哈希 | 无盐 SHA-256 | PBKDF2-SHA256（登录时自动从旧格式升级） |
| 会话 | 无状态 JWT | refresh_token 表（可吊销、轮换） |
| 用户昵称列 | `nickname` | `nickname`（映射 API `displayName`） |
| memo 标签 | `tag` / `memo_tag` 表 | `memo.payload` JSON（`$.tags`） |
| 附件 | `resource` 表 | `attachment` 表（blob 强制 R2） |
| 快捷方式/通知/分享 | 无 | `shortcut` / `inbox` / `memo_share` 表 |

## 迁移步骤（手工 SQL 版）

1. 新建 v2 数据库（推荐新库,保留旧库回滚）：
   ```bash
   npx wrangler d1 create memos-v2
   npx wrangler d1 execute memos-v2 --remote --file schema-v2.sql
   ```
2. 导出 v1 数据并转换。核心映射：
   ```sql
   -- user：HOST → ADMIN；password_hash 保留（v2 后端兼容旧 SHA-256，首次登录自动升级）
   INSERT INTO user (id, created_ts, updated_ts, row_status, username, role, email, nickname, password_hash, avatar_url)
   SELECT id, created_ts, updated_ts, row_status, username,
          CASE role WHEN 'HOST' THEN 'ADMIN' ELSE 'USER' END,
          COALESCE(email, ''), COALESCE(nickname, ''), password_hash, COALESCE(avatar_url, '')
   FROM v1.user;

   -- memo：tags 需要重算进 payload。v2 后端提供了 computePayload；
   -- 简化做法：payload 先置 '{}'，之后用维护脚本批量重算（TODO: scripts/recompute-payload）
   INSERT INTO memo (id, uid, creator_id, created_ts, updated_ts, row_status, content, visibility, pinned, payload)
   SELECT id, uid, creator_id, created_ts, updated_ts, row_status, content, visibility,
          COALESCE(pinned, 0), '{}'
   FROM v1.memo;
   ```
3. 附件：v1 `resource` 表若有 D1 内嵌 blob，需要导出后上传 R2，再写入 `attachment.reference`。
4. 切换 `wrangler.toml` 的 d1 binding 到新库,部署 v2 Worker 与 v0.29 前端。

## TODO

- [ ] 提供自动迁移脚本（`scripts/migrate-v1-to-v2.ts`，wrangler d1 export → 转换 → import）
- [ ] payload 批量重算脚本
- [ ] 迁移演练记录

欢迎贡献——这是一个独立性很好的 good first issue。
