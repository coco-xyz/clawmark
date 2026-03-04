# ClawMark 发版流程

> **一句话版本**：所有变更通过 feature branch → MR → `develop`；发版时从 `develop` 合到 `main`，打 tag，GitLab 自动生成 Release 页面。

---

## 发版流程概览

```
feature branch
     ↓  MR → develop
  develop (集成测试)
     ↓  MR → main (发版 MR)
    main + tag v{X.Y.Z}
     ↓  GitLab Release 自动创建
  Chrome Web Store 手动上传
```

---

## Step-by-step

### 1. 准备发版分支

```bash
git checkout develop && git pull origin develop
git checkout -b chore/bump-v{X.Y.Z}
```

### 2. 运行发版脚本

```bash
./scripts/release.sh {X.Y.Z}
```

脚本会自动：
- 检查版本号合法性（semver，必须大于当前版本）
- 更新 `package.json` + `extension/manifest.json`
- 从 git log 提取提交，按类型分组生成 release notes
- 追加到 `CHANGELOG.md`
- 创建 commit + annotated tag

> 先用 `--dry-run` 预览：`./scripts/release.sh {X.Y.Z} --dry-run`

### 3. 开 MR → develop

```bash
git push origin chore/bump-v{X.Y.Z}
glab mr create --target-branch develop --title "chore: bump v{X.Y.Z}" \
  --description "$(cat docs/release-template.md)"
```

### 4. 发版 MR：develop → main

develop 测试通过后：

```bash
glab mr create --source-branch develop --target-branch main \
  --title "Release v{X.Y.Z}" \
  --description "$(./scripts/release.sh {X.Y.Z} --dry-run 2>&1)"
```

### 5. 推 tag

```bash
git push origin v{X.Y.Z}
```

GitLab 会自动在 Releases 页面创建 Release，Release notes 取自 tag 的 annotated message。

### 6. CWS 手动上传（当前）

- 打包：`cd extension && zip -r /tmp/clawmark-v{X.Y.Z}.zip . -x "*.DS_Store"`
- 上传到 Chrome Web Store：[Developer Dashboard](https://chrome.google.com/webstore/devconsole)（freefacefly@gmail.com）
- 需要人工操作（passkey 验证）

---

## 版本号规则

| 类型 | 版本号 | 示例 |
|------|--------|------|
| 破坏性变更 / 架构重写 | MAJOR (X.0.0) | 1.0.0 |
| 新功能（向后兼容） | MINOR (0.Y.0) | 0.7.0 |
| Bug fix / 小改动 | PATCH (0.0.Z) | 0.6.4 |

---

## Commit 规范（Conventional Commits）

发版脚本依赖 commit 前缀自动分类：

| 前缀 | 分类 |
|------|------|
| `feat:` | 新增功能 |
| `fix:` | Bug 修复 |
| `security:` / `sec:` | 安全修复 |
| `docs:` | 文档更新 |
| `chore:` / `refactor:` / `perf:` | 其他 |
| `BREAKING CHANGE` | 破坏性变更 |

---

## 相关文件

- `scripts/release.sh` — 发版自动化脚本
- `CHANGELOG.md` — 版本历史（Keep a Changelog 格式）
- `docs/release-template.md` — 版本 summary 模板
- `.gitlab/merge_request_templates/Release.md` — 发版 MR 模板
