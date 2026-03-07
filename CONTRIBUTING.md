# ClawMark 开发工作流

## 分支管理

### 分支结构

```
main              ← 稳定分支，始终可部署到生产环境
  └── develop     ← 集成分支，所有 MR/PR 目标分支
        └── feature/*   ← 功能开发（如 feature/dashboard-refresh）
        └── fix/*       ← 缺陷修复（如 fix/auth-sync）
        └── docs/*      ← 文档变更（如 docs/update-readme）
        └── chore/*     ← 维护任务（如 chore/hygiene-audit）
```

### 规则

1. **main 和 develop 是受保护分支** — 不允许直接 push，所有变更通过 MR 合并
2. **从 develop 拉分支** — 所有 feature/fix/docs/chore 分支基于最新 develop 创建
3. **MR 目标分支是 develop** — 合并到 develop 后，定期同步到 main（发版时）
4. **分支命名规范**：
   - `feature/<简短描述>` — 新功能
   - `fix/<简短描述>` — Bug 修复
   - `docs/<简短描述>` — 纯文档变更
   - `chore/<简短描述>` — 维护、清理、依赖更新
   - 使用小写英文 + 连字符，如 `feature/chrome-extension`，不要用中文或下划线
5. **合并后删除分支** — MR 合并后删除远程 feature 分支，保持仓库干净

### 操作流程

```bash
# 开始新功能
git checkout develop
git pull origin develop
git checkout -b feature/my-feature

# 开发完成，推送
git push -u origin feature/my-feature

# 在 GitLab 创建 MR → 目标分支 develop
```

## MR 工作流

### 循环 Review 原则

所有 MR 必须经过团队循环 review + approve 才能 merge。

| 提交人 | Reviewer | Merge |
|--------|----------|-------|
| Lucy | Jessie review + approve | Kevin merge |
| Boot | Jessie review + approve | Kevin merge |
| Jessie | Lucy 或 Boot review + approve | Kevin merge |

- 不跳过 review，不自己 merge 自己的 MR
- Review 通过后由 Kevin 执行 merge
- merge 方式：**Squash and merge**（保持历史干净）

### MR 规范

- **标题**：简短说明变更（如 `feat: add v2 API endpoints`）
- **描述**：包含变更内容、测试方式、关联 issue
- **每个 MR 只做一件事** — 不要混合不相关的改动
- **通过 CI 检查后再请 review** — 确保本地 `npm test` 能跑通

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

## 代码仓库

- **主仓库（GitLab）**：[git.coco.xyz/hxanet/clawmark](https://git.coco.xyz/hxanet/clawmark)
- **GitHub 镜像**：[github.com/coco-xyz/clawmark](https://github.com/coco-xyz/clawmark)
- 所有 MR 在 GitLab 提交，GitHub 定期同步
