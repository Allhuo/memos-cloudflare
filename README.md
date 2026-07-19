# Memos on Cloudflare

[![CI](https://github.com/Allhuo/memos-cloudflare/actions/workflows/ci.yml/badge.svg)](https://github.com/Allhuo/memos-cloudflare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Allhuo/memos-cloudflare)](https://github.com/Allhuo/memos-cloudflare/stargazers)

English | [中文](README.zh-CN.md)

Deploy [Memos](https://github.com/usememos/memos) — the open-source, self-hosted note-taking app — entirely on Cloudflare's free tier: **Workers** (frontend + API) + **D1** (SQLite database) + **R2** (file storage). No server, no Docker, no cost for personal use.

## Why this project

The official Memos requires a server running Docker. This project reimplements the Memos backend as a Cloudflare Worker so you can run your personal memo service on Cloudflare's global edge — free, fast, and maintenance-free.

- 🚀 **Serverless**: global edge deployment via Cloudflare Workers
- 🗄️ **D1 database**: SQLite-backed distributed storage
- 📁 **R2 storage**: file/image upload support
- 🔐 **JWT authentication** with configurable CORS
- 🎯 **Aligned with upstream Memos v0.29** (Connect API, client-side markdown, session auth)

## Quick start

Single-Worker deployment (recommended): one Worker serves both the frontend and the API — same origin, no CORS/cookie configuration.

```bash
git clone https://github.com/Allhuo/memos-cloudflare.git
cd memos-cloudflare

# 1. Build the frontend (the Worker serves frontend/dist as static assets)
cd frontend
npm install -g pnpm@11   # or: corepack enable
pnpm install && pnpm build

# 2. Create Cloudflare resources
cd ../backend
npm install
npx wrangler d1 create memos             # copy the database_id into wrangler.toml
npx wrangler r2 bucket create memos-assets

# 3. Initialize the database (v2 schema, aligned with upstream v0.29)
npx wrangler d1 execute memos --remote --file schema-v2.sql

# 4. Set the JWT secret
npx wrangler secret put JWT_SECRET       # e.g. output of: openssl rand -base64 32

# 5. Deploy
npx wrangler deploy
```

Your instance is now live at `https://memos-cloudflare.<your-subdomain>.workers.dev`.

<details>
<summary>Alternative: split deployment (Pages frontend + Worker API)</summary>

Build the frontend with `VITE_API_BASE_URL=https://your-worker.workers.dev` and deploy `frontend/dist` to Cloudflare Pages; remove the `[assets]` section from `wrangler.toml`. Set `ALLOWED_ORIGINS` as a Worker secret to your Pages origin. Note: cross-site cookies require the browser to accept `SameSite=None` third-party cookies.
</details>

### Sign in

Default account: `admin` / `123456` — **change the password immediately after first login.**

## Configuration

| Variable | Where | Description |
|----------|-------|-------------|
| `JWT_SECRET` | Worker secret | JWT signing key (required, use a strong random value) |
| `ALLOWED_ORIGINS` | Worker secret | Comma-separated list of allowed frontend origins |
| `VITE_API_BASE_URL` | Pages env var | Backend Worker URL for the frontend |

See [SECURITY.md](SECURITY.md) for the post-deployment security checklist.

## Troubleshooting

<details>
<summary><b>Frontend shows "Failed to fetch"</b></summary>

CORS misconfiguration. Check that `ALLOWED_ORIGINS` contains your exact frontend origin (no trailing slash), then redeploy the Worker.
</details>

<details>
<summary><b>Cannot log in with admin / 123456</b></summary>

Reset the admin password back to `123456` (v2 schema):

```bash
npx wrangler d1 execute memos --remote --command "UPDATE user SET password_hash = 'pbkdf2\$100000\$UMwJUlX+C0KYrCbG1r8H6A==\$SP5js+HSEHyvYH30GMBZIygmbqktKmorLJtdztfX72Y=' WHERE username = 'admin'"
```

(On the legacy v1 schema this issue was [#1](https://github.com/Allhuo/memos-cloudflare/issues/1); use the SHA-256 hex value from that issue instead.)
</details>

<details>
<summary><b>Database errors</b></summary>

```bash
npx wrangler d1 list                                          # verify the database exists
npx wrangler d1 execute memos --remote --file schema-v2.sql   # re-run migrations
```
</details>

## Upstream compatibility

Aligned with **Memos v0.29.1**: the frontend is the upstream web app (2-file fork for Connect JSON transport + optional cross-origin API base), and the backend reimplements the Connect API on Workers/D1/R2 — including the dual-token session model, `ListMemos` CEL filters, comments, reactions, shares and link previews. A few RPCs the web UI never calls return `unimplemented`; SSO and audio transcription are untested/stubbed. Progress: [ROADMAP.md](ROADMAP.md).

Migrating from the v1 (v0.24-era) schema? See [docs/migrate-v1-to-v2.md](docs/migrate-v1-to-v2.md).

## Contributing

Contributions of any size are welcome — bug reports, docs, translations, fixes, upstream alignment. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [`good first issue`](https://github.com/Allhuo/memos-cloudflare/labels/good%20first%20issue) label, or open an issue to discuss what you'd like to work on.

## Project structure

```
memos-cloudflare/
├── backend/           # Cloudflare Worker: Connect API + static assets (Hono + D1 + R2)
│   ├── src/v2/        # Connect JSON services (aligned with upstream v0.29)
│   └── schema-v2.sql
├── frontend/          # Upstream Memos v0.29.1 web app (React + Vite, 2-file fork)
│   └── src/
└── docs/              # Deployment & migration guides
```

## Credits & license

- Based on [Memos](https://github.com/usememos/memos) by the usememos team (MIT)
- Started from an early version of [vividmuse/memos-cloudflare](https://github.com/vividmuse/memos-cloudflare), since heavily rewritten

[MIT](LICENSE)
