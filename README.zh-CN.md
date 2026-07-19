# Memos on Cloudflare

[![CI](https://github.com/Allhuo/memos-cloudflare/actions/workflows/ci.yml/badge.svg)](https://github.com/Allhuo/memos-cloudflare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Allhuo/memos-cloudflare)](https://github.com/Allhuo/memos-cloudflare/stargazers)

[English](README.md) | 中文

把开源自托管笔记应用 [Memos](https://github.com/usememos/memos) 完整部署在 Cloudflare 免费额度上：**Workers**（后端）+ **D1**（SQLite 数据库）+ **R2**（文件存储）+ **Pages**（前端）。无需服务器、无需 Docker，个人使用零成本。

## 为什么做这个项目

官方 Memos 需要一台跑 Docker 的服务器。本项目把 Memos 后端重新实现为 Cloudflare Worker，让你的个人笔记服务跑在 Cloudflare 全球边缘节点上——免费、快速、免维护。

- 🚀 **无服务器架构**：Cloudflare Workers 全球边缘部署
- 🗄️ **D1 数据库**：基于 SQLite 的分布式存储
- 📁 **R2 存储**：支持文件/图片上传
- 🔐 **JWT 认证** + 可配置 CORS
- 🎯 **API 兼容** Memos v0.24.x（见[上游兼容性](#上游兼容性)）

## 快速部署

### 1. 克隆项目

```bash
git clone https://github.com/Allhuo/memos-cloudflare.git
cd memos-cloudflare
```

### 2. 部署后端（Worker）

```bash
cd backend
npm install

# 创建 D1 数据库
npx wrangler d1 create memos

# 复制配置模板，填入你的数据库 ID
cp wrangler.toml.example wrangler.toml

# 初始化数据库
npx wrangler d1 execute memos --remote --file schema.sql

# 设置密钥
npx wrangler secret put JWT_SECRET        # 建议用 openssl rand -base64 32 生成
npx wrangler secret put ALLOWED_ORIGINS   # 如 https://your-frontend.pages.dev

# 部署
npx wrangler deploy
```

### 3. 部署前端（Pages）

1. 在 Cloudflare Dashboard 创建 Pages 项目并连接你的仓库
2. 构建设置：
   ```
   Framework preset: Vite
   Root directory: frontend
   Build command: npm install && npm run build
   Build output directory: dist
   Node.js version: 20
   ```
3. 环境变量：
   ```
   VITE_API_BASE_URL=https://your-worker-name.your-subdomain.workers.dev
   ```

### 4. 登录

默认账号：`admin` / `123456` ——**首次登录后请立即修改密码。**

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

如果你用 2026 年 7 月之前的 schema 初始化过数据库，种子密码哈希有误（[#1](https://github.com/Allhuo/memos-cloudflare/issues/1)，已修复）。执行以下命令重置：

```bash
npx wrangler d1 execute memos --remote --command "UPDATE user SET password_hash = '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92' WHERE username = 'admin'"
```
</details>

<details>
<summary><b>数据库报错</b></summary>

```bash
npx wrangler d1 list                                          # 确认数据库存在
npx wrangler d1 execute memos --remote --file schema.sql      # 重新执行迁移
```
</details>

## 上游兼容性

本项目当前对齐 **Memos v0.24.x** API。上游已发布 v0.25–v0.29，包含大量变更（会话/刷新令牌认证、`HOST` → `ADMIN` 角色重命名、前端 React Query 重构、SSO 身份关联、链接预览 API 等）。对齐新版上游是中期主要目标——见 [ROADMAP.md](ROADMAP.md) 和 [#3](https://github.com/Allhuo/memos-cloudflare/issues/3)，非常欢迎参与。

## 参与贡献

欢迎任何形式的贡献——报 bug、写文档、翻译、修代码、对齐上游。从 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [`good first issue`](https://github.com/Allhuo/memos-cloudflare/labels/good%20first%20issue) 标签开始，或者直接开 issue 聊聊你想做什么。

## 项目结构

```
memos-cloudflare/
├── backend/           # Cloudflare Worker（Hono + D1 + R2）
│   ├── src/
│   └── schema.sql
├── frontend/          # React + Vite（部署在 Cloudflare Pages）
│   └── src/
└── docs/              # 部署文档
```

## 致谢与许可

- 基于 usememos 团队的 [Memos](https://github.com/usememos/memos)（MIT）
- 起步于 [vividmuse/memos-cloudflare](https://github.com/vividmuse/memos-cloudflare) 的早期版本，现已大量重写

[MIT](LICENSE)
