# Admin 受控测试工具 Profile（P0）

状态：**历史受控 Provider 已实现；日常 Phoenix Admin Development 启动已解除自动关联。Resolver 仅作为独立底层能力保留。**

当前产品决策：Hub 的 Admin 开发条目只执行 `pnpm dev`；初始化、数据库和测试工具由开发者或其他受控流程处理。

Owner 输入日期：2026-08-03

范围：只修改 Phoenix Hub。Open Issue 仅作为解锁后的消费者实证，不在 Hub 增加产品 ID、目录或命令特例。

## 当前窗口保护

- [x] 登记任务前确认 Hub 工作树 clean。
- [x] 解锁前的基线提交只写任务输入与验收清单；归档不绑定具体 commit。
- [x] 不停止、重启或重新配置当前 Hub、Admin Web、Admin API、Open Issue 服务。
- [x] 排队登记阶段不解析或执行 Vitest，不访问网络，不安装依赖。
- [x] 收到总控“Driver 已结束，可以启动本 P0”的明确消息。

Provider 可以实现和运行 Hub 仓内临时 fixture 门禁；Admin API 重启与产品消费者实证继续由总控安排。

## 已锁定设计

### 1. 通用 Resolver

新增 `PnhControlledToolProfileResolver`，从配置的 Admin Web root 解析受控测试工具：

- 只接受 Admin Web root 已安装且 lock 锁定的 Vitest `3.2.7`；
- 从明确的 Host/package root 解析，不搜索 `PATH`，不调用 package runner 的下载能力，不联网；
- 使用 `realpath` 固定 Host root、package root 和 entrypoint；
- package root 与 entrypoint 必须位于允许的真实 Host root / package root 内，拒绝 symlink escape；
- 精确核验 package identity、版本、lock integrity、entrypoint SHA-256 与 package SHA-256；
- 输出通用 Profile，不根据 Open Issue、Function、BOM 或其他产品 ID 选择工具。

Profile 至少包含：

| 字段 | 语义 |
| --- | --- |
| `schemaVersion` | Profile 契约版本 |
| `profileId` | 稳定的受控 Profile 标识 |
| `toolId` | 精确工具身份，本期为 Vitest |
| `toolVersion` | 精确版本 `3.2.7` |
| `hostRootRealpath` | Admin Web 真实根目录 |
| `packageRootRealpath` | Vitest package 真实根目录 |
| `entrypointRealpath` | 受控 CLI entrypoint 真实路径 |
| `lockIntegrity` | Host lockfile 对应的完整性/锁定证据 |
| `entrypointSha256` | entrypoint 原始字节 SHA-256 |
| `packageSha256` | 已冻结 package 内容口径的 SHA-256 |
| `availability` | `available` / `unavailable` |
| `unavailableReason` | 失败时的稳定、非敏感原因 |

`packageSha256` 使用 `pnh-package-sha256-v1`：递归收集 package root 内全部普通文件，拒绝内部
symlink 与特殊文件；相对路径统一为 `/` 并按二进制词法排序，每项按“UTF-8 相对路径 + NUL +
原始文件字节 + NUL”进入 SHA-256。目录 mtime、权限和机器绝对路径不参与哈希。

### 2. 启动时保留环境注入

为 `PnhServiceManager` 增加内部 `runtimeEnvProvider`：

- 只对 Admin 插件设置中 `adminApiServiceId` 指向的服务注入受控工具 Profile；
- 注入顺序必须为 `process.env` → `definition.command.env` → Hub 保留 runtime env；
- Hub 保留键最后写入，用户 `command.env` 无法覆盖或伪造；
- `PHOENIX_HUB_SERVICE_ID` 等现有 Hub 保留键继续由 Hub 最后写入；
- spawn 继续使用参数数组、`shell: false`，不得拼接 shell 命令；
- 其他服务不接收该 Profile，现有环境合并和生命周期不改变。

保留 env 的键名、JSON schema 与最大长度在实现开始时作为契约冻结，并加入解析/序列化测试；配置文件不得开放这些保留键的写权限。

#### 精确 env 契约

- 唯一键：`PHOENIX_HUB_CONTROLLED_TOOL_PROFILE`
- 编码：单行 UTF-8 JSON，最大 `16384` 字节
- `schemaVersion`：`1`
- `profileId`：`pnh.controlled.vitest`
- `toolId` / `toolVersion`：`vitest` / `3.2.7`
- 父进程和 `command.env` 中的同名键会先删除；只有 Hub 内部 Provider 可以最后注入。

可用 Profile：

```json
{
  "schemaVersion": 1,
  "profileId": "pnh.controlled.vitest",
  "toolId": "vitest",
  "toolVersion": "3.2.7",
  "availability": "available",
  "hostRootRealpath": "<admin-web-root>",
  "packageRootRealpath": "<admin-web-root>/node_modules/.pnpm/.../node_modules/vitest",
  "entrypointRealpath": "<package-root>/vitest.mjs",
  "lockfileRealpath": "<admin-web-root>/pnpm-lock.yaml",
  "lockSpecifier": "^3.2.7",
  "lockIntegrity": "sha512-...",
  "lockfileSha256": "<64 lowercase hex>",
  "entrypointSha256": "<64 lowercase hex>",
  "packageSha256": "<64 lowercase hex>",
  "packageHashFormat": "pnh-package-sha256-v1",
  "packageFileCount": 109
}
```

不可用 Profile 不包含本机路径或环境内容：

```json
{
  "schemaVersion": 1,
  "profileId": "pnh.controlled.vitest",
  "toolId": "vitest",
  "toolVersion": "3.2.7",
  "availability": "unavailable",
  "unavailableReason": {
    "code": "PACKAGE_UNAVAILABLE",
    "message": "Admin Web root 未安装受控工具 package"
  }
}
```

### 3. 不可用与 fail-closed

- Vitest 缺失、身份不符、版本不符、lock 证据缺失、SHA 不符、realpath 越界时，Resolver 返回 `unavailable` 和稳定原因；
- 工具不可用不阻止 Admin API 本身启动，便于健康检查与诊断；
- 外部启动的 Admin API 没有 Hub Profile，产品测试入口必须 fail-closed，不回退到 `PATH`、`npx`、`pnpm dlx` 或联网下载；
- Hub 只提供经过验证的工具事实，不把“API 已启动”或“工具 Profile 存在”解释为产品测试通过；
- 日志不得输出连接串、token 或完整环境，仅显示 Profile ID、工具版本、可用状态和非敏感失败原因。

## 实施清单

- [x] 冻结 Profile TypeScript 契约、保留 env 键名和 package SHA 口径。
- [x] 实现 `PnhControlledToolProfileResolver`，只解析 Admin Web root 的锁定 Vitest。
- [x] 实现 lock identity/integrity、realpath containment、版本与双 SHA 核验。
- [x] 为 `PnhServiceManager` 增加可注入、默认无副作用的内部 `runtimeEnvProvider`。
- [x] 由装配根按 `adminApiServiceId` 绑定 Provider，不在 ServiceManager 写产品或服务 ID 特例。
- [x] 保证 runtime env 最后合并并拒绝 `command.env` 覆盖保留键。
- [x] 工具不可用时以 unavailable Profile 启动目标服务，并提供可诊断日志。
- [x] 保持 `shell: false`，不增加任意命令、PATH 搜索、自动安装或网络能力。
- [x] 更新契约、README、配置说明和安全边界。

## 自动化门禁

- [x] 正常解析 Vitest `3.2.7`，Profile 包含真实 roots、entrypoint、lock 与双 SHA。
- [x] 用户 `command.env` 伪造保留 Profile 或 unavailable reason 时覆盖失败。
- [x] 工具缺失时不搜索 `PATH`、不调用网络或安装命令，目标服务仍按原命令启动。
- [x] package root 或 entrypoint symlink 逃逸允许根时返回 unavailable。
- [x] entrypoint SHA、package SHA、lock integrity 任一不符时返回 unavailable。
- [x] package identity 或版本不是锁定值时返回 unavailable。
- [x] 环境合并顺序严格为 process → command → Hub runtime，现有 Hub 保留键不被覆盖。
- [x] 只有配置的 `adminApiServiceId` 获得 Profile，其他服务环境不受影响。
- [x] start、重复 start、启动失败与服务配置刷新不泄漏或复用陈旧 Profile。
- [x] spawn 参数证明 `shell: false`，无产品 ID 映射或产品目录特判。
- [x] 外部监控服务的 `start` 不调用 Provider，Hub 不向外部 Node 注入 Profile。
- [x] 完整 `pnpm verify`、类型检查和生产构建通过。

## 总控安排重启后的消费者实证

Open Issue 只用于证明通用能力可消费，不作为 Resolver 的判断输入：

- [ ] Hub-owned Admin API 能读取并验证受控 Profile。
- [ ] 外部启动 Admin API 因无 Profile 而拒绝产品测试执行。
- [ ] unavailable Profile 给出明确原因且不影响 Admin API 健康诊断。
- [ ] 实际测试进程使用 Profile 的绝对 entrypoint 与 package root，未访问 `PATH` 或网络。
- [ ] 记录 Host-owned / plugin-owned 测试所有权；消费者通过不等于插件完整迁移完成。

## 停止条件

出现以下任一情况立即停止实现或实证：Admin API/消费者尚未获总控重启授权、Admin Web root/lock 不一致、工作树出现归属不明 dirty、Profile 契约需要产品特例、解析必须依赖 PATH/网络、或验证会干扰当前运行服务。

## 用户点检（实现完成后）

- [ ] Admin API 缺少测试工具时仍能启动并清楚报告“受控工具不可用”。
- [ ] 外部启动的 Admin API 不会偷偷调用本机 PATH 中的 Vitest。
- [ ] 修改用户服务 env 不能替换 Hub 保留 Profile。
- [ ] Open Issue 能使用同一通用 Profile，Hub 中没有 Open Issue 特判。
- [ ] 其他服务的启动、日志、健康检查与停止行为保持原样。

## Provider 实施结果

- Hub 完整门禁：12 个测试文件、51 项测试，类型检查与生产构建通过。
- 真实 Admin Web root 只读解析：`vitest@3.2.7`、109 个 package 文件，lockfile、entrypoint、package SHA 均已生成并完成二次复核。
- 运行边界：没有停止、重启或重新配置当前 Admin API；没有运行 Open Issue 或其他产品消费者。
- 剩余工作：由总控安排受控重启，再由产品消费者验证 Profile schema/SHA 和无 Profile fail-closed。
