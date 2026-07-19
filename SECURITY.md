# 安全政策 / Security Policy

## 报告漏洞 / Reporting a Vulnerability

如果你发现本项目存在安全漏洞（如认证绕过、SQL 注入、XSS 等），**请不要公开提 issue**，而是：

- 通过 GitHub 的 [Private vulnerability reporting](https://github.com/Allhuo/memos-cloudflare/security/advisories/new) 提交
- 或发邮件至 hitokotoop@gmail.com

我们会在 72 小时内确认收到，并在修复后公开致谢（除非你希望匿名）。

If you discover a security vulnerability (auth bypass, SQL injection, XSS, etc.), **please do not open a public issue**. Instead:

- Use GitHub's [Private vulnerability reporting](https://github.com/Allhuo/memos-cloudflare/security/advisories/new)
- Or email hitokotoop@gmail.com

We will acknowledge within 72 hours and credit you after the fix is released (unless you prefer anonymity).

## 部署安全须知 / Deployment security notes

- 部署后**立即修改默认管理员密码**（admin / 123456）
- `JWT_SECRET` 必须使用强随机值（`openssl rand -base64 32`）
- `ALLOWED_ORIGINS` 只配置你自己的前端域名
- 不要将包含真实 `database_id` 的 `wrangler.toml` 提交到公开仓库
