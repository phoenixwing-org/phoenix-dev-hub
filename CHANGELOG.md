# 更新日志

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
