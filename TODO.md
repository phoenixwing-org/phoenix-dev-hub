# Phoenix Dev Hub TODO

状态：当前开发清单

## Wing 0.6.0 基线

- [x] Dev Hub Web 工作台的目标依赖固定为 `phoenix-wing@0.6.0`，不跟随 Wing 的 `develop` 分支。
- [x] 默认开发、类型检查、测试与构建使用 Registry 依赖；Hub 不自动跟随 Wing 升级，开发者必须主动更新精确版本。
- [x] Hub 不提供 Wing 本地源码模式，开发服务器、测试和生产构建只从 Registry 包解析。
- [x] 未使用 `pnpm link`、`file:`、`workspace:` 或 override，也没有相邻源码静默回退。
- [x] 使用 Registry `phoenix-wing@0.6.0` 生成干净锁文件，并完成正式依赖门禁、测试、类型检查与生产构建。

## Dev Hub 本机控制层

- [x] Dev Hub 自身只运行一个本机进程、一个端口：同一 Node 服务同时提供控制 API 与 Web 界面；开发期使用 Vite middleware，发布期提供构建后的静态资源。
- [x] 控制 API 与 Web UI 同源，不单独启动前端 dev server、后端 API server 或代理服务；固定为 `127.0.0.1:42100`。
- [x] 建立受控服务清单：名称、工作目录、允许的启动命令、端口、健康检查 URL 与打开地址。
- [x] 只允许执行清单中的启动命令；不提供任意 shell 命令执行入口，并拒绝清单直接使用 shell executable。
- [x] 显示已启动服务、端口、PID、健康状态与最近日志；区分“Dev Hub 启动”和“外部已启动”。
- [x] 停止操作仅作用于 Dev Hub 记录的进程组，或经二次确认且工作目录匹配清单的外部监听进程。
- [x] Dev Hub 只绑定 `127.0.0.1`；控制 API 校验本机 Host 与写请求 Origin，不暴露到局域网。
- [x] 以项目为主配置：默认项目使用 Hub 同级相对路径，自定义项目由后端写入未归档的 `.runtime/projects.json`。
- [x] 支持选择 Hub 同级 Node.js 项目或检查其他本机目录，从真实 `package.json` script 生成受控命令并加入启动列表。
- [x] 本机自定义项目支持编辑、移除、单项/整套 JSON 导入导出；默认服务支持本机覆盖、显示/隐藏、单条恢复和重置用户配置基线。
- [ ] 为 User 项目补充可选固定端口与健康检查配置。

### 进程确认与 ownership 恢复

实施与点检清单见 [`docs/TASK-PROCESS-CONFIRMATION-AND-OWNERSHIP-RECOVERY.md`](docs/TASK-PROCESS-CONFIRMATION-AND-OWNERSHIP-RECOVERY.md)。

- [x] 用可滚动、可选择和可复制详情的应用内对话框替代外部停止/强制终止原生确认。
- [x] 安全持久化 Hub-owned 根进程身份，并在 Hub 重启后经完整复核恢复 ownership。
- [x] 恢复 ownership 不伪造日志管道或构建结果，陈旧记录必须 fail-closed。

## Phoenix Admin 插件开发工作区

设计、边界与点检清单见 [`docs/ADMIN-PLUGIN-DEVELOPMENT.md`](docs/ADMIN-PLUGIN-DEVELOPMENT.md)。

- [x] 在“系统 → Admin 工具”提供独立“Admin 插件” Wing View，不把插件注册为网站或服务。
- [x] 支持选择目录、识别 Manifest v2、登记多个版本，并显示 Issue、Function、BOM 等通用插件列表。
- [x] 实时显示 Vue/Node source、Host target、symlink、Git exclude、source commit 与操作明细。
- [x] 提供安全开发挂载/卸载；拒绝实体目录、外来链接和损坏 marker，不删除产品或业务数据。
- [x] 统一启动 Admin Host，并核验 manifest version、lifecycle、端口与声明路由。
- [x] DDL 只代理 Admin Node 受控 dry-run；不执行 SQL、不接收发布证明、不启用 synchronize。
- [x] 本机配置与 PostgreSQL env 路径写入 `.runtime`；连接串、token、备份路径不进入 Git。

## P0：Admin 受控测试工具 Profile

实施输入与解锁条件见 [`docs/TASK-CONTROLLED-TOOL-PROFILE.md`](docs/TASK-CONTROLLED-TOOL-PROFILE.md)。

- [x] 已登记 Owner 锁定的 Resolver、Profile、保留环境注入、unavailable 与 fail-closed 边界。
- [x] 排队登记阶段只记录文档，没有影响 Open Issue P0 访问窗口或运行服务。
- [x] Driver 矩阵已关闭，且总控已明确解锁 Provider 实施。
- [x] 已实现通用 `PdhControlledToolProfileResolver` 与 `PdhServiceManager` 内部 `runtimeEnvProvider`。
- [x] 安全、环境合并、无 PATH/联网、外部监控不注入与其他服务回归门禁通过。
- [ ] 等待总控安排 Admin API 受控重启与产品 consumer fail-closed 实证。

## Dev Hub 自身关闭与重启入口

- [x] 在“系统 → Dev Hub → Hub 设置”提供二次确认的关闭入口；远程、SSH、容器及无桌面环境禁用系统终端能力。
- [x] “打开 Hub 终端”与“关闭 Hub”分离；终端只打开固定项目目录，不自动执行命令，响应发送后再异步关闭。
- [x] 明确没有 supervisor 时不提供假重启按钮；页面提示先打开 Hub 终端，再关闭并手工运行 `pnpm dev`。
- [x] 关闭期间只停止身份复核通过的 Hub-owned 服务，不主动停止外部监控服务；重复关闭请求保持幂等。
- [x] 覆盖终端固定目录、终端不可用、确认拒绝、响应后关闭与不得接收浏览器路径/命令。
- [ ] 未来若接入 launchd/systemd/Docker supervisor，再单独增加可证明的自动重启 capability 与 launcher ownership 门禁。

## 多版本服务分组

设计与实现记录见 [`docs/SERVICE-PROFILE-DESIGN.md`](docs/SERVICE-PROFILE-DESIGN.md)。

- [x] 定义 Series → Profile → Service 的 version 2 配置与 version 1 兼容迁移。
- [x] 在现有服务表外增加可折叠的二级分组树，并持久化折叠、搜索与排序偏好。
- [x] 使用公共模板与 Profile 覆盖项表达稳定版、本地开发版等大部分相同的配置。
- [x] 将配置模态窗口升级为“表单 / JSON / 最终配置”。
- [x] 实现 `runtimeSlot` 互斥预检、Profile 批量生命周期和安全版本切换。
- [ ] 增加字段级“恢复继承”、按需 JSON 编辑器和导入差异预览。

## 发布验收数据库门禁

- [x] 普通 start 在 spawn 前只读区分数据库 missing、uninitialized、ready、unavailable，失败不进入 keepalive 重拉。
- [x] 隔离库创建使用独立显式确认动作，限制 release-validation、本机地址、精确 allowlist、existing=false，并写 0600 回收责任证据。
- [x] `requiredRelations` 使用安全 SQL 标识符白名单；provisional 不放行，versioned-manifest 才可作为 Host 启动真源。
- [x] 用户实际路径、数据库、Host commit 与发布包证据迁入 Git 忽略的 `services.user.json`；仓库只保留去敏 sample。

## Web 工作台接入

- [x] 用 `PnwActivityBar` 的同一导航树呈现 Ribbon 与目录树两种模式。
- [x] 使用 `PnwRibbon` 的三种显示模式、尺寸与分组标签配置。
- [x] 将服务列表放在 Editor；Primary/Secondary 按 View contribution 显示；服务日志使用与 Editor 对齐的 Bottom Panel。
- [x] Footer 使用 Primary、Bottom、Secondary 三个仅图标开关；无 contribution 时隐藏对应图标。

## 后续升级原则

- [ ] Wing 后续发布新版本时，由 Dev Hub 开发者主动修改精确版本、更新锁文件并完整复跑 `pnpm verify`；Hub 不实时跟踪 Wing 开发分支。
