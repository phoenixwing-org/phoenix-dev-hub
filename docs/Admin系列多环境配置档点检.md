# Admin 系列多环境 Profile 点检

状态：Hub 0.3.0 通用能力与自动验证收口；具体发布实例属于用户本机配置

## 输入与保护清单

- [x] Node/Vue Host 使用各自独立的 clean Git worktree 与 40 位精确 commit，只读输入；
- [x] 业务包使用精确 moduleId/version/SHA-256，真实路径与哈希仅写 `services.user.json`；
- [x] 包类型为声明式 `pah-business-module`，不得交给 COOL `/helper/plugins` Hook 安装器；
- [x] `services.user.json` 与 `.runtime/services.json` 的数据库、路径和覆盖属于用户本机状态，均不归档；
- [x] 不新增 Host worktree；解包、依赖物化和运行缓存只能写入 Hub `.runtime` 下的独立 assembly/runtime；
- [x] 普通 start 不自动创建数据库；Hub 永不建表、恢复、执行产品 DDL、seed、迁移、导入或权限变更。隔离库创建是单独的显式确认动作。

## 通用 Profile schema

- [x] `environmentKind` 支持 `development/release-validation/preproduction/production`；
- [x] `deploymentMode` 区分 `source-mounted/package-assembled`；
- [x] development 可显式标记 source-mounted/dev-only，证据不得计作发布验收；
- [x] release-validation/preproduction/production 禁止源码挂载与本地 Wing；
- [x] production 默认只读，启动/停止/重启写操作 fail-closed；未来写操作必须另有 capability、维护窗口、可信备份、二次确认与审计；
- [x] Profile 明确数据库环境变量与唯一数据库名；禁止开发、验收、预生产、生产串库；
- [x] 可并行 Profile 使用不同 runtime slot、端口、cwd、assembly root 与日志 ownership；
- [x] 同一可并行 Series 中端口、数据库、cwd、assembly 路径冲突在加载或启动前明确拒绝并指出对象。

## 发布包离线装配与启动前门禁

- [x] 校验 clean Host 精确 commit 且不修改输入 worktree；
- [x] 校验包 SHA、`kind=pah-business-module`、Profile 冻结 moduleId/version、manifest 身份、全文件 integrity 与无 Hook 入口；
- [x] 以 Git archive 将 clean Host 物化到新且为空的 assembly，no-replace，失败清理半成品；
- [x] 只把包声明的 Node/Vue payload 复制到 Host 对应模块目录，拒绝覆盖、symlink、路径逃逸；
- [x] 依赖只允许离线 frozen lock 安装到 assembly，禁止 lifecycle scripts 与联网；
- [x] 扫描 package、pnpm lock/workspace/config，拒绝 `file:/link:/workspace:`、插件或嵌套 override、本地路径与相邻仓回退；clean Host 根目录已归档的 override/patch 只在精确提交内接受，并校验 patch 为 Host 内普通文件；
- [x] Registry 包校验名称、精确版本、lock integrity、实际 realpath 位于 assembly；
- [x] 发布验收 Wing 使用用户配置冻结的 Registry 精确版本，状态展示版本、integrity/lock/realpath 证据；
- [x] 校验 `assembly-evidence.json` 与当前配置、包、Host、数据库、Registry 证据完全一致；
- [x] Hub 重启后可从 assembly evidence 与监听进程 cwd 恢复为明确的 stopped/external 状态。
- [x] PostgreSQL spawn 前先区分 missing、uninitialized、ready、unavailable；缺库或缺 Host/Pah 基线时不生成 keepalive 进程；
- [x] `requiredRelations` 只接受精确安全 SQL 标识符，并在状态卡显示安全摘要；`provisional` 不放行，只有 `versioned-manifest` 可作为启动门禁真源。

## 当前 Admin Series

- [x] `Admin 开发联调`：Vue 9000 / Node 8101，当前开发库、源码插件挂载与 HMR，显著标记 dev-only；
- [x] `Admin 发布验收环境（非正式）`：示例使用 Vue 9100 / Node 8201、独立数据库、独立 worktree Host，只消费冻结 `.pah.cool` 与 Registry Wing；
- [x] UI 以黄色“发布验收 · 非正式”徽标区分正式生产与预生产环境；
- [x] 两个 Profile 可独立启动、停止、重启、打开、查看日志，默认可并行；
- [x] 前端各自代理到自己的 Node，进程组、PID、cwd、端口、环境、日志、数据库与插件装配目录隔离；
- [x] Profile 级按 Node → Vue 启动、Vue → Node 停止；单实例失败不自动停止另一个实例；
- [x] UI 系列列表显示一个 Phoenix Admin Series、两个独立 Profile 与各自环境/装配身份。

实际插件发布候选需要同时证明“全新安装”和“可信恢复”时，应采用两个独立的
`release-validation` / `package-assembled` Profile。两者可共享同一不可变包与 clean Host 输入，
但数据库、端口、runtime slot、assembly root 和 evidence 必须完全隔离。详细契约与执行顺序见
[`Admin插件安装与恢复双Profile验收.md`](Admin插件安装与恢复双Profile验收.md)。

## 自动验证与手工点检

- [x] 配置解析、旧 v2 本机覆盖合并新基线 Profile、冲突与 production 拒绝测试；
- [x] 包 SHA/kind/integrity、Host commit、依赖协议、Wing Registry/realpath、evidence 失败测试；
- [x] 双 Profile 并行生命周期、独立 PID/PGID/cwd/端口/日志、重启与 Hub 重建 manager 后外部状态测试；
- [x] UI/API 类型检查、单元测试、production build 与 `pnpm verify` 纳入发布门禁；
- [x] 真实包装配只写 `.runtime`，输入 Host 保持 clean；
- [x] Hub 显式隔离库动作记录 existing=false→true、0600 证据与受控回收责任；普通 start 无建库副作用；
- [x] 中文本地提交，不 push。

## 手工点检

1. 核对 `requiredRelationsStatus=versioned-manifest`，清单与所选 Admin Node Host 真源一致；Hub 不猜表、不建表。
2. 打开“网站 → Phoenix Admin”，核对“Admin 开发联调”和“Admin 发布验收环境（非正式）”两张实例卡。
3. 先启动开发联调，再启动发布验收；确认 9000/8101 与 9100/8201 同时监听，前端分别访问自己的 API。
4. 分别执行打开、日志、重启、停止；确认另一实例的 PID/PGID、端口和日志 generation 不变。
5. 重启 Hub；已运行服务应恢复为 `external/monitoring-only`，停止的服务保持 `stopped`，package evidence 仍为 verified。
6. 故意复用端口、数据库名、cwd 或 assembly root 的配置应在保存/加载时失败并指出冲突双方；不要对真实生产库做此试验。

## 残余限制

- production 本轮只冻结 schema、红色标识、只读状态与安全拒绝；不实现生产生命周期、迁移或数据写入 capability；
- Hub 只负责开发装配、离线物化、证据校验和进程生命周期；Pah 数据生命周期仍由独立受控流程负责。
