# Roadmap

> 想认领某项？在对应 issue 下留言即可。欢迎提出新想法！
> Want to work on something? Comment on the corresponding issue. New ideas welcome!

## 近期 / Near-term（v0.x）

- [x] 修复 schema.sql 默认管理员密码哈希错误（#1）
- [x] 修复前端依赖下架导致无法构建的问题
- [x] CI：后端类型检查 + 前端构建
- [x] 提供在线 Demo 实例（#2）：https://memos-cloudflare.hitokotoop-f8c.workers.dev
- [ ] 一键部署：Deploy to Cloudflare 按钮 / 部署脚本
- [ ] 后端补充基础测试（vitest + Miniflare，v2 Connect 服务优先）
- [ ] Demo 实例定期自动重置（Worker Cron）

## 中期 / Mid-term

- [x] 对齐 Memos 上游 v0.29.1 API（#3，2026-07 完成核心对齐；SSO/转写待实测，12 个 web 端未用的 RPC 暂缓）。此前差距记录：
  - v0.25: 用户会话滑动窗口、webhook 存储位置迁移
  - v0.26: 刷新令牌轮换、`HOST` → `ADMIN` 角色重命名、前端 React Query v5 重构、媒体流式传输、EXIF 剥离
  - v0.27: SSE 实时刷新、标签元数据、转写服务
  - v0.28: SSO 身份关联（破坏性变更）
  - v0.29: 链接预览/元数据 API、SMTP 通知设置、实例统计 API
  - 建议路径：先对齐 v0.26（角色重命名 + 认证模型），再逐版本推进
- [ ] 数据导入/导出工具（从官方 Memos 迁移到 D1 / 反向迁移）
- [x] 密码哈希升级为加盐 PBKDF2（v2 完成；v1 存量哈希登录时透明升级）
- [ ] i18n：完善英文文档

## 长期 / Long-term

- [ ] 跟随上游主要版本演进，保持 API 兼容
- [ ] 可选的 Cloudflare Access / Zero Trust 集成
