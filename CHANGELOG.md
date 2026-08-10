# 更新日志

## 0.3.2 - 2026-08-10

### 改进

- Phoenix Admin Development 的 API 启动简化为纯 `pnpm dev`，不再自动关联数据库初始化或受控测试工具 Profile。
- Admin Web 开发联调使用 `pnpm dev:local`（`dev:wing-local` 的便捷别名），本地 Wing 模式由本机服务配置决定。
- Admin 插件 View 聚焦 Host 启动与开发挂载，提供清晰的“修改目录”入口。
- 失效旧登记缺少 `moduleId` 时，可通过受控 Host 链接与 Git marker 安全恢复身份并切换源码目录。

### 依赖

- Dev Hub 自身的 Registry 依赖升级并锁定为 `phoenix-wing@0.6.3`。

## 0.3.1 - 2026-08-09

### 修复

- 服务目录、Host 或发布装配包暂时缺失时，Hub 保持启动并在服务总览中显示配置错误。
- 无效服务在创建进程前被阻断，编辑与导入入口仍执行严格配置校验。
- 聚合重复的后端配置警告，并在前端保留受影响的服务条目和错误说明。
- 明确区分 Hub 管理、外部启动、身份不符与未接管状态，细化健康状态文案。
- 修正分组行跨列布局、状态列换行和窄屏表格挤压问题。

### 验证

- 增加损坏配置、缺失路径、启动阻断和配置警告聚合的回归测试。

## 0.3.0 - 2026-08-05

### 新增

- 引入 Series → Profile → Service 多环境模型，并支持折叠、搜索、排序、批量生命周期和本机偏好持久化。
- 增加独立 Admin 插件开发 View、安全 symlink 挂载、重新指向、Host 编排与分层核验。
- 增加 package-assembled 发布验收、Registry 依赖证据、PostgreSQL spawn 前预检与显式隔离库动作。
- 增加 Admin 受控测试工具 Profile 与发布验收管理员重置入口。

### 改进

- 分离生命周期、ownership、健康、端点可达性与当前构建状态，避免旧监听端口掩盖新构建失败。
- 完善进程组停止、外部监控二次确认、日志 generation/cursor 清空语义和系统终端入口。
- 发布验收统一标记为“非正式”，与预生产、生产环境明确区分。
- 服务清单改为 `services.sample.json` + Git 忽略的 `services.user.json`，实际路径、数据库与发布证据由使用者自行管理。

### 安全与发布

- 发布验收采用独立端口、数据库、assembly 与 Git worktree Host，并拒绝源码链接、端口漂移及不安全依赖协议。
- 添加 Apache License 2.0；完整执行测试、类型检查、构建与隐私点检后形成单一 `0.3.0` 根提交。
