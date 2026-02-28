# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号采用 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] — 2026-02-28

### 新增

- 网页文字选中 → 浮动工具栏 → 创建 Comment / Issue 核心交互
- 侧边栏面板：标注列表、评论线程、标签筛选
- GitHub Issue 集成：自动创建 issue 并同步状态
- 多 adapter 分发架构：GitHub Issue、Lark、Telegram、Webhook
- 邀请码认证 + API Key 认证（多租户 app_id）
- Chrome 右键菜单快捷标注
- 键盘快捷键（⌘↵ 提交、Esc 关闭）
- Widget V2：来源归属、标签、截图支持
- API 限流 + 侧边栏防抖 / 缓存
- GitHub Issue adapter 映射持久化（SQLite）
- 浏览器插件 Manifest V3
- Docker 部署方案
- V2 API 参考文档、Chrome 扩展指南、adapter 指南、部署指南

### 修复

- 插件 popup 添加邀请码输入框 (#34)
- 侧边栏提交后自动刷新 (#39)
- adapter dispatch 传递完整 item 数据 (#32)
- 扩展图标生成（16/32/48/128px）(#24)

## [0.1.0] — 2026-01-17

### 新增

- 初始版本：基础标注收集服务
- 上传扩展白名单
- `/verify` 接口限流
- JSON body 大小限制（512KB）
- 不存在 item 的状态操作返回 404

[0.2.0]: https://github.com/coco-xyz/clawmark/releases/tag/v0.2.0
[0.1.0]: https://github.com/coco-xyz/clawmark/commits/0c02d6b
