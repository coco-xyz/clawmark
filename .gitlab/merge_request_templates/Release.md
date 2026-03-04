## Release v{VERSION}

> 发版 MR：`develop` → `main`

---

### 版本亮点

<!-- 1-3 句话总结 -->

### 变更范围

- [ ] Extension 更新（manifest 版本已同步）
- [ ] Server 更新
- [ ] API 变更（如有，需更新 `docs/api-reference.md`）
- [ ] 破坏性变更（如有，需更新升级指南）

### Checklist

- [ ] `CHANGELOG.md` 已更新（`./scripts/release.sh {VERSION}` 生成）
- [ ] `package.json` version = `{VERSION}`
- [ ] `extension/manifest.json` version = `{VERSION}`
- [ ] 所有测试通过（`npm test`）
- [ ] develop 已包含本版本所有 feature branch
- [ ] Release notes 已填写（见下）

### Release Notes

<!-- 从 docs/release-template.md 填写 -->

### 发版后操作

- [ ] 推 tag：`git push origin v{VERSION}`
- [ ] CWS 手动上传 zip（freefacefly@gmail.com）
- [ ] 通知团队

---

/label ~release
/milestone %{VERSION}
