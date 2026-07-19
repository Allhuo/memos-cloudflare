## 10. 附录
* **完整 OpenAPI 规范**：后续可由自动脚本生成  
* **迁移脚本**：`/migrations/001_initial.sql` 与本 PRD DDL 一致

---

## 11. 部署与回滚策略
### 环境分层
| 环境 | 目的 | URL |
|------|------|-----|
| Staging | 功能验收、性能压测 | `https://staging.example.com` |
| Production | 正式线上 | `https://memos.example.com` |

* `main` 自动部署至 Staging  
* 发布使用 `release/*` tag → `deploy-production` Workflow  
* Staging 与 Production 使用独立 D1；R2 桶前缀隔离

### 回滚
* Pages Instant Rollback  
* Worker `wrangler deploy --rollback-to`  
* D1 `d1 restore` 或影子表回切

---

## 12. 监控、日志与告警
| 维度 | 方案 |
|------|------|
| Trace | `workers_trace_events` + `X-Request-Id` |
| Log | Logpush → R2 → BigQuery |
| Perf | Cloudflare Analytics + k6 定压测试 |
| Uptime | Cloudflare Healthcheck → Slack |
| R2 | 桶级 Metrics & 大文件报警 |

---

## 13. 性能预估与成本
| 项目 | 每月量 | 费用 (USD) |
|------|-------|------------|
| Worker 调用 | 2M | 0.30 |
| D1 vCPU | 3M | 1.50 |
| R2 存储 | 15 GB | 0.22 |
| R2 出口 | 50 GB | 4.25 |
| **合计** |  | **6.27** |

---

## 14. 限制与合规
1. 附件单文件 ≤ 100 MB  
2. 不存储身份证件敏感信息  
3. 备份：D1 每日导出；R2 桶跨区复制  
4. CORS/CSP 严格控制  
5. `memo` 写操作使用乐观锁

---

## 15. 测试计划
| 类型 | 工具 | 目标 |
|------|------|------|
| 契约 | Postman/Newman | 所有状态码、字段 |
| E2E | Playwright | 登录/记笔记/上传/下载 |
| 压力 | k6 | 100 VU × 10 min |
| 安全 | OWASP ZAP | XSS / CSRF / JWT 泄露 |

---

## 16. 文件输出说明
* **memos-cloudflare-prd.md**：章节 1–9  
* **memos-cloudflare-appendix.md**：章节 10–16  

---