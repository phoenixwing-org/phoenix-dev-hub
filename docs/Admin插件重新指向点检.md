# Admin 插件登记重新指向点检

状态：实现完成，等待用户真实页面点检

范围：只更新 Phoenix Hub 的本机开发装配登记、Admin Vue/Node 开发 symlink 与对应
`.git/info/exclude` marker。明确不执行 Pah register/install/enable、DDL、数据库或权限改动。

## 安全边界

- [x] 新目录先执行与新增插件相同的后端 inspect；拒绝非 Git 目录、非法 Manifest v2、缺失/越界/symlink 入口；
- [x] 校验新旧 `moduleId` 完全一致，不从登记 ID 猜测身份；
- [x] 校验 DDL 文件原始字节 SHA-256，以及 artifacts 的 format/module/version/runtime artifact 路径、size 和 SHA-256；
- [x] 拒绝重复登记路径、插件源落入 Host 仓库、实体占用和既非旧源也非新源的第三方链接；
- [x] 只接受链接仍指向旧源、已经指向本次新源或缺失三种状态；已经指向新源时受控认领；
- [x] 先预检 Vue/Node 两端和 exclude，再统一更新链接、marker 与 `.runtime/admin-plugins.json`；
- [x] 中途失败恢复原链接、exclude 与登记；回滚不完整返回 `ADMIN_PLUGIN_REPOINT_ROLLBACK_FAILED` 和人工复核明细；
- [x] 旧目录不可用时 catalog 不整体失败；保存过 moduleId 身份快照的登记仍可重新指向；
- [x] 普通 mount/unmount 在源目录不可用时 fail-closed；不提供广域删除或覆盖入口。

## API / UI

- [x] `PATCH /api/admin-plugins/:id` 接收 `{ "directory": "..." }` 并返回更新后的实时状态；
- [x] 详情页“重新指向”先检查目录并展示名称、moduleId、版本、路径和策略警告；
- [x] moduleId 不同、身份未知或策略阻断时不能确认；
- [x] 二次确认明确列出仅开发装配的副作用和全部禁止边界；
- [x] 最近操作区分“重新指向”，并逐条显示 replaced/claimed/created link 与 exclude 变化；
- [x] 源不可用卡片展示原因、旧路径和恢复入口。

## 自动门禁

- [x] Workspace 单元测试：普通替换、现有新链接认领、旧源不可用、moduleId 不同、重复登记、第三方链接；
- [x] Workspace 单元测试：Manifest/DDL/artifacts 强校验和原有 mount/unmount 安全边界；
- [x] API 测试：inspect/add/mount → PATCH 重新指向 → unmount/remove；
- [x] `pnpm typecheck`；
- [x] `pnpm test`；
- [x] `pnpm build`。

## 用户手工点检

- [ ] 打开“系统 → Admin 工具 → Admin 插件”，选择旧 Function 登记；
- [ ] 点击“重新指向”，填写当前 `phoenix-function-develop`（manifest `0.2.1-admin.7`）产品根目录；
- [ ] 点击“检查新目录”，确认 moduleId 为 `phoenix-function-develop`、版本为 `0.2.1-admin.7`；
- [ ] 确认重新指向；若两条 Host 链接已经指向新目录，最近操作应显示两条 `claimed-link`；
- [ ] 刷新页面，卡片路径/版本仍是新 worktree/`0.2.1-admin.7`，挂载状态为“开发已挂载”；
- [ ] 核对 Admin Vue/Node 的 `src/modules/phoenix-function-develop` realpath 均指向新产品；
- [ ] 核对两个 Host `.git/info/exclude` 各只有一个该 moduleId 的受控 marker；
- [ ] 用另一个 moduleId、实体目标或第三方 symlink 尝试，确认页面给出明确拒绝且原登记/链接不变；
- [ ] 确认没有 Pah lifecycle、DDL、数据库、菜单或权限变化。
