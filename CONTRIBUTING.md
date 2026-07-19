# 贡献指南 / Contributing Guide

[English](#english) | [中文](#中文)

## 中文

感谢你对 memos-cloudflare 的关注！本项目让你可以把 [Memos](https://github.com/usememos/memos) 部署在 Cloudflare 的免费额度上（Workers + D1 + R2），欢迎任何形式的贡献。

### 我可以贡献什么？

- 🐛 **报告 bug**：部署失败、接口报错、前端异常，请附上复现步骤
- 📝 **完善文档**：部署踩坑记录、FAQ、英文翻译
- 💻 **修代码**：查看带 [`good first issue`](https://github.com/Allhuo/memos-cloudflare/labels/good%20first%20issue) 和 [`help wanted`](https://github.com/Allhuo/memos-cloudflare/labels/help%20wanted) 标签的 issue
- 🚀 **对齐上游**：帮助跟进 Memos 上游的新版本 API

### 开发环境

```bash
# 后端（Cloudflare Worker）
cd backend
npm install
npm run dev          # 本地启动 wrangler dev
npx tsc --noEmit     # 类型检查（必须零报错）

# 前端（React + Vite）
cd frontend
npm install
npm run dev          # 本地开发服务器
npm run build        # 构建（提 PR 前必须通过）
```

### PR 流程

1. Fork 本仓库并从 `main` 切出分支（如 `fix/login-error`）
2. 提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 格式：`fix:`、`feat:`、`docs:` 等
3. 提交前确认：后端 `tsc --noEmit` 通过、前端 `npm run build` 通过
4. 发起 PR，描述改动内容和验证方式，关联相关 issue（如 `Fixes #1`）
5. 无需 CLA，维护者通常会在几天内回复

### 不确定从哪开始？

直接在 [Discussions/Issues](https://github.com/Allhuo/memos-cloudflare/issues) 里说一声你想做什么，我们会帮你找到合适的切入点。

---

## English

Thanks for your interest in memos-cloudflare! This project lets you deploy [Memos](https://github.com/usememos/memos) on Cloudflare's free tier (Workers + D1 + R2). All contributions are welcome.

### Ways to contribute

- 🐛 **Report bugs**: deployment failures, API errors, frontend glitches — please include reproduction steps
- 📝 **Improve docs**: deployment guides, FAQ, English translations
- 💻 **Fix code**: check issues labeled [`good first issue`](https://github.com/Allhuo/memos-cloudflare/labels/good%20first%20issue) and [`help wanted`](https://github.com/Allhuo/memos-cloudflare/labels/help%20wanted)
- 🚀 **Track upstream**: help align with newer Memos API versions

### Development setup

```bash
# Backend (Cloudflare Worker)
cd backend
npm install
npm run dev          # local wrangler dev server
npx tsc --noEmit     # type check (must be clean)

# Frontend (React + Vite)
cd frontend
npm install
npm run dev          # local dev server
npm run build        # must pass before submitting a PR
```

### PR workflow

1. Fork the repo and branch off `main` (e.g. `fix/login-error`)
2. Use [Conventional Commits](https://www.conventionalcommits.org/): `fix:`, `feat:`, `docs:`, etc.
3. Before submitting: backend `tsc --noEmit` passes, frontend `npm run build` passes
4. Open a PR describing the change and how you verified it; link related issues (e.g. `Fixes #1`)
5. No CLA required. Maintainers usually respond within a few days

### Not sure where to start?

Just open an [issue](https://github.com/Allhuo/memos-cloudflare/issues) describing what you'd like to work on and we'll help you find a good entry point.
