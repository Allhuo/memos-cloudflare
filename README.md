# Memos on Cloudflare

[![CI](https://github.com/Allhuo/memos-cloudflare/actions/workflows/ci.yml/badge.svg)](https://github.com/Allhuo/memos-cloudflare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Allhuo/memos-cloudflare)](https://github.com/Allhuo/memos-cloudflare/stargazers)

English | [中文](README.zh-CN.md)

Deploy [Memos](https://github.com/usememos/memos) — the open-source, self-hosted note-taking app — entirely on Cloudflare's free tier: **Workers** (backend) + **D1** (SQLite database) + **R2** (file storage) + **Pages** (frontend). No server, no Docker, no cost for personal use.

## Why this project

The official Memos requires a server running Docker. This project reimplements the Memos backend as a Cloudflare Worker so you can run your personal memo service on Cloudflare's global edge — free, fast, and maintenance-free.

- 🚀 **Serverless**: global edge deployment via Cloudflare Workers
- 🗄️ **D1 database**: SQLite-backed distributed storage
- 📁 **R2 storage**: file/image upload support
- 🔐 **JWT authentication** with configurable CORS
- 🎯 **API compatible** with Memos v0.24.x (see [upstream status](#upstream-compatibility))

## Quick start

### 1. Clone

```bash
git clone https://github.com/Allhuo/memos-cloudflare.git
cd memos-cloudflare
```

### 2. Deploy the backend (Worker)

```bash
cd backend
npm install

# Create the D1 database
npx wrangler d1 create memos

# Copy the config template and fill in your database ID
cp wrangler.toml.example wrangler.toml

# Initialize the schema
npx wrangler d1 execute memos --remote --file schema.sql

# Set secrets
npx wrangler secret put JWT_SECRET        # e.g. output of: openssl rand -base64 32
npx wrangler secret put ALLOWED_ORIGINS   # e.g. https://your-frontend.pages.dev

# Deploy
npx wrangler deploy
```

### 3. Deploy the frontend (Pages)

1. Create a Cloudflare Pages project connected to your fork
2. Build settings:
   ```
   Framework preset: Vite
   Root directory: frontend
   Build command: npm install && npm run build
   Build output directory: dist
   Node.js version: 20
   ```
3. Environment variable:
   ```
   VITE_API_BASE_URL=https://your-worker-name.your-subdomain.workers.dev
   ```

### 4. Sign in

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

If you initialized the database with a schema from before 2026-07, the seeded password hash was wrong ([#1](https://github.com/Allhuo/memos-cloudflare/issues/1), fixed since). Reset it:

```bash
npx wrangler d1 execute memos --remote --command "UPDATE user SET password_hash = '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92' WHERE username = 'admin'"
```
</details>

<details>
<summary><b>Database errors</b></summary>

```bash
npx wrangler d1 list                                          # verify the database exists
npx wrangler d1 execute memos --remote --file schema.sql      # re-run migrations
```
</details>

## Upstream compatibility

This project currently targets the **Memos v0.24.x** API. Upstream Memos has since shipped v0.25–v0.29 with significant changes (session/refresh-token auth, `HOST` → `ADMIN` role rename, React Query frontend refactor, SSO identity linkage, link-preview APIs). Aligning with newer upstream versions is the main mid-term goal — see [ROADMAP.md](ROADMAP.md) and [#3](https://github.com/Allhuo/memos-cloudflare/issues/3). Help is very welcome.

## Contributing

Contributions of any size are welcome — bug reports, docs, translations, fixes, upstream alignment. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [`good first issue`](https://github.com/Allhuo/memos-cloudflare/labels/good%20first%20issue) label, or open an issue to discuss what you'd like to work on.

## Project structure

```
memos-cloudflare/
├── backend/           # Cloudflare Worker (Hono + D1 + R2)
│   ├── src/
│   └── schema.sql
├── frontend/          # React + Vite (deployed on Cloudflare Pages)
│   └── src/
└── docs/              # Deployment guides
```

## Credits & license

- Based on [Memos](https://github.com/usememos/memos) by the usememos team (MIT)
- Started from an early version of [vividmuse/memos-cloudflare](https://github.com/vividmuse/memos-cloudflare), since heavily rewritten

[MIT](LICENSE)
