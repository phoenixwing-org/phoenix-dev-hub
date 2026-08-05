# 服务健康探测语义点检

状态：实现完成，等待真实 Function 页面点检

## 真实复现

- Function legacy@446 启动后，Web `9202/` 返回 HTTP 200；
- API `9201` 有监听，服务日志显示 API 基路径 `/api`，但 `9201/` 返回 HTTP 404；
- 旧清单把 `http://127.0.0.1:9201/` 固定为 `healthUrl`，因此 Hub 报
  `lifecycle=running / health=partial`，容易被理解成启动失败；
- 功能实际可用。根路由 404 只能证明该路径不是健康端点，不能证明进程或业务启动失败。

## 通用契约

- [x] endpoint 同时报告 `reachable`、兼容字段 `healthy` 和明确的 `probeState`；
- [x] `probeState` 区分 `healthy`、`unhealthy`、`reachable-unverified`、`unreachable`；
- [x] 显式非根 `healthUrl` 严格请求该路径，只有 HTTP 2xx 才是 `healthy`；
- [x] 兼容历史配置：源站根路径 `/` 返回 404 时识别为“未发现可用健康路径”，而非业务不健康；
- [x] 未配置 `healthUrl` 时只探测端口，返回“端口可达；未配置 HTTP 健康路径”；
- [x] service 新增 `health=reachable`，不再把“所有必需端口可达但部分未配置健康路径”叫“部分就绪”；
- [x] `reachable` 明确不代表业务健康，也不增加插件迁移或发布完成度；
- [x] 真正缺失端口、显式健康路径失败和多端点部分故障仍分别保持 `unhealthy/partial`；
- [x] 构建失败仍优先降级为 `unhealthy`，端口可达不能掩盖编译失败；
- [x] 外部服务在 cwd/identity 匹配且端口可达时可进入外部监控，不因未配置根路由而误报冲突；
- [x] 没有按 Function 名称、端口或 `/api` 写运行时分支。

## 默认配置与本机覆盖

- [x] tracked Function API endpoint 删除错误的根 `healthUrl`，使用通用“仅端口探测”契约；
- [x] Function Web 保持显式 `9202/` HTTP 健康探测；
- [x] 若产品以后提供真实健康 endpoint，只需在服务 JSON 配置对应 `healthUrl`；
- [x] `.runtime/services.json` 属于本机覆盖，不由提交静默改写；现有覆盖中的根 `healthUrl` 返回
  404 后会自动兼容为“端口可达/未发现可用健康路径”，之后仍建议删除该字段或确认后“重置默认”清理陈旧配置。

## UI

- [x] 服务总览新增“端口可达”，使用与“健康就绪”“部分就绪”“不健康”不同的视觉状态；
- [x] endpoint tooltip 展示精确 probe message 和已配置的 health URL；
- [x] Properties 展示 `HEALTHY / LISTEN ONLY / HEALTH FAIL / OFF` 及中文说明；
- [x] 服务 message 明确“健康路径未配置，仅确认监听可达，不代表业务健康”。

## 自动验证

- [x] 根路由 404、未配置 `healthUrl`：`lifecycle=running / health=reachable`；
- [x] 同一服务显式配置 `/api/health` 并返回 204：`health=ready`；
- [x] 历史根路径 `/` 返回 404：`health=reachable`，并说明未发现可用健康路径；
- [x] 显式非根 `/missing-health` 返回 404：`health=unhealthy`；
- [x] 原有多端点部分故障、构建失败、外部监控和停止安全测试保持通过；
- [x] `pnpm verify` 通过。

## 手工点检

- [ ] 保留现有 `.runtime/services.json` 覆盖并重启 Hub，再启动 legacy@446；无需先改 JSON；
- [ ] 确认 lifecycle 为“运行中”、health 为“端口可达”，且不再显示“部分就绪”；
- [ ] Function API endpoint 显示 `LISTEN ONLY`，说明为“配置的根路径返回 HTTP 404，未发现可用健康路径”；
- [ ] Function Web endpoint 显示 `HEALTHY`，页面 `9202/` 仍可打开；
- [ ] 停止服务后，在“系统 → Dev Hub → 服务设置”删除 API endpoint 的根 `healthUrl`，或确认后重置默认配置；
- [ ] 再次启动，确认 API 仍为 `LISTEN ONLY`，说明改为“未配置 HTTP 健康路径”；
- [ ] 将 API 临时显式配置为 `/missing-health`，确认 404 严格显示为 `HEALTH FAIL`；
- [ ] 若后续提供真实健康路径，配置该 URL 后确认 HTTP 2xx 才进入“健康就绪”。
