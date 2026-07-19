# Memos on Cloudflare

[![CI](https://github.com/Allhuo/memos-cloudflare/actions/workflows/ci.yml/badge.svg)](https://github.com/Allhuo/memos-cloudflare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Allhuo/memos-cloudflare)](https://github.com/Allhuo/memos-cloudflare/stargazers)

[English](README.md) | 中文

把开源自托管笔记应用 [Memos](https://github.com/usememos/memos) 完整部署在 Cloudflare 免费额度上：**Workers**(前端 + API)+ **D1**(SQLite 数据库)+ **R2**(文件存储)。无需服务器、无需 Docker,个人使用零成本。

## 为什么做这个项目

官方 Memos 需要一台跑 Docker 的服务器。本项目把 Memos 后端重新实现为 Cloudflare Worker，让你的个人笔记服务跑在 Cloudflare 全球边缘节点上——免费、快速、免维护。

- 🚀 **无服务器架构**：Cloudflare Workers 全球边缘部署
- 🗄️ **D1 数据库**：基于 SQLite 的分布式存储
- 📁 **R2 存储**：支持文件/图片上传
- 🔐 **JWT 认证** + 可配置 CORS
- 🎯 **对齐上游 Memos v0.29**(Connect API、客户端 markdown 渲染、会话认证)

## 快速部署

单 Worker 部署(推荐):一个 Worker 同时托管前端与 API——同源,无需任何 CORS/cookie 配置。

```bash
git clone https://github.com/Allhuo/memos-cloudflare.git
cd memos-cloudflare

# 1. 构建前端(Worker 会把 frontend/dist 作为静态资源托管)
cd frontend
npm install -g pnpm@11   # 或 corepack enable
pnpm install && pnpm build

# 2. 创建 Cloudflare 资源
cd ../backend
npm install
npx wrangler d1 create memos             # 把 database_id 填入 wrangler.toml
npx wrangler r2 bucket create memos-assets

# 3. 初始化数据库(v2 schema,对齐上游 v0.29)
npx wrangler d1 execute memos --remote --file schema-v2.sql

# 4. 设置 JWT 密钥
npx wrangler secret put JWT_SECRET       # 建议用 openssl rand -base64 32 生成

# 5. 部署
npx wrangler deploy
```

你的实例即上线于 `https://memos-cloudflare.<你的子域>.workers.dev`。

<details>
<summary>备选:分离部署(Pages 前端 + Worker API)</summary>

用 `VITE_API_BASE_URL=https://your-worker.workers.dev` 构建前端并把 `frontend/dist` 部署到 Cloudflare Pages;从 `wrangler.toml` 删除 `[assets]` 段;把 `ALLOWED_ORIGINS` 设为 Pages 域名。注意:跨站 cookie 需要浏览器允许 `SameSite=None` 第三方 cookie。
</details>

### 登录

默认账号:`admin` / `123456` ——**首次登录后请立即修改密码。**

## 配置说明

| 变量 | 位置 | 说明 |
|------|------|------|
| `JWT_SECRET` | Worker Secret | JWT 签名密钥（必须，使用强随机值） |
| `ALLOWED_ORIGINS` | Worker Secret | 允许的前端域名，逗号分隔 |
| `VITE_API_BASE_URL` | Pages 环境变量 | 前端访问的后端 Worker 地址 |

部署后的安全检查清单见 [SECURITY.md](SECURITY.md)。

## 故障排除

<details>
<summary><b>前端显示 "Failed to fetch"</b></summary>

CORS 配置问题。检查 `ALLOWED_ORIGINS` 是否包含前端域名（注意不要带末尾斜杠），然后重新部署 Worker。
</details>

<details>
<summary><b>admin / 123456 无法登录</b></summary>

把管理员密码重置回 `123456`(v2 schema):

```bash
npx wrangler d1 execute memos --remote --command "UPDATE user SET password_hash = 'pbkdf2\$100000\$UMwJUlX+C0KYrCbG1r8H6A==\$SP5js+HSEHyvYH30GMBZIygmbqktKmorLJtdztfX72Y=' WHERE username = 'admin'"
```

(旧版 v1 schema 的同类问题见 [#1](https://github.com/Allhuo/memos-cloudflare/issues/1),那时应使用该 issue 中的 SHA-256 值。)
</details>

<details>
<summary><b>数据库报错</b></summary>

```bash
npx wrangler d1 list                                          # 确认数据库存在
npx wrangler d1 execute memos --remote --file schema-v2.sql   # 重新执行迁移
```
</details>

## 上游兼容性

已对齐 **Memos v0.29.1**:前端即上游 web 应用(仅 2 个文件的 fork:Connect JSON transport + 可选跨域 API 地址),后端在 Workers/D1/R2 上重新实现了 Connect API——包括双 token 会话模型、`ListMemos` CEL 过滤器、评论、reaction、分享与链接预览。个别 web 端不调用的 RPC 返回 `unimplemented`;SSO 与语音转写未实测/占位。进度见 [ROADMAP.md](ROADMAP.md)。

从 v1(v0.24 时代)schema 迁移?见 [docs/migrate-v1-to-v2.md](docs/migrate-v1-to-v2.md)。

## 参与贡献

欢迎任何形式的贡献——报 bug、写文档、翻译、修代码、对齐上游。从 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [`good first issue`](https://github.com/Allhuo/memos-cloudflare/labels/good%20first%20issue) 标签开始，或者直接开 issue 聊聊你想做什么。

## 项目结构

```
memos-cloudflare/
├── backend/           # Cloudflare Worker:Connect API + 静态资源(Hono + D1 + R2)
│   ├── src/v2/        # Connect JSON 服务(对齐上游 v0.29)
│   └── schema-v2.sql
├── frontend/          # 上游 Memos v0.29.1 web 应用(React + Vite,仅 2 文件 fork)
│   └── src/
└── docs/              # 部署与迁移文档
```

## 致谢与许可

- 基于 usememos 团队的 [Memos](https://github.com/usememos/memos)（MIT）
- 起步于 [vividmuse/memos-cloudflare](https://github.com/vividmuse/memos-cloudflare) 的早期版本，现已大量重写

[MIT](LICENSE)
