# Roadmap

> 想认领某项？在对应 issue 下留言即可。欢迎提出新想法！
> Want to work on something? Comment on the corresponding issue. New ideas welcome!

## 近期 / Near-term（v0.x）

- [x] 修复 schema.sql 默认管理员密码哈希错误（#1）
- [x] 修复前端依赖下架导致无法构建的问题
- [x] CI：后端类型检查 + 前端构建
- [ ] 提供在线 Demo 实例（#2）
- [ ] 一键部署：Deploy to Cloudflare 按钮 / 部署脚本
- [ ] 前端历史遗留的 TypeScript 报错清零（约 60 处，多在 store/v2）
- [ ] 后端补充基础测试（vitest + Miniflare）

## 中期 / Mid-term

- [ ] 对齐 Memos 上游新版 API（#3）。当前对齐 v0.24.x，上游已至 v0.29.1（2026-06），主要差距：
  - v0.25: 用户会话滑动窗口、webhook 存储位置迁移
  - v0.26: 刷新令牌轮换、`HOST` → `ADMIN` 角色重命名、前端 React Query v5 重构、媒体流式传输、EXIF 剥离
  - v0.27: SSE 实时刷新、标签元数据、转写服务
  - v0.28: SSO 身份关联（破坏性变更）
  - v0.29: 链接预览/元数据 API、SMTP 通知设置、实例统计 API
  - 建议路径：先对齐 v0.26（角色重命名 + 认证模型），再逐版本推进
- [ ] 数据导入/导出工具（从官方 Memos 迁移到 D1 / 反向迁移）
- [ ] 密码哈希升级为加盐 PBKDF2（含存量数据平滑迁移）
- [ ] i18n：完善英文文档

## 长期 / Long-term

- [ ] 跟随上游主要版本演进，保持 API 兼容
- [ ] 可选的 Cloudflare Access / Zero Trust 集成
