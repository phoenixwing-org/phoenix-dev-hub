# Phoenix Admin 插件开发工作区

状态：Phoenix Dev Hub 0.3.0 已实现装配核验边界；产品迁移完成度仍由各产品任务验收
适用范围：Phoenix Dev Hub 的“系统 → Admin 工具 → Admin 插件”独立 View

## 定位

Admin 插件开发工作区是 Phoenix Admin Host 的本机定制开发能力，不属于服务 Series/Profile
分组。Open Issue、Function、BOM 等插件是可挂载制品，不是可以独立启动的 Web 或进程。

- “全部网站”中的 Phoenix Open Issue 等条目仍代表原有独立网站，保持现状；
- “Admin 插件”View 中的同名产品代表插件源码版本，两者没有生命周期联动；
- 插件完成开发挂载后，统一启动或监控 Admin Web/API；
- 多个插件可以同时挂载，同一 `moduleId` 的多个版本不能同时占用同一 Host 目标目录。

## 本机私有配置

登记信息写入 Git 忽略的 `.runtime/admin-plugins.json`，文件权限为 `0600`。每项只保存：

- Hub 自己生成的登记 ID；
- 产品 Git 根目录；
- `manifest.json` 相对产品根目录的路径；
- 创建时间。

仓库提供 [`config/admin-plugins.sample.json`](../config/admin-plugins.sample.json)。复制为
`.runtime/admin-plugins.json` 后，相对路径以 Hub 根目录解析，便于同级 Phoenix 工作区直接参考；
不存在的示例插件应删除。该文件只建立登记，不创建 symlink。sample 保留空的 `operations: {}`
说明运行时节点；操作记录与链接状态由 Hub 在用户显式执行“开发挂载 / 开发卸载 / 修改目录”后
自动维护，不应由用户或 AI 预填为成功。插件运行健康、实体聚合、Pah lifecycle 和品牌安全状态由
Phoenix Admin Host 在自身启动时判断，不写回该 Hub 文件。

其中 Open Issue 条目作为开发挂载示例：复制登记后，在 View 中选择对应插件并点击
“开发挂载”，或调用 `POST /api/admin-plugins/<plugin-id>/mount`。必须由 Hub 后端完成实时身份检查和
symlink/marker 写入；不能通过修改 JSON 把插件标成 mounted。

新登记还保存 `moduleId`、插件名和 manifest 版本的身份快照；它们只用于旧 worktree 不可用时
安全展示并核验“重新指向”，不替代对新目录的实时 inspect。已有旧格式登记保持兼容：旧目录
仍可访问时会从 manifest 取得身份；若旧目录和身份快照都不可用，Hub 会拒绝猜测 moduleId。

工作区设置只保存 Admin Vue/Node 根目录和对应服务 ID。日常开发 View 不接收数据库连接、
访问令牌、备份路径或初始化参数；这些内容由开发者在 Hub 之外处理。

当前数据规模小、配置需要能被人工检查，也不存在多进程并发写入，因此继续使用原子写入的
JSON。若以后出现大量组合、跨工作区关系和并发事务需求，再迁移 SQLite。

## 插件识别

选择产品根目录或 `packages/admin-plugin` 目录后，后端会重新检查：

1. 所选目录属于 Git 仓库，并记录当前 source commit；
2. 存在 Admin Plugin Manifest `formatVersion=2`；
3. `moduleId` 与 `vue/<moduleId>/config.ts`、`midway/<moduleId>/config.ts` 一致；
4. Vue/Node 模块源目录和入口文件真实存在；
5. DDL migration ID、version、SHA-256 checksum 和 `migrations/*.sql` 路径安全；
6. 包含 DDL 时存在 `pah-plugin.artifacts.json`；
7. 业务导航使用 `pah-group-business`，菜单由 manifest + Pah lifecycle 物化。

不符合第 7 项的插件仍可加入列表以便查看和开发卸载，但会显示策略警告并禁止新的开发挂载。
Hub 不生成产品菜单映射，也不按 Issue、Function、BOM 产品名添加特判。

## status / mount / unmount

每个插件详情实时显示两条挂载：

| 类型 | 源目录 | Host 目标 |
|---|---|---|
| Vue | `<pluginRoot>/vue/<moduleId>` | `<adminWebRoot>/src/modules/<moduleId>` |
| Node | `<pluginRoot>/midway/<moduleId>` | `<adminNodeRoot>/src/modules/<moduleId>` |

状态检查同时展示 source、target、symlink 值、Host `.git/info/exclude` 路径和精确排除规则。

“开发挂载”只执行以下操作：

1. 预检两个 Host 都是精确 Git 根目录；
2. 预检两个源目录、目标路径和现有 symlink 身份；
3. 拒绝覆盖实体目录、文件和指向其他版本的外来链接；
4. 创建两个相对 symlink；
5. 在两个 Host 的 `.git/info/exclude` 写入该 `moduleId` 的受控 Git exclude marker；
6. 记录最近一次操作的每条变化。

Hub 不调用 Admin Node 的实体生成器，也不生成第二份插件身份 marker。Node 的标准
`dev`、`typecheck` 和 `build` 命令会在编译前扫描实际 `src/modules/<moduleId>` 并原子重建
`src/entities.plugin.ts`；Web/API 各自在启动时完成插件快速点检和故障隔离。这样直接运行标准命令、
经 Hub 启动和正式装配使用同一 Host 规则。

“开发卸载”只移除身份重新核验后、确实指向当前插件源目录的 symlink 和对应 marker。
它不是 Pah 的业务卸载，不删除产品目录、数据库、迁移台账、菜单或业务数据。损坏、嵌套、
孤立、未闭合 marker，实体目标和外来链接都会阻止操作；不存在广域删除或按名称清理。

## 修改插件开发目录

插件切换到新产品目录或 worktree 后，详情页“修改目录”通过
`PATCH /api/admin-plugins/:id` 更新原登记，不需要先卸载、移除或手工编辑 JSON。流程先对新目录
执行完整 inspect，并要求新旧 `moduleId` 完全一致；DDL 原始字节 checksum、artifacts 的
module/version 及 runtime artifact 路径、size/SHA 也必须有效。

Vue/Node Host 目标只接受三种预检状态：仍指向旧登记源、已经指向本次新源、尚未创建。第二种
会被明确记录为 `claimed-link`，用于解决手工开发链接已经切换后旧条目报 `foreign-link 409` 的
场景。实体目录/文件、第三方链接、重复登记路径、损坏 marker 或插件源落入 Host 仓库都拒绝。

两条链接、两个 Git exclude marker 和本机登记作为一次受控操作更新。中途失败会恢复原链接、
exclude 与登记；若自动回滚本身不完整，API 返回 `ADMIN_PLUGIN_REPOINT_ROLLBACK_FAILED`，要求
先停止 Admin Host，再按 details 精确复核，不会把部分成功伪装成完成。

旧产品目录不存在或 manifest 已损坏时，列表仍显示登记身份、旧路径和 `sourceError`，普通开发
挂载/卸载会 fail-closed；登记已有 moduleId 身份快照时可选择同模块有效目录恢复。早期登记没有
身份快照时，只有至少一个 Host 旧链接仍精确指向旧源码、且 Vue/Node 两端 Git marker 都完全匹配
新 Manifest 的 moduleId，Hub 才恢复身份并修改目录；否则拒绝根据登记 ID 猜测。
该动作始终只属于开发装配，不执行 Pah register/install/enable、DDL、数据库、菜单或权限改动。

## 启动与核验

“启动 Admin Host”按 Admin API → Admin Web 顺序调用现有受控服务管理器。Development API
只在 Admin Node 根目录执行 `pnpm dev`，不会附加数据库、初始化或测试工具环境。已经运行或由外部
管理的 Host 不会重复启动；端口冲突继续使用服务管理器原有边界。按钮不会启动插件本身。

“装配核验”输出：

- 每个插件的 source commit、Manifest version 与挂载状态；
- Admin API/Web 的 lifecycle、health、ownership 与端口；
- Manifest 声明的全部前端路由 HTTP 2xx 结果；
- Manifest 声明摘要。

该结果固定标记为“开发装配核验（非完整 verify）”，不能表示产品迁移完成。Dev Hub 会分别
列出 Host-owned 与 plugin-owned 的 lint、typecheck、test、build 门禁；未取得真实命令、
扫描根、是否跟随 symlink 和工具排除配置时统一显示“未记录”，不猜测通过。

`.git/info/exclude` 只避免开发 symlink 污染 Git 状态，不会阻止 ESLint、TypeScript、测试器
或构建器穿透链接。Host 工具穿透产品链接时，只能使用 Host 通用作用域/显式边界或独立实体
装配；不得从 Host 侧 `--fix` 产品源码。产品格式问题退回产品仓，同时仍须通过插件自身 lint
以及冻结 production 装配的完整类型检查和构建。

当前三插件点检至少包含：

- `/open-issue/dashboard`；
- `/function-develop/catalog`；
- `/bom-studio/boms`。

数据库初始化、迁移、seed、Pah register/install/enable、实体聚合、品牌安全审查与权限变更都不属于
这个开发 View；Hub 只负责检查候选包的装配元数据、修改开发目录、管理 Vue/Node symlink，以及
启动/监控 Host。插件运行状态以 Host 返回的 `ready`、`action-required` 或 `quarantined` 为准。

## 退出与恢复

1. 停止 Admin Host Web/API；
2. 对每个插件执行“开发卸载”；
3. 确认两个 Host 的目标 symlink 和 marker 已移除；
4. 重新启动稳定 Admin Host；
5. 再次运行组合核验。

## 用户点检

- [x] “系统 → Admin 工具 → Admin 插件”可打开独立 View；
- [x] 左侧能识别插件名、moduleId、版本和策略警告；
- [x] Issue、Function、BOM 可同时出现，不影响“全部网站”的旧独立服务；
- [x] Hub 与 Admin Host 都能看到实际插件挂载；
- [x] 详情显示 Vue/Node 的 source、target、symlink、Git exclude 和状态；
- [x] 开发挂载/卸载明细清楚，开发卸载不会删除业务数据；
- [x] 自动化验证实体目录、外来链接和损坏 marker 无法被覆盖或删除；
- [ ] 用户确认“装配核验（非完整 verify）”与 Host/plugin 门禁阻断显示清楚；
- [x] “启动 Admin Host”不会把插件当进程启动；
- [x] 核验显示 source commit、manifest version、Host 端口和路由结果；
- [x] DDL 只有 dry-run，没有 SQL 执行、synchronize 或备份绕过入口；
- [x] 刷新后插件列表仍在，本机配置未进入 Git。

路由 HTTP 200 只证明 Host 可达和前端入口存在，不代表对应产品的真实功能迁移已经完成。
Function、BOM 后续迁移仍由各产品任务独立验收。
