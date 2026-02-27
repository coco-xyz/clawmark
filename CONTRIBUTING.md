# ClawMark 开发工作流

## 分支管理

### 分支结构

```
main              ← 稳定分支，始终可部署到生产环境
  └── feature/*   ← 功能开发（如 feature/v2-server-upgrade）
  └── fix/*       ← 缺陷修复（如 fix/upload-whitelist）
  └── docs/*      ← 文档变更（如 docs/dev-workflow）
```

### 规则

1. **main 是受保护分支** — 不允许直接 push，所有变更通过 PR 合并
2. **从 main 拉分支** — 所有 feature/fix/docs 分支基于最新 main 创建
3. **分支命名规范**：
   - `feature/<简短描述>` — 新功能
   - `fix/<简短描述>` — Bug 修复
   - `docs/<简短描述>` — 纯文档变更
   - 使用小写英文 + 连字符，如 `feature/chrome-extension`，不要用中文或下划线
4. **合并后删除分支** — PR 合并后删除远程 feature 分支，保持仓库干净
5. **不用 develop 分支** — 团队小，main + feature 分支足够。避免维护多余的长期分支

### 操作流程

```bash
# 开始新功能
git checkout main
git pull origin main
git checkout -b feature/my-feature

# 开发完成，推送
git push -u origin feature/my-feature

# 在 GitHub 创建 PR → 目标分支 main
```

## PR 工作流

### 循环 Review 原则

所有 PR 必须经过团队循环 review + approve 才能 merge。

| 提交人 | Reviewer | Merge |
|--------|----------|-------|
| Lucy | Jessie review + approve | Kevin merge |
| Boot | Jessie review + approve | Kevin merge |
| Jessie | Lucy 或 Boot review + approve | Kevin merge |

- 不跳过 review，不自己 merge 自己的 PR
- Review 通过后由 Kevin 执行 merge
- merge 方式：**Squash and merge**（保持 main 历史干净）

### PR 规范

- **标题**：简短说明变更（如 `feat: add v2 API endpoints`）
- **描述**：包含变更内容、测试方式、关联 issue
- **每个 PR 只做一件事** — 不要混合不相关的改动
- **通过 CI 检查后再请 review** — 确保本地 `npm start` 能跑通

### Commit Message 规范

```
<type>: <简短描述>

可选的详细说明
```

类型：
- `feat` — 新功能
- `fix` — Bug 修复
- `docs` — 文档变更
- `refactor` — 重构（不改行为）
- `test` — 测试
- `chore` — 构建/工具/依赖变更

## 部署环境

### 环境定义

| 环境 | 用途 | 地址 | 分支 | 数据 |
|------|------|------|------|------|
| **local** | 本地开发调试 | `localhost:3462` | feature/* | 本地 SQLite |
| **staging** | 集成测试 + PR 预览 | `staging-clawmark.coco.xyz` | main (自动) | 独立 SQLite，测试数据 |
| **production** | 线上服务 | `clawmark.coco.xyz` | main (手动) | 生产 SQLite，真实数据 |

### 本地开发环境 (local)

```bash
# 克隆 + 安装
git clone https://github.com/coco-xyz/clawmark.git
cd clawmark
npm install

# 启动开发服务
npm run dev
# → http://localhost:3462
```

配置文件 `config.json`（本地开发用默认值即可）：

```json
{
  "port": 3462,
  "dataDir": "./data",
  "auth": {
    "type": "invite-code",
    "codes": { "dev-test": "Developer" }
  }
}
```

要求：
- Node.js >= 18
- npm >= 9

### Staging 环境

- 部署方式：PM2 管理进程
- 数据目录：独立于 production，使用测试数据
- **main 分支 merge 后自动部署**（Boot 负责配置 CD）
- 用于：
  - PR merge 后的集成测试
  - 浏览器插件联调
  - 分发 Adapter 端到端测试

环境变量：
```
CLAWMARK_PORT=3459
CLAWMARK_DATA_DIR=/data/clawmark-staging
CLAWMARK_ENV=staging
```

### Production 环境

- 部署方式：PM2 + Caddy 反向代理
- 域名：`clawmark.coco.xyz`
- **手动部署** — staging 验证通过后，由 Boot 执行
- 部署需要 Kevin 确认

环境变量：
```
CLAWMARK_PORT=3458
CLAWMARK_DATA_DIR=/data/clawmark
CLAWMARK_ENV=production
```

### 部署流程

```
feature/* → PR → review + approve → Kevin merge → main
                                                    ↓
                                              staging 自动部署
                                                    ↓
                                              测试验证通过
                                                    ↓
                                        Boot 手动部署 → production
```

### 部署检查清单

部署到 staging/production 前确认：
- [ ] `npm start` 本地能正常启动
- [ ] `GET /health` 返回 200
- [ ] 现有功能不受影响（widget 嵌入模式仍可用）
- [ ] 数据库迁移脚本正确执行（如有 schema 变更）
- [ ] 环境变量配置正确

## Issue 管理

- 使用 GitHub Issues 跟踪任务
- Issue 标签：`feature`、`bug`、`docs`、`phase-1`/`phase-2`/`phase-3`
- PR 描述中关联 issue：`Closes #2` 或 `Ref #3`
- Phase 对应 issue：
  - #2 — Phase 1: 服务端升级 (Lucy)
  - #3 — Phase 2: 浏览器插件 (Lucy)
  - #4 — Phase 3: 分发 Adapter (Boot)
