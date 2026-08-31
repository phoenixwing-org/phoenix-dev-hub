# Admin 插件安装与恢复双 Profile 验收

## 目的

同一个不可变 Phoenix Admin 插件包应在两个独立的 `release-validation` /
`package-assembled` Profile 中完成发布验收：

- **安装验证**：从精确空库建立 Host 基线，再执行插件 register、verify、dry-run、install、enable、restart；
- **恢复验证**：使用另一精确空库验证可信备份、恢复和恢复后的插件状态，不复用安装验证数据库。

这两个 Profile 是同一候选包的两条证据链，不是开发挂载，也不属于正式生产环境。

## 可共享与必须隔离的输入

可以共享且必须逐字一致：

- 插件 `moduleId`、版本、不可变包路径和 SHA-256；
- clean Node/Vue Host 的绝对根目录和 40 位提交；
- Registry 依赖的名称、精确版本和 integrity；
- Host baseline 的版本化 `requiredRelations` 清单。

必须隔离：

- `profileId`、`runtimeSlot` 和服务 ID；
- Web/API 端口；
- 数据库名和单元素 `allowedDatabaseNames`；
- assembly output root、运行日志和 ownership；
- 建库 evidence、备份 evidence、恢复 evidence 和最终回收记录。

任一数据库名必须把另一验收库和共享开发、预生产、生产库列入 `forbiddenNames`。不得使用
`phoenix_admin` 等共享库，也不得通过 TypeORM `synchronize`、Cool initialize、产品脚本或手工
ledger 写入绕过 Pah 生命周期。

## Profile 冻结规则

两个 Profile 均须满足：

1. `environmentKind=release-validation`；
2. `deploymentMode=package-assembled`；
3. PostgreSQL 只允许 loopback，并以 `postgres` 等 maintenance database 做只读 preflight；
4. `requiredRelationsStatus=versioned-manifest`，清单逐字取自冻结 Admin Node
   `host-baseline.json`，不得手写子集；
5. `creation.allowedDatabaseNames` 只包含当前 Profile 的精确数据库名；
6. `PAH_DB_SYNCHRONIZE=false`、`PAH_DB_INITIALIZE=false`；
7. package assembly 只写 Hub `.runtime/assemblies/<profile>`，不修改 Host 输入工作树；
8. package metadata 的 Host peer range 必须包含冻结 Host 的真实版本。源码 typecheck 不能替代
   不可变包的兼容性验包。

Hub 写入的数据库创建 evidence 位于 `.runtime/database-evidence/`，临时文件和最终文件均为
`0600`；assembly evidence 同样为 `0600` 且采用 no-replace。evidence 不保存数据库密码、登录
密码或连接串。

## 状态机与操作边界

```text
configured
  -> database-missing
  -> operator-confirmed-create
  -> database-empty
  -> host-baseline-ready
  -> package-assembled
  -> register / verify / dry-run
  -> install / enable / restart
  -> install-verified | restore-verified
  -> stopped
  -> operator-controlled-cleanup
```

- 普通“启动”只允许在数据库 preflight 和 package assembly 均 ready 后派生进程；不自动建库、
  建表、seed、安装插件或恢复备份。
- Hub 的“创建隔离数据库”要求精确确认文本
  `create-release-validation-database:<database>`；创建前后都重新检查存在性。
- Host 空库基线由冻结 Admin Node 的 `pnpm host:baseline` 执行 plan → apply → verify；插件不拥有
  Host 基线，Hub 不执行产品 DDL。
- 插件 migration、dry-run、事务、安装 ledger、菜单/Ribbon/字典贡献由 Pah Node 权威执行；Vue
  只展示状态与触发受控 API。
- 恢复演练必须使用独立数据库和可信备份证据。不得把安装库 dump 直接覆盖共享环境。
- Hub 当前记录精确回收责任，但不自动删除数据库；最终回收由本机操作者在服务完全停止后按
  精确库名执行，不能把“停止服务”误当成“数据库已删除”。

## 安全执行顺序

1. 检查两个 Profile 均能被配置解析，端口无监听，目标数据库均为 `missing`。
2. 检查 Node/Vue Host clean 且 HEAD 等于 Profile 冻结提交；检查包 SHA、来源提交、
   `sourceDirty=false` 和 Host peer range。
3. 由操作者分别确认创建两个空数据库；核对两份 `0600` creation evidence。
4. 分别对两个数据库执行 Host baseline plan → apply → verify；需要登录时再使用一次性管理员
   seed，凭据只保存在 Hub `.runtime` 的 `0600` secret 中。
5. 先完成安装验证；其 register → verify → dry-run 必须是只读/计划阶段，成功后才允许
   install → enable → restart。
6. 在恢复 Profile 中执行可信备份与恢复演练，复核数据库结构、插件版本、migration ledger、
   contribution 数量、可见路由和 Ribbon 投影。
7. 停止两组服务，保存证据；由操作者分别回收两个精确数据库和 assembly/runtime，不触碰共享库。

## 硬门禁

- 两个 Profile 配置解析无错误，且端口、数据库、cwd、assembly root 冲突均 fail-closed；
- package SHA、manifest/integrity、Host commit、Registry realpath 和 peer range 任一不匹配即阻断；
- 数据库缺失或缺少 versioned Host baseline 时不启动 API/Web；
- install/restore 证据不得混用，所有 evidence 与 secret 权限必须为 `0600`；
- 未完成 dry-run、可信备份/恢复要求或 migration 校验时不得执行安装；
- 一个 Profile 的失败、停止或回收不得改变另一个 Profile、共享 Admin 或其他插件状态。
