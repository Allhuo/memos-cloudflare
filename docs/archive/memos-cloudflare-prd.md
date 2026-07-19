# 产品需求文档（PRD）

**项目名称：** 将 *Memos* 全量移植至 Cloudflare Workers + D1 + R2  
**版本：** v0.2 - 2025-06-10  
**作者：** MR.MIN（由 ChatGPT 起草）

---

## 1. 目标与范围
1. **云化迁移**：把开源笔记项目 [Memos](https://github.com/usememos/memos) 的后端/数据库/附件存储全部迁移到 Cloudflare 边缘。
2. **API 100% 兼容**：所有 `/api/**` 端点的路径、请求参数、响应字段保持与上游 v0.24.x 完全一致。
3. **最小改动**：前端直接使用官方 `web` 包编译产物并部署到 Cloudflare Pages，无需二次开发。
4. **附件上传**：通过 R2 **S3 API**（签名 V4）完成文件的存储与下载，不使用 Workers 原生 R2 绑定。

---

## 2. 总体架构
```text
┌──────────────┐   HTTPS    ┌───────────────────┐
│  前端 (Pages) │◀──────────▶│  Worker API Edge  │
└──────────────┘             └───────────────────┘
                                   │ SQL
                                   ▼
                              ┌─────────┐
                              │  D1 DB  │
                              └─────────┘
                                   │ S3 REST
                                   ▼
                              ┌─────────┐
                              │   R2    │
                              └─────────┘
```
* 路由：`/api/*` → Worker；静态资源直接由 Pages 服务。  
* Worker 通过 `fetch()` 调用 R2 S3 兼容接口上传 / 下载附件（使用临时签名 URL）。

---

## 3. 环境变量
| 变量 | 说明 |
|------|------|
| `JWT_SECRET` | 用于签发/验证 Access‑Token 的 HMAC 密钥 |
| `R2_ACCOUNT_ID` | R2 账号 ID |
| `R2_ACCESS_KEY_ID` | S3 兼容 AccessKey |
| `R2_SECRET_ACCESS_KEY` | S3 兼容 SecretKey |
| `R2_BUCKET` | 存储桶名称 |
| `BASE_URL` | 对外可访问的根地址（用于拼装下载链接） |
| `LOG_LEVEL` | debug / info / warn / error |

D1 数据库在 `wrangler.toml` 的 `[[d1_databases]]` 里声明绑定为 `env.DB`，无需额外变量。

---

## 4. 数据库设计（D1 / SQLite）
> 所有时间字段使用 **Unix 秒整数**；文本采用 UTF‑8。

```sql
-- 用户表
CREATE TABLE user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'USER', -- HOST | USER
  email         TEXT,
  avatar_url    TEXT,
  password_hash TEXT,
  row_status    TEXT NOT NULL DEFAULT 'NORMAL',
  created_ts    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_ts    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 笔记表
CREATE TABLE memo (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT NOT NULL UNIQUE,
  creator_id  INTEGER NOT NULL REFERENCES user(id),
  content     TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'PRIVATE',
  row_status  TEXT NOT NULL DEFAULT 'NORMAL',
  created_ts  INTEGER NOT NULL,
  updated_ts  INTEGER NOT NULL
);
CREATE INDEX idx_memo_creator ON memo(creator_id);
CREATE INDEX idx_memo_visibility ON memo(visibility);

-- 标签表
CREATE TABLE tag (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id  INTEGER NOT NULL REFERENCES user(id),
  name        TEXT NOT NULL,
  created_ts  INTEGER NOT NULL
);

-- 关联表
CREATE TABLE memo_tag (
  memo_id INTEGER NOT NULL REFERENCES memo(id),
  tag_id  INTEGER NOT NULL REFERENCES tag(id),
  PRIMARY KEY (memo_id, tag_id)
);

-- 附件表
CREATE TABLE resource (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  uid          TEXT NOT NULL UNIQUE,
  creator_id   INTEGER NOT NULL REFERENCES user(id),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size         INTEGER NOT NULL,
  external_uri TEXT NOT NULL, -- r2://bucket/key
  created_ts   INTEGER NOT NULL
);

CREATE TABLE memo_resource (
  memo_id     INTEGER NOT NULL REFERENCES memo(id),
  resource_id INTEGER NOT NULL REFERENCES resource(id),
  PRIMARY KEY (memo_id, resource_id)
);
```
> 其余表（activity、webhook、workspace_setting、migration_history 等）与上游保持一致，详见附录。

---

## 5. 接口定义（核心）
### 5.1 身份认证
| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/auth/signup` | 首次安装时创建 HOST 账户 |
| POST | `/api/auth/signin` | 登录，返回 JWT |

#### POST `/api/auth/signin`
**请求体**
```json
{
  "username": "admin",
  "password": "secret"
}
```
**成功 200**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": 1,
    "uid": "84bf1fe7-...",
    "username": "admin",
    "role": "HOST",
    "avatarUrl": null,
    "createdTs": 1717999200,
    "updatedTs": 1717999200
  }
}
```
**失败 401**
```json
{"message":"INVALID_CREDENTIALS"}
```

### 5.2 用户服务
| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/user/me` | 登录用户 | 获取自己的完整信息 |
| GET | `/api/user/{id}` | 公开 | 获取公开资料 |
| PATCH | `/api/user/{id}` | 自己或 HOST | 更新邮箱、头像等 |

#### PATCH `/api/user/{id}`
```json
{
  "email": "me@example.com",
  "avatarUrl": "https://..."
}
```
返回同 GET。

### 5.3 笔记服务
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/memo` | 创建笔记 |
| GET | `/api/memo` | 列表，支持过滤 |
| GET | `/api/memo/{id}` | 单条笔记 |
| PATCH | `/api/memo/{id}` | 编辑内容 / 可见性 |
| DELETE | `/api/memo/{id}` | 逻辑删除 |
| GET | `/api/memo/stats` | 日志、可见性统计 |

##### POST `/api/memo`
```json
{
  "content": "Hello *Cloudflare*!",
  "visibility": "PUBLIC",
  "resourceIdList": [3,4]
}
```
**响应 200** 见 Memo 对象示例。

### 5.4 标签服务
| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/tag` | 列出自己的标签 |
| POST | `/api/tag` | 创建新标签 |
| DELETE | `/api/tag/{id}` | 删除标签 |

### 5.5 附件服务
| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/resource/blob` | 上传附件（multipart） |
| GET  | `/o/r/{uid}/{filename}` | 下载附件（302 → R2 签名 URL） |

#### POST `/api/resource/blob`
表单字段 `file` 为二进制内容。  
流程：生成 UID → 使用 S3 PUT 上传 → 插入 `resource` → 返回。

**响应 200**
```json
{
  "id": 7,
  "uid": "4b407...",
  "filename": "logo.png",
  "mimeType": "image/png",
  "size": 34567,
  "externalUri": "r2://memos/${uid}/logo.png",
  "createdTs": 1718003000
}
```

---

## 6. 前端部署
1. `pnpm --dir web install && pnpm --dir web build` → `web/dist`  
2. `cloudflare pages deploy web/dist` 部署静态内容  
3. Pages 路由 `/api/*` 反向到 Worker  
4. 构建时注入
```html
<script>window.runtimeConfig={apiBaseUrl:"/"}</script>
```

---

## 7. 非功能性指标
* **冷启动** ≤ 5 ms  
* **P99 延迟** ≤ 100 ms（轻负载）  
* **吞吐** 500 req/s 持续  
* **数据持久性** 依赖 D1 & R2 冗余

---

## 8. 风险与缓解
| 风险 | 影响 | 对策 |
|------|------|------|
| D1 ALTER 支持有限 | 迁移失败 | 仅新增字段或影子表重建 |
| 大文件下载慢 | 体验差 | Range 请求 + CF 缓存 |
| JWT 密钥泄露 | 账号劫持 | 存储于环境变量并定期轮换 |

---

## 9. 参考数据模型示例
<details><summary>Memo</summary>

```json
{
  "id": 42,
  "uid": "c26f4c59-1786-4d7a-9dc4-9f5667bcaa7f",
  "creatorId": 1,
  "createdTs": 1717999200,
  "updatedTs": 1718002800,
  "rowStatus": "NORMAL",
  "content": "Hello **Memos** on Cloudflare!",
  "visibility": "PUBLIC",
  "resourceIdList": [5,6],
  "tags": ["cloud","memos"]
}
```
</details>

<details><summary>User</summary>

```json
{
  "id": 1,
  "uid": "84bf1fe7-3351-42c1-884b-22c3370a9a7c",
  "username": "admin",
  "role": "HOST",
  "createdTs": 1717999200,
  "updatedTs": 1717999200,
  "avatarUrl": null
}
```
</details>

---