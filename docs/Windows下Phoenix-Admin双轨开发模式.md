# Windows 下 Phoenix Admin 双轨开发模式

本文是给开发者和 AI 的 Windows 可复现归档，以 `E:\phoenix` 为工作区示例。它只覆盖日常的“进行中 / 测试”双轨环境，不恢复发布验证，也不启用 Cool Admin Midway 4。

## 1. 动态兼容基线

- Phoenix Hub 的版本和 package manager 以 `E:\phoenix\phoenix-hub\package.json` 为准。
- Admin Vue、Admin Node、Open Issue、Phoenix Wing 与 Branding 使用任务指定的 Git 分支；日常双轨示例通常从 `develop` 创建 `inprocess`，但归档不固定 commit SHA。
- Open Issue 与 Branding 的插件版本、Host/Wing 兼容范围、入口和校验值以各自 `packages/admin-plugin/manifest.json` 为准。
- Hub Registry 版本以 Hub 自身依赖和锁文件为准；Hub 不消费相邻 `phoenix-wing` 源码目录。
- 每次复现都必须先核对分支、工作树状态、Manifest 和 package manager，不能把文档中的示例版本当成远端最新状态。

归档不记录具体 Git commit。需要冻结发布验收时，应在独立的、访问受控的验收记录中保存 Git ref 与制品完整性证据，不回写本开发模式文档。

## 2. 两个 Admin 分组

### 2.1 进行中

`Admin 进行中` 在界面显示为“进行中”。它用于正在修改的 Admin Host 与消费者：

- Vue：`E:\phoenix\.worktrees\inprocess\vue`，本地分支 `inprocess`；
- Node：`E:\phoenix\.worktrees\inprocess\node`，本地分支 `inprocess`；
- Issue：`E:\phoenix\.worktrees\inprocess\issue`，本地分支 `inprocess`；
- 品牌插件：`E:\phoenix\.worktrees\inprocess\branding`，本地分支 `inprocess`；
- 插件消费者通过 Windows `Junction` 链接到对应的 inprocess 插件工作树；
- 端口为 Web `9000`、API `8101`。

这一组的链接是开发者工作树装配，不由 Hub 的 Admin 插件登记文件表达为“已挂载”。AI 不得因为 `.runtime/admin-plugins.json` 没有指向 inprocess 就删除这些 Junction。

### 2.2 测试

`Admin 稳定测试` 在界面显示为“测试”。它使用主工作目录：

- Vue：`E:\phoenix\phoenix-admin-vue`；
- Node：`E:\phoenix\phoenix-admin-node`；
- Open Issue：`E:\phoenix\phoenix-open-issue`；
- 品牌插件：`E:\phoenix\phoenix-branding`，Manifest `phoenix-branding@0.1.0`；
- 插件必须通过 Hub 的“系统 → Admin 工具 → Admin 插件”执行检查和受控挂载；
- 端口为 Web `9100`、API `8201`；
- API 固定 `PAH_DB_SYNCHRONIZE=false` 与 `PAH_DB_INITIALIZE=false`，避免测试启动隐式改库。

Hub 的开发 Host 设置必须指向测试组：

```json
{
  "adminWebRoot": "E:\\phoenix\\phoenix-admin-vue",
  "adminNodeRoot": "E:\\phoenix\\phoenix-admin-node",
  "adminWebServiceId": "admin-stable-test-web",
  "adminApiServiceId": "admin-stable-test-api"
}
```

## 3. Hub 用户配置

双轨完整示例保存在：

- `config/sample/services.windows.admin-development.sample.json`
- `config/sample/admin-plugins.windows.sample.json`

恢复新机器时：

```powershell
Copy-Item config\sample\services.windows.admin-development.sample.json config\services.user.json
Copy-Item config\sample\admin-plugins.windows.sample.json .runtime\admin-plugins.json
```

两个目标文件都被 Git 忽略。复制后必须复核路径、端口、服务 ID、插件目录和本机 pnpm 入口。Hub 不接受浏览器传入任意命令；服务启动命令只来自后端验证后的清单。

标准示例使用 `pnpm`。如果 Codex Windows 进程的 `PATH` 只暴露 `pnpm.cmd` shim，受控清单可以改为绝对 `node.exe`，并把绝对 `pnpm.mjs` 放在参数首位。该路径属于本机运行时，不能提交到通用 sample。

## 4. 创建进行中工作树

先确认目标目录和本地分支都不存在，再执行：

```powershell
New-Item -ItemType Directory -Force E:\phoenix\.worktrees\inprocess | Out-Null

git -C E:\phoenix\phoenix-admin-vue worktree add -b inprocess E:\phoenix\.worktrees\inprocess\vue develop
git -C E:\phoenix\phoenix-admin-node worktree add -b inprocess E:\phoenix\.worktrees\inprocess\node develop
git -C E:\phoenix\phoenix-open-issue worktree add -b inprocess E:\phoenix\.worktrees\inprocess\issue develop
git -C E:\phoenix\phoenix-branding worktree add -b inprocess E:\phoenix\.worktrees\inprocess\branding develop
```

以上命令只用于空白机器。不得覆盖已经存在的分支或目录，也不得对 dirty 主仓执行强制切换。创建后应逐项确认四个 `inprocess` 工作树的分支和路径。

随后按每个仓库声明的 package manager 安装：

```powershell
pnpm --dir E:\phoenix\.worktrees\inprocess\vue install --frozen-lockfile
pnpm --dir E:\phoenix\.worktrees\inprocess\node install --frozen-lockfile
pnpm --dir E:\phoenix\.worktrees\inprocess\issue install --frozen-lockfile
pnpm --dir E:\phoenix\.worktrees\inprocess\branding install --frozen-lockfile
```

## 5. 进行中消费者 Junction

Windows 非管理员目录链接使用 `Junction`。创建前必须确认目标不存在；不能用 `-Force` 覆盖实体目录或外来链接。

Open Issue 示例：

```powershell
New-Item -ItemType Junction `
  -Path E:\phoenix\.worktrees\inprocess\vue\src\modules\phoenix-open-issue `
  -Target E:\phoenix\.worktrees\inprocess\issue\packages\admin-plugin\vue\phoenix-open-issue

New-Item -ItemType Junction `
  -Path E:\phoenix\.worktrees\inprocess\node\src\modules\phoenix-open-issue `
  -Target E:\phoenix\.worktrees\inprocess\issue\packages\admin-plugin\midway\phoenix-open-issue
```

Acme 品牌插件的真实 `moduleId` 是 `phoenix-branding`：

```powershell
New-Item -ItemType Junction `
  -Path E:\phoenix\.worktrees\inprocess\vue\src\modules\phoenix-branding `
  -Target E:\phoenix\.worktrees\inprocess\branding\packages\admin-plugin\vue\phoenix-branding

New-Item -ItemType Junction `
  -Path E:\phoenix\.worktrees\inprocess\node\src\modules\phoenix-branding `
  -Target E:\phoenix\.worktrees\inprocess\branding\packages\admin-plugin\midway\phoenix-branding
```

其他品牌插件仍必须先读取真实 Manifest 再链接，不得从插件名称猜测目录。

Host 的 `.git/info/exclude` 应包含 `/src/modules/<moduleId>`，只用于避免本机链接污染 Git 状态。它不会阻止 TypeScript、测试或构建穿透链接。

## 6. 测试组的 Hub 受控挂载

Open Issue 登记示例位于 `config/sample/admin-plugins.windows.sample.json`。标准操作顺序：

1. 打开“系统 → Hub → Hub 设置 → Phoenix Admin 开发支持”，确认 Host 指向主 Vue/Node 与测试服务 ID。
2. 打开“系统 → Admin 工具 → Admin 插件”。
3. 对 Open Issue 执行“检查”，确认 `sourceState=available`、Manifest `0.7.2`、DDL 和 artifacts 校验通过。
4. 执行“开发挂载”；Windows 无普通 symlink 权限时，可先用 `Junction` 创建两条准确链接，再让 Hub 认领并写入 Git exclude。
5. 最终必须是 `mountState=mounted`，两端 `linkState=mounted`、`excludeState=managed`。

Acme 品牌插件示例登记为 `phoenix-branding-0-1-0`。实际登记 ID 和版本必须与当前 Manifest 一致；检查和挂载后的目标状态应与 Open Issue 相同：`mountState=mounted`，两端 `linkState=mounted`、`excludeState=managed`。示例不预填 `operations`，复制到新机器后必须重新检查并显式挂载。

## 7. SQL 原始字节与 Windows 换行

插件 Manifest 对 migration SQL 校验原始字节 SHA-256。Windows 的 `core.autocrlf=true` 可能把 LF 检出为 CRLF，导致合法插件被拒绝。

Open Issue 当前规则：

```gitattributes
packages/admin-plugin/midway/phoenix-open-issue/migrations/*.sql text eol=lf
```

可信校验值必须在复现时从当前 Manifest 读取，并与 LF 原始文件重新计算的 SHA-256 比较。归档不复制具体校验值，避免在插件升级后继续传播过期数据。正确修复是把 SQL 固定为 LF；不得把 Manifest 改为 CRLF 哈希，也不得关闭 Hub 原始字节校验。

品牌 Manifest 同样记录 5 个 SVG 的原始大小与 SHA。`phoenix-branding` 根目录通过以下仓库规则保持所有文本为 LF：

```gitattributes
* text=auto eol=lf
```

Windows 上若旧工作树已经是 CRLF，应先确认资源无本地改动，再按该属性从 Git 原始 blob 恢复；不得把 Manifest 改成 CRLF 哈希。品牌打包工具使用锁文件声明的纯 Node ZIP 依赖，不依赖 Mac/Linux 的系统 `zip`、`unzip` 命令。主库和 inprocess 副本均必须通过两个 Host ESLint、Manifest 校验与全部契约测试。

## 8. 启动顺序与安全边界

1. 启动 Hub：`pnpm dev`，确认 `http://127.0.0.1:42100`。
2. 检查目标分组、插件链接、端口与数据库配置。
3. API 先于 Web 启动。
4. 测试 API 未确认数据库凭据时不得启动；禁止自动创建数据库、执行 seed 或打开 synchronize。
5. “进行中”和“测试”共享一个 `runtimeSlot` 家族，按 Hub 的冲突规则切换，不应同时占用同一端口。
6. `phoenix-wing` 根目录的 `pnpm dev` 是测试 watch，不是 Admin 运行服务。
7. Open Issue 是 Admin 插件，不再作为 `3400/5183 + pnpm dev` 的独立服务启动。

Windows 实现必须满足两个要求：Hub 能从目标进程 PEB 读取真实 cwd，不能把缺失 cwd 当成可靠 ownership；Admin Vue 的 Wing 本地脚本复用当前 pnpm 的 `node + npm_execpath`，并以 workspace 拓扑顺序构建 Wing 子包。多层 pnpm/Vite 子进程在优雅停止超时时，必须保留 Hub 的二次确认，不能按进程名强杀。

发布验证、干净安装验证与 Cool Admin Midway 4 不属于本开发模式。没有可信包、独立数据库、明确 Host Git ref 和授权时，AI 必须保持它们未配置、未启动。

## 9. 复现验收

完成后逐项确认：

- Hub 版本、Wing Registry 门禁和 package manager 版本匹配；
- 服务页只有“进行中 / 测试”两个 Admin Profile；
- `configurationErrors` 为空；
- 进行中 Vue、Node、Issue、Branding 四仓都在各自 `inprocess` 分支，工作树路径正确；
- 测试组使用主 Admin 仓，Hub 设置指向测试服务 ID；
- Open Issue 主仓在测试组显示 `mounted`；
- Open Issue inprocess 工作树被进行中 Vue/Node 的 Junction 消费；
- Acme 品牌主仓在测试组显示 `mounted`，inprocess 工作树被进行中 Vue/Node 的 Junction 消费；
- 主仓与工作树没有被链接或安装过程意外写入业务源码；
- API 数据库策略经人工确认后才启动；
- Web/API 的端口、PID、cwd 和 ownership 均由 Hub 实际探测，不以“进程已创建”代替健康验证。

## 10. 关联资料

- `docs/Admin插件开发工作区.md`：插件登记、检查、挂载、卸载与核验边界。
- `docs/本地配置指南.md`：跨平台基础目录和服务配置。
- `docs/Admin插件宿主设置点检.md`：Hub 设置中的 Admin Host 单一事实源。
- `docs/进程确认与归属恢复点检.md`：受控进程身份与停止安全。

## 11. 归档与脱敏边界

- 可归档：本文件、平台 sample、稳定服务 ID、端口约定、`E:\phoenix` 示例路径、Manifest 字段和验收步骤。
- 不归档：具体 Git commit SHA、真实数据库名或凭据、DSN、token、个人用户名、用户目录、Codex/Node 绝对运行时路径和 Hub 操作历史。
- `config/services.user.json`、旧 `config/services.json`、`.runtime/`、`.env.local` 与 `.pnpm-store/` 都是本机状态，必须保持 Git 忽略。
- sample 的 `operations` 保持空对象；真实挂载历史只保存在本机 `.runtime/admin-plugins.json`。
