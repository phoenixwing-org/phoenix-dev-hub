# Admin 插件 symlink 扫描边界点检

> 公共迁移 Skill 基线以执行任务时的受控版本为准；本文不绑定具体 commit。
> 范围：仅调整 Phoenix Dev Hub 的装配核验契约、UI 与文档；不运行或修复产品门禁，不修改 Host/产品 Git。

## 要求

- [x] 完整读取新 Skill、迁移输入清单与验证审计模板。
- [x] 确认 Dev Hub 工作树在任务开始前 clean。
- [x] 将“核验组合”改称“装配核验”，避免误报为完整 verify。
- [x] API 明确返回 `completeProductVerification=false`。
- [x] 分别列出 Host-owned 与 plugin-owned 的 lint/typecheck/test/build 门禁所有权。
- [x] 未记录真实命令、扫描根、是否跟随 symlink、工具排除配置时，必须显示阻断而不是猜测通过。
- [x] 明确 `.git/info/exclude` 只影响 Git，不是 lint/typecheck/test/build 排除真源。
- [x] 明确 Host 不得穿透链接 `--fix` 产品源码；产品问题退回产品仓。
- [x] 保留插件自身 lint 与冻结 production 装配完整类型检查/构建门禁。
- [x] 文档保留现有挂载、Host lifecycle、路由、DDL dry-run 证据，但不称产品迁移完成。
- [x] 新增契约/API/UI 测试并通过完整门禁。
- [x] 升级补丁版本并创建中文本地提交，不 push。

## 产品阻断继承

- Function/BOM 缺少 legacy 精确金样本时，不得报告迁移完成。
- BOM dirty state、真实 403、Vue 浏览器点检与产品 lint 仍由产品任务处理，Dev Hub 不跨仓修复。
- Dev Hub 装配核验通过不等于产品 lint/typecheck/test/build 或冻结 production 装配通过。

## 用户点检

- [ ] Admin 插件页按钮显示“装配核验”，不再使用容易误解的“核验组合”。
- [ ] 核验结果标题明确为“非完整 verify”。
- [ ] 页面能看到 Host-owned / plugin-owned 门禁均为“未记录/未运行”时的阻断提示。
- [ ] 挂载明细明确说明 Git exclude 不控制工具扫描。
- [ ] 路由 200、挂载成功或 Host ready 不会显示为“产品迁移完成”。

## 结果

- Dev Hub 完整门禁：11 个测试文件、42 项测试，类型检查与生产构建通过。
- 浏览器点检：装配核验按钮、非完整 verify 标题、所有权分组、未记录阻断与 Git exclude 边界均显示正常。
- 最终提交：见 0.3.0 单一发布提交。
- 用户反馈：待填写。
