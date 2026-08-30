# Phoenix Dev Hub

当前版本：**0.4.2**

Phoenix Dev Hub 是 Phoenix 工作区内开发服务的本机控制台。它用一个 Node 进程、一个端口同时提供 Web 工作台和控制 API，不再要求记住每个仓库的启动命令与端口。

## 项目仓库

- Gitee（`gitee`）：[phoenixwing/phoenix-dev-hub](https://gitee.com/phoenixwing/phoenix-dev-hub)
- GitHub（`github`）：[phoenixwing-org/phoenix-dev-hub](https://github.com/phoenixwing-org/phoenix-dev-hub)

提交前可用 `git remote -v` 核对两个正式远端；默认远端仍是 Gitee 的 `origin`，不会自动向 GitHub 推送。

```text
http://127.0.0.1:42100
├─ Wing 0.7.1 Web 工作台
├─ /api/services：探测、启动、停止、重启
├─ /api/services/:id/logs：按 generation/cursor 增量读取最近日志
├─ /api/services/:id/terminal：打开本机系统终端
├─ /api/hub：Hub 设置、固定目录终端与安全关闭
├─ /api/admin-plugins：Admin 插件开发工作区
└─ 开发期 Vite middleware / 生产期 dist 静态文件
```

## 当前能力

- 仓库只归档 `config/sample/services.sample.json`；本机完整清单使用 Git 忽略的 `config/services.user.json`。启动/停止接口只接收稳定服务 ID，不接受浏览器临时拼接命令、参数或工作目录。
- 生命周期（`starting/running/stopping/stopped/external/conflict`）、健康度（`ready/reachable/partial/unhealthy/unknown`）和 ownership 分开报告；“端口可达”表示未配置业务健康路径，“部分就绪”表示多端点中确有未就绪项，两者都不影响停止 Hub 自己拥有的进程。
- 端口监听只是一项信号。显式非根 `healthUrl` 必须返回 HTTP 2xx 才算健康；未配置时明确报告“端口可达/健康路径未配置”，历史配置若把返回 404 的源站根路径 `/` 当作健康地址，也会降级为“未发现可用健康路径”，不会猜成启动失败或把端口监听冒充业务健康。可选 JSON `identity` 可以同时核验服务名、版本等稳定字段。
- Hub-owned 进程的构建状态独立取自当前 stdout/stderr。明确的 TypeScript/build 失败会把健康度降为 `unhealthy`；即使旧 listener 仍返回 HTTP 2xx，也会显示“端口健康但当前构建失败”。watch 后续明确构建成功后才恢复端点健康判定。
- Hub 启动服务后记录随机 ownership ID、根 PID、PGID、会话、稳定启动时间、TTY、实际命令、cwd 和配置端口。每次发信号前都重新核验，防止陈旧 PID 与 PID 复用。
- Hub-owned 服务使用独立进程组；停止时向已复核的精确 PGID 发送 `SIGTERM`，限时等待全部成员和端口退出。界面操作超时后必须再次确认才发送 `SIGKILL`；Hub 自身关闭时只会在 ownership 再次复核通过后升级。
- 已占用端口若 cwd、可选身份字段和健康检查匹配，标记为“外部监控”并拒绝重复启动；身份不符或完全不健康时标记“端口冲突”，不能一键误杀。
- 外部进程默认不可停止；清单允许时，第一次操作只返回一次性确认令牌和 PID/PGID/命令/cwd/端口影响范围。确认期间任何 PID、启动时间、组成员或端口换主都会取消操作；强制终止还需要单独确认。不存在按名称 `pkill`。
- 运行日志按服务生成独立 Tab。Hub-owned 服务持续捕获 stdout/stderr；外部监控没有 stdout 或显式日志文件来源时明确显示“仅健康监控，进程日志不可用”。
- 日志仍保留原始 stdout/stderr 来源；明确的 `Warning`、`DeprecationWarning`、Browserslist/caniuse-lite 等警告以黄色显示，其他 stderr 继续按错误显示。
- 最近 500 行只保存在内存中；界面分别标注当前显示条数、服务端保留条数/容量和本 generation 累计条数。“清空本次会话日志”会在服务端建立新 generation，旧 cursor、后续轮询或重连均不会回填旧 500 行，新日志仍可继续追加。
- “打开系统终端”与运行日志相互独立：仅在本机桌面会话中打开到服务目录的 macOS Terminal、Windows PowerShell/CMD 或 Linux 桌面终端，不自动执行命令；远程、SSH、容器及无桌面环境禁用。
- “系统 → Dev Hub → Hub 设置”管理 Hub 自身：显示版本、地址与终端能力，可打开固定项目目录终端，并在二次确认后安全停止 Hub-owned 服务再关闭 Hub；其中“Phoenix Admin 开发支持”统一显示和编辑插件开发 Host 的 Vue/Node 根目录及服务 ID。没有 launchd/systemd/Docker 等外部 supervisor 时不提供会误导的假重启按钮。
- Wing 工作台支持 Ribbon / Tree、三种 Ribbon 外观、Primary、Bottom 运行日志与 Footer；服务 Properties 位于左侧 Primary 的模块列表下方，默认不启用 Secondary。
- 工作台首次打开跟随系统浅色/深色模式；Series 与 Profile 始终遵循配置建议顺序，实例内服务首次默认按名称排序。显示偏好、服务搜索词和排序方式由 Pinia Store 持有并写入本机存储，用户切换后刷新仍保持选择。
- 导航只有“网站”和“系统”两个大分组；网站下面一套网站一个模块，同一模块可以包含 Web、API 等多个受控进程。
- Series 可以包含多个隔离 Profile。示例中的 Phoenix Admin 提供“开发联调”（source-mounted / DEV ONLY，9000/8101）和“发布验收环境（非正式）”（package-assembled / Registry Wing，9100/8201）两套实例，可并行独立启停、重启、打开和查看日志。
- 示例另提供独立“Cool Admin Midway 4”组：纯 Cool Vue 8.x 使用 9200，纯 Cool Node 8.x / Midway 4 使用 8001 和精确命名的本机 PostgreSQL 联调库。它不装载 Phoenix、Wing、Pah 或业务插件；右侧 Properties 显示源码基线与人工联调帮助。
- Profile 的 `environmentKind` 支持 `development/release-validation/preproduction/production`。非开发环境必须从不可变 Pah 业务包装配；production 默认只读，Hub 不提供会假装成功的启动、停止、重启、迁移或导入入口。
- 发布包装配只写 `.runtime/assemblies`，启动前复核包 SHA/integrity、clean Host commit、隔离数据库、离线 frozen lock、Registry 精确依赖与 realpath；拒绝 `file:/link:/workspace:`、override、源码 symlink 和相邻仓回退。Hub 不执行 Pah 安装、DDL、建库、seed 或权限变更。
- 默认项目使用 Hub 同级目录的相对路径；“系统 → Dev Hub”下的“服务设置”与“服务总览”并列，集中管理配置，不占用总览的运行操作空间。
- 服务列表与设置 View 明确标记“默认 / 默认·已覆盖 / 已隐藏 / User”。默认服务支持本机编辑、隐藏/显示与一键重置用户配置基线；User 项目支持添加、编辑与只移出 Hub 的删除。
- 默认服务、User 项目可单项或整套导出；整套格式为 version 2，单服务兼容导出和旧配置导入仍支持 version 1，所有导入都会重新经过后端安全校验。
- “系统 → Admin 工具 → Admin 插件”提供独立 Wing View：选择本机产品目录、识别 Admin Plugin Manifest v2、管理 Vue/Node 开发 symlink、展示 Git exclude 与操作明细，并统一启动/核验 Admin Host。插件不会被伪装成可启动网站；详见 [`docs/Admin插件开发工作区.md`](docs/Admin插件开发工作区.md)。
- Admin 插件的“装配核验”只报告 source commit、manifest、挂载、Host lifecycle 与路由，不冒充完整产品 verify。结果分别列出尚未记录/运行的 Host-owned 与 plugin-owned lint/typecheck/test/build；`.git/info/exclude` 只影响 Git，不是工具扫描边界。
- Phoenix Admin Development 的 API 条目只在 Admin Node 目录执行 `pnpm dev`。Hub 不为日常开发启动注入数据库、初始化或测试工具 Profile；插件源码由独立的“Admin 插件”View 选择、修改目录和挂载。

示例清单只保留 Phoenix Admin 开发联调、基于独立 Git worktree 的发布验收、纯 Cool 8.x / Midway 4 联调，以及旧独立 Open Issue 网站。它可以包含公开、可复核的示例 commit 与包 SHA，但不携带任何使用者的绝对路径、真实数据库、凭据或私有运行状态。Function、BOM、DeskTools 等实际项目由使用者写入自己的 `services.user.json` 或通过设置 View 管理。

## 文档索引

- [多版本服务分组与配置模型](docs/服务分组与配置模型.md)
- [Phoenix Admin 插件开发工作区](docs/Admin插件开发工作区.md)
- [Phoenix Admin 双轨开发模式（Windows）](docs/Windows下Phoenix-Admin双轨开发模式.md)
- [Phoenix Admin 开发 Host 设置点检](docs/Admin插件宿主设置点检.md)
- [Admin API 安全启动与 Hub 生命周期点检](docs/Admin-API安全启动与Hub生命周期点检.md)
- [服务健康探测语义点检](docs/服务健康探测语义点检.md)
- [Admin 插件 symlink 扫描边界点检](docs/Admin插件链接扫描边界点检.md)
- [Admin 受控测试工具 Profile 点检](docs/Admin受控测试工具配置档点检.md)
- [Admin 系列多环境 Profile 点检](docs/Admin系列多环境配置档点检.md)
- [后续任务清单](TODO.md)

## Wing 0.7.1 依赖策略

Dev Hub 正式依赖只声明并锁定 npm Registry 的精确版本
`phoenix-wing@0.7.1`。默认开发、类型检查、测试与构建均从安装后的 Registry 包
解析，不自动跟随相邻 Wing 仓库，开发者需要升级时必须主动修改精确版本并重新验证。
Hub 不提供 Wing 本地源码模式；开发服务器、测试与生产构建均只从 Registry 包
解析。不得使用 `link:`、`file:`、`workspace:`、override 或相邻源码回退。

## 开发与构建

安装依赖后，所有命令始终使用锁文件中的 Registry Wing：

```bash
pnpm dev
pnpm typecheck
pnpm test
pnpm build
NODE_ENV=production pnpm start
```

开发与生产均只绑定 `127.0.0.1:42100`。关闭 Dev Hub 时，它会停止本次由自己启动的服务进程组；不会主动停止外部服务。

## `Pdh` 命名惯例

`Pdh` 是 **Phoenix Dev Hub** 的内部前缀，用于一眼区分本项目拥有的产品构件与
Wing、Vue 或通用基础设施：

- Dev Hub 专属 Vue 组件使用 `PdhXxx.vue`，组件名也声明为 `PdhXxx`；
- Dev Hub 专属核心协调类使用 `PdhXxx`，对应 TypeScript 文件也使用
  `PdhXxx.ts`；测试文件沿用 `PdhXxx.test.ts`；
- `App.vue`、`main.ts` 等框架入口，以及 `api.ts`、错误、日志缓冲、端点探测等
  通用技术模块不机械添加前缀；
- HTTP 路径、JSON 字段、配置文件名和共享传输协议保持语义命名，不把 `Pdh`
  扩散到持久化格式；
- `Pnw` 只属于 Phoenix Wing，Dev Hub 内部不得复用该前缀。

新增文件先判断是否为 Dev Hub 独有的可识别产品构件；只有这一类使用 `Pdh`，
避免“所有文件都有前缀”而失去区分价值。

## 配置服务与项目

可归档示例位于 `config/sample/services.sample.json`。首次使用时复制为本机文件并逐项替换示例值：

```bash
cp config/sample/services.sample.json config/services.user.json
```

Hub 不会自动执行 sample；复制后必须复核 `.worktrees`、commit、SHA、integrity、数据库与端口。`services.user.json` 不进入 Git，由使用者与 `.runtime` 一起自行备份。为兼容早期安装，未迁移的 `config/services.json` 仍可读取，但也已受 Git 忽略。加载优先级为 `services.user.json`、旧 `services.json`；两者都不存在时启动会明确提示初始化。每个实际清单项必须包含：

Windows 与 Linux 的完整目录示例、Admin Host worktree 创建、Open Issue / Acme 品牌插件开发挂载流程见
[`docs/本地配置指南.md`](docs/本地配置指南.md)。对应文件为
`config/sample/services.windows.sample.json`、`config/sample/services.linux.sample.json`、
`config/sample/admin-plugins.windows.sample.json` 与 `config/sample/admin-plugins.linux.sample.json`；只复制与当前系统匹配的一套。

已经保存的配置若只是工作目录或发布包路径暂时不存在，Hub 仍会启动并保留对应条目；后端只汇总输出一次警告，网页显示具体配置错误，并在 spawn 前拒绝启动该条目。JSON 结构、服务 ID、端口及安全策略等配置仍按严格规则校验。

Midway 4 sample 中的 `MIDWAY4_DB_USERNAME=replace-me` 必须在用户配置中替换；密码只从 Hub 进程继承的 `MIDWAY4_DB_PASSWORD` 或 `PGPASSWORD` 读取，不写入 sample。该 Profile 仅允许 loopback 和数据库 `cool_admin_midway4_validation`，其中 `synchronize/initDB/initMenu` 只用于纯 Cool 阶段 A 的隔离开发联调，不得指向共享、发布验收或生产数据库。

- 稳定的进程 `id`、显示名称，以及网站 `moduleId` / `moduleName`；
- 已存在的工作目录；
- 一个非 shell executable 与固定参数数组；
- 至少一个固定端口；
- 可选的本机 `openUrl`、显式 HTTP `healthUrl`、端点 `required` 与固定环境变量；没有真实健康路径时省略 `healthUrl`，Hub 只报告端口可达且健康未验证；
- 可选 `identity`：一个本机 JSON URL 及要精确匹配的顶层字符串、数字或布尔字段，可用于服务名与版本门禁；
- 外部停止策略 `deny` 或 `confirm-matching-cwd`。

URL 只允许 `http(s)://127.0.0.1`、`localhost` 或 `::1`。直接配置 `sh`、`bash`、`zsh`、PowerShell 等 shell 会导致 Dev Hub 启动失败。

网页编辑默认服务时不会修改 `config/services.user.json`，而是把差异和隐藏状态写入
Git 忽略的 `.runtime/services.json`。“重置默认”清除这些本机状态并恢复用户基线。
运行配置 version 3 额外记录用户基线 Profile ID；升级时会把新增基线 Profile 合并进旧
version 2 本机覆盖，同时保留原 Profile 的本机目录、端口和数据库差异。
后端会重新验证稳定 ID、工作目录、非 shell 命令、参数、环境变量、固定端口和本机 URL；
运行中的服务必须先停止，才能编辑、隐藏或重置。隐藏只控制该默认服务是否出现在
服务总览，不删除用户配置基线；“显示”可单条恢复。

自定义 Node.js 项目不修改默认清单。后端只接受一个已有的本地目录和该目录
`package.json` 中真实存在的 script，并依据 `packageManager` 或 lockfile 选择
`pnpm`、`npm`、`yarn` 或 `bun`。浏览器不能提交 executable、参数或环境变量。
没有配置固定端口的自定义项目按 Dev Hub 管理的进程状态显示，仍可启动、停止和查看日志。

User 项目保存在 `.runtime/projects.json`；移除不会删除磁盘目录。单独导入旧版
`phoenix-dev-hub-projects` version 1 仍受支持；新的整套格式为 `phoenix-dev-hub-config`
version 2，同时包含 Series/Profile 默认服务、隐藏状态和 User 项目。导入不会删除未包含的配置：
默认服务按稳定 ID 覆盖，User 项目按真实目录更新或新增。JSON 可能包含本机绝对路径，
换机器后应先点检路径。后端不会信任导入文件，仍会重新解析、校验并拒绝不安全配置。

每个服务对应一条受控命令和一个运行日志 Tab。同一网站需要前后端独立控制时，
应使用相同 `moduleId` 配置 Web、API 两个服务；联合启动脚本仍只算一个服务。
系统终端接口只接收服务 ID，工作目录始终来自后端已验证的服务配置，浏览器不能
提交终端路径或要执行的命令。无法由环境变量自动识别的端口转发场景，应以
`PHOENIX_DEV_HUB_REMOTE=1` 启动 Hub，显式禁用系统终端入口。

`config/services.user.json` 以及 `.runtime` 下的 `services.json`、`projects.json`、`admin-plugins.json`
可能包含本机绝对路径或环境身份，均受 Git 忽略，不得提交。它们不属于发布包备份范围；
需要迁移工作台时，由使用者在受控位置自行备份并点检其中的路径。

Admin 插件登记可从公开模板开始：

```bash
mkdir -p .runtime
cp config/sample/admin-plugins.sample.json .runtime/admin-plugins.json
```

模板路径相对 Hub 根目录解析，示例包含 Admin Vue/Node Host 与 Open Issue、Acme 品牌插件两个登记。
复制后应删除本机不存在的条目并核对 `moduleId`。JSON 只负责登记；实际 Vue/Node symlink 与
`.git/info/exclude` marker 必须在“系统 → Admin 工具 → Admin 插件”中检查后点击“开发挂载”创建。
`operations` 在 sample 中保留为空对象，用于说明运行时结构；它是 Hub 自动记录的本机操作历史，
不应预填或伪造成功记录。

sample 中的 Open Issue 是开发挂载示例。也可以由本机自动化在 Hub 启动后调用固定 ID：

```bash
curl -X POST -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:42100/api/admin-plugins/phoenix-open-issue-local/mount
```

后端会重新检查 Manifest、moduleId、源目录、Host 目标、现有链接和 Git exclude marker；存在实体
目录或外来链接时拒绝覆盖。不要由 AI 直接创建链接或手写成功状态。Hub 不生成插件实体或运行健康
状态；这些由 Admin Host 标准启动命令根据实际模块目录完成。

Phoenix Admin Development 的 sample 命令保持为纯 `pnpm dev`，数据库初始化、seed、迁移和插件生命周期
由开发者在 Hub 之外处理。发布验收若需要数据库安全门禁，应使用独立 Profile；真实数据库名、Host commit、
包 SHA、Registry integrity 与路径只允许进入 `services.user.json` 或 `.runtime` 本机配置，连接串、token、
密码和备份路径不得进入 Git。

Admin 开发联调中，Web 使用 `pnpm dev:local` 消费相邻本地 Wing；它是 Admin 提供的
`dev:wing-local` 便捷别名。API 仍使用普通 `pnpm dev`。这不改变 Dev Hub 自身对 Registry
Wing 0.7.1 的锁定。

发布验收管理员重置是独立、操作员显式执行的本机工具，不是普通 start 的副作用：

```bash
pnpm admin:release:reset -- --profile release-validation --username admin
```

它只读取用户配置，要求目标 Profile 已由 Hub 完全停止、端口无监听、secret 位于 `.runtime` 且权限为
`0600`，密码在交互终端输入且不回显。工具先调用 Admin Node 的受控 plan，再执行精确重置；不会在日志、
API 或 Git 中写出密码。

受控测试工具 Resolver 仍保留为独立底层能力，但不再自动关联日常 Admin API 启动条目。历史设计与安全边界见
[`docs/Admin受控测试工具配置档点检.md`](docs/Admin受控测试工具配置档点检.md)。

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/health` | Dev Hub 健康检查 |
| `GET` | `/api/services` | 全部服务状态 |
| `GET` | `/api/host-capabilities` | 查询当前会话能否打开系统终端 |
| `GET` | `/api/hub` | 读取 Hub 版本、地址、固定项目目录与生命周期能力 |
| `POST` | `/api/hub/terminal` | 在后端固定的 Hub 项目目录打开系统终端 |
| `POST` | `/api/hub/shutdown` | 明确二次确认后安全关闭 Hub |
| `GET` | `/api/services/:id` | 单个服务状态 |
| `GET` | `/api/services/:id/logs?after=N&generation=G` | 按 generation/cursor 增量读取日志 |
| `POST` | `/api/services/:id/logs/clear` | 清空本次 Hub 会话日志并建立新 generation |
| `POST` | `/api/services/:id/start` | 执行清单中的固定命令 |
| `POST` | `/api/services/:id/stop` | 请求停止；外部确认与强制终止使用一次性 token |
| `POST` | `/api/services/:id/restart` | 仅重启 Hub-owned 服务；外部或冲突状态 fail-closed |
| `POST` | `/api/services/:id/terminal` | 在本机系统终端中打开服务目录 |
| `GET` | `/api/projects` | 读取本机项目配置及 Hub 同级候选 |
| `POST` | `/api/projects/inspect` | 检查一个本地 Node.js 目录与可用 scripts |
| `POST` | `/api/projects` | 将检查过的 script 写入本机配置并加入启动列表 |
| `PATCH` | `/api/projects/:id` | 编辑已停止的本机项目显示名、目录和 script |
| `DELETE` | `/api/projects/:id` | 将已停止的本机项目移出 Hub，不删除磁盘目录 |
| `GET` | `/api/projects/export` | 导出 version 1 本机项目配置 JSON |
| `POST` | `/api/projects/import` | 重新验证并合并导入的项目配置 |
| `GET` | `/api/service-config` | 读取默认服务基线、本机覆盖与隐藏状态 |
| `PATCH` | `/api/service-config/:id` | 更新已停止默认服务的本机覆盖 |
| `DELETE` | `/api/service-config/:id` | 从总览隐藏已停止的默认服务 |
| `POST` | `/api/service-config/:id` | 在总览单条显示已隐藏的默认服务 |
| `POST` | `/api/service-config/reset` | 清除本机覆盖与隐藏状态，恢复仓库默认 |
| `GET` | `/api/config/export` | 导出 Series/Profile、隐藏状态与 User 项目的整套 version 2 JSON |
| `POST` | `/api/config/import` | 重新验证并合并导入整套配置 |
| `GET` | `/api/admin-plugins` | 读取本机 Admin 插件工作区与实时挂载状态 |
| `POST` | `/api/admin-plugins/inspect` | 检查本机目录是否为 Admin Plugin Manifest v2 插件 |
| `POST` | `/api/admin-plugins` | 将检查过的插件目录加入本机列表 |
| `PATCH` | `/api/admin-plugins/:id` | 校验同一 moduleId 后，受控更新登记目录并替换或认领现有开发链接 |
| `POST` | `/api/admin-plugins/:id/mount` | 安全创建 Vue/Node 开发 symlink 与本机 Git exclude |
| `POST` | `/api/admin-plugins/:id/unmount` | 精确执行开发卸载，不删除业务数据 |
| `POST` | `/api/admin-plugins/host/start` | 按 API → Web 启动或监控 Admin Host |
| `POST` | `/api/admin-plugins/verify` | 装配核验 commit、manifest、挂载、lifecycle、Host 与路由；显式返回未运行的完整门禁 |
| `POST` | `/api/admin-plugins/:id/ddl-dry-run` | 只代理 Admin Node 受控 DDL dry-run |

控制 API 仅接受本机 Host，带 `Origin` 的写请求必须与页面同源。

## 许可与仓库

Phoenix Dev Hub 使用 [Apache License 2.0](LICENSE)。正式仓库为
[gitee.com/phoenixwing/phoenix-dev-hub](https://gitee.com/phoenixwing/phoenix-dev-hub)，旧地址不再作为发布入口。

Copyright © 2024–2026 凤凰之翼（PhoenixWing）贡献者。

## 验证

跨后端、前端与运行验证的功能先在 `docs/` 建立任务/TODO 点检表，记录安全边界、自动门禁、最终运行验证和用户点检；实现过程中逐项勾选，避免只存在于对话中的要求遗漏。

`pnpm test` 覆盖清单门禁、日志 generation/cursor、显式 HTTP 2xx 健康检查、端口可达但健康未配置、根路由 404 兼容降级、非根健康路径 404 失败、构建失败不能被健康端口掩盖、Hub 关闭确认，以及真实临时进程的 ownership、无 TTY、watch 子进程重生、部分健康、外部监控、端口换主、冲突禁停、强制终止二次确认、幂等停止和“不得误杀其他进程组”。端口生命周期测试只在 `127.0.0.1` 随机端口运行仓内 fixture。
