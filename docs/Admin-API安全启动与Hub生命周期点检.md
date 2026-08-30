# Admin API 安全启动与 Hub 生命周期点检

> 日期：2026-08-02
> 范围：仅 `phoenix-hub`；不修改 Phoenix Admin Host 或业务插件源码，不执行 DDL，不 push。

## 需求与实现清单

- [x] 读取公共 Phoenix Admin 插件迁移 Skill、输入清单与验收规范。
- [x] 检查仓库分支、HEAD、worktree 与 dirty state；确认修改前无待保护 dirty 文件。
- [x] 通过 Hub 状态与只读进程核验检查旧 `admin-api` ownership；旧 root PID、listener 与 8101 均已退出，无需发送信号。
- [x] sample 与用户基线要求 `PAH_DB_SYNCHRONIZE=false`。
- [x] sample 与用户基线要求 `PAH_DB_INITIALIZE=false`。
- [x] 真实验收数据库只写入 Git 忽略的用户配置，不进入 sample。
- [x] 受控进程输出出现明确 TypeScript/build 失败时，记录独立构建状态。
- [x] 即使端口 HTTP 2xx，当前构建失败也必须显示“不健康”和“端口健康但当前构建失败”。
- [x] watch 后续构建成功时可以清除旧失败状态，新健康检查继续生效。
- [x] 外部进程仍只报告端口/身份/健康，不伪造当前构建状态。
- [x] 在 `系统 → Hub → Hub 设置` 增加独立 View。
- [x] Hub 设置显示地址、版本、系统终端能力与重启边界。
- [x] “打开 Hub 终端”只使用后端固定项目根目录，不接受浏览器路径或命令。
- [x] “关闭 Hub”必须二次确认；API 响应后再安全停止 Hub-owned 服务并退出。
- [x] 不提供无 supervisor 保证的假“重启”按钮。
- [x] README/API 表与安全说明同步。
- [x] 版本按补丁更新并创建中文本地提交，不 push。

## 自动门禁

- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] Admin API 默认 env 配置测试
- [x] 构建失败覆盖 HTTP 200 的进程级测试
- [x] 后续成功构建恢复健康的测试
- [x] Hub 终端目录固定与关闭回调 API 测试
- [x] tracked 文件无日期数据库名、连接串、token、备份路径等本机私有信息

## 最终运行验证

- [x] Hub 在 `127.0.0.1:42100` 可达。
- [x] `admin-api` 最终有效 env 为：
  - `PAH_DB_SYNCHRONIZE=false`
  - `PAH_DB_INITIALIZE=false`
  - `PAH_DB_DATABASE=<本机验收库>`（具体名称仅在本机覆盖）
- [x] Function 源码若仍编译失败，Hub 不得报告 ready；若产品任务已修复，则以新构建成功信号与健康端点共同判定。
- [x] 不自动执行 SQL、migration、synchronize 或 initialize。

自动现场点检：Hub 设置 View、暗色布局、关闭确认的取消路径与“打开 Hub 终端”均已实际验证；下面仍保留用户点检框，等待使用者独立反馈。

## 用户点检

- [ ] 打开“系统 → Hub → Hub 设置”，确认暗色主题、布局和文案正常。
- [ ] 点击“打开 Hub 终端”，确认终端停留在 `phoenix-hub` 目录且未自动执行命令。
- [ ] 点击“关闭 Hub”后取消，确认 Hub 保持运行。
- [ ] 准备重启时再次点击“关闭 Hub”并确认，确认页面明确提示将断开。
- [ ] 在留下的终端执行 `pnpm dev`，确认 Hub 可重新访问。
- [ ] 启动 Phoenix Admin API；若存在 TS 编译错误，确认列表显示“端口健康但当前构建失败”，且停止按钮仍可用。
- [ ] 修复或等待 watch 构建成功后，确认构建状态恢复且健康度重新按端点计算。

## 结果记录

- 最终 commit：见 0.3.0 单一发布提交。
- 实际 PID、PGID、数据库与本机路径属于 `.runtime` 操作证据，不进入公开文档。
- 是否强制终止：否。
- 最终 Hub / Admin API 状态：以当次 `/api/services` 的 ownership、build 与 health 证据为准。
- 未完成边界：无 supervisor 时不提供自动重启；关闭后使用已打开的 Hub 终端手工运行 `pnpm dev`。用户点检反馈仍待收集。
