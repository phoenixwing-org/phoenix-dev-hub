# Phoenix Admin 开发 Host 设置点检

状态：Phoenix Dev Hub 0.4.2 已实现，等待使用者页面点检

## 目的与范围

Phoenix Admin 的插件开发需要一套明确的开发 Host：Admin Vue、Admin Node，以及它们在 Hub 服务清单中的
Web/API 服务 ID。此设置是**本机私有配置**，保存在 Git 忽略的 `.runtime/admin-plugins.json`，不随仓库归档。

本任务只管理上述四项绑定：

| 字段 | 用途 |
| --- | --- |
| `adminWebRoot` | 开发挂载 Vue 模块的 Admin Vue Git 根目录 |
| `adminNodeRoot` | 开发挂载 Node 模块的 Admin Node Git 根目录 |
| `adminWebServiceId` | 启动或监控开发 Admin Web 时使用的 Hub 服务 ID |
| `adminApiServiceId` | 启动或监控开发 Admin API 时使用的 Hub 服务 ID |

不在此处设置数据库连接、密码、访问令牌、备份路径、DDL、Pah 生命周期或服务命令。服务的端口、命令、环境变量和
干净验证 worktree 仍由“服务设置”管理；插件目录、Manifest 与 symlink 操作仍由“Admin 插件”View 管理。

## 界面与安全边界

- “系统 → Dev Hub → Hub 设置 → Phoenix Admin 开发支持”是唯一编辑入口；显示四项当前值并提供编辑、取消、保存。
- “系统 → Admin 工具 → Admin 插件”只读展示当前 Host，点击“开发 Host 设置”跳回 Hub 设置，避免两处写入。
- 保存时后端重新验证两个目录均为真实 Git 根目录，服务 ID 符合受控 ID 规则。
- 若任一已登记插件处于 `mounted`、`partial` 或 `conflict`，切换 Host 被拒绝；必须先完成“开发卸载”。
- 保存 Host 设置本身不创建/移动 symlink，不启动或停止服务，不初始化数据库，不执行 DDL。
- Hub 不能读取本机设置时，卡片显示可刷新的明确提示，而不是只留下不可操作的空白按钮。

## 自动门禁

- [x] 已挂载插件时修改 Web/Node 根目录或服务 ID 返回 `ADMIN_PLUGIN_HOST_RECONFIGURE_REQUIRES_UNMOUNT`。
- [x] 开发卸载完成后允许保存新 Host，并只写入本机 `.runtime/admin-plugins.json`。
- [x] 服务 ID 与 Git 根目录仍按后端规则验证，失败不改原设置。
- [x] `git diff --check`、聚焦单元测试、类型检查和 production build 通过。

## 使用者页面点检

1. 打开“系统 → Dev Hub → Hub 设置”，确认出现“Phoenix Admin 开发支持”卡片，且显示 Vue/Node 根目录、Web/API 服务 ID。
2. 点击“编辑”，核对四个字段可修改；先点击“取消”，确认原值未变化。
3. 打开“系统 → Admin 工具 → Admin 插件”，确认不再有第二套可编辑 Host 表单；点击“开发 Host 设置”或“打开 Hub 设置”能返回上述卡片。
4. 在已有开发挂载时尝试保存另一套 Host，确认出现“必须先执行开发卸载”的明确阻断，且原设置不变。
5. 完成开发卸载后，选择两个有效 Git 根目录和存在的服务 ID 保存；刷新浏览器，确认设置仍保留。
6. 在 Hub 停止或本机设置无法解析的情况下打开该页面，确认卡片显示“未能读取 Phoenix Admin 开发设置”及刷新提示，不应显示原始 `DevHubError` 或导致页面崩溃。

第 4、5 项会修改本机开发挂载或配置，只应在确认没有其他人使用当前 Admin Host 时执行。

## 发布记录

- 版本：`0.4.2`
- 依赖基线：Registry `phoenix-wing@0.7.1`
- 不包含：产品仓源码、当前服务生命周期、本机私有配置、数据库或凭据。
