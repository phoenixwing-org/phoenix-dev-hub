# 多版本服务分组与配置模型

状态：Phoenix Dev Hub 0.3.0 已实现

## 适用边界

这套模型只管理可以启动、停止、探测和记录日志的本机服务。它解决同一产品存在稳定版、
开发版或不同安装目录时的组织、配置复用和安全切换。

Phoenix Admin 插件不是服务，不进入 Series/Profile。插件目录识别、开发挂载、Admin Host
编排和核验由独立的 [Admin 插件开发工作区](ADMIN-PLUGIN-DEVELOPMENT.md) 负责。

## 模型

```text
产品系列 Series：Phoenix Admin
├─ 版本实例 Profile：稳定版
│  ├─ 服务 Service：Admin API
│  └─ 服务 Service：Admin Web
└─ 版本实例 Profile：本地开发版
   ├─ 服务 Service：Admin API
   └─ 服务 Service：Admin Web
```

- **Series**：同一产品族，只负责模板、显示和组织，不对应进程。
- **Profile**：一套实际安装或版本实例，保存模板差异和版本元数据。
- **Service**：一条受控命令和独立进程生命周期，仍由 `PdhServiceManager` 管理。
- **runtimeSlot**：运行互斥键；相同 slot 的不同 Profile 默认不能同时活动。

Series 只有一个 Profile 时，服务总览自动压缩为 `Series → Service`。增加第二个 Profile
后才显示完整的 `Series → Profile → Service`，因此单 Web 或单 API 项目不会增加额外操作层。

## 配置格式

仓库只归档去敏的 `config/services.sample.json`，实际基线由使用者复制到 Git 忽略的
`config/services.user.json`，两者都使用 version 2。sample 中的 worktree、commit、SHA、
integrity 与数据库均为占位示例，Hub 不会自动执行：

```json
{
  "version": 2,
  "series": [
    {
      "id": "phoenix-admin",
      "name": "Phoenix Admin",
      "template": {
        "runtimeSlot": "phoenix-admin",
        "services": {
          "api": {
            "name": "Phoenix Admin API",
            "command": { "executable": "pnpm", "args": ["dev"] },
            "endpoints": [
              {
                "id": "api",
                "label": "API",
                "port": 8101,
                "healthUrl": "http://127.0.0.1:8101/index.html"
              }
            ],
            "startOrder": 10
          },
          "web": {
            "name": "Phoenix Admin Web",
            "command": { "executable": "pnpm", "args": ["dev"] },
            "endpoints": [
              {
                "id": "web",
                "label": "Web",
                "port": 9000,
                "openUrl": "http://127.0.0.1:9000/"
              }
            ],
            "startOrder": 20
          }
        }
      },
      "profiles": [
        {
          "id": "default",
          "name": "默认实例",
          "metadata": { "wingVersion": "0.6.0" },
          "services": {
            "api": { "id": "admin-api", "cwd": "../phoenix-admin-node" },
            "web": { "id": "admin-web", "cwd": "../phoenix-admin-vue" }
          }
        }
      ]
    }
  ]
}
```

`template.services` 与 `profile.services` 都按服务角色键控，例如 `api`、`web`、`worker`。
Profile 中写 `false` 可排除模板中的某个角色；API-only、Web-only 和包含辅助进程的实例
使用同一结构表达。

### 环境与装配策略

Profile 可增加 `policy`：

- `environmentKind`：`development`、`release-validation`、`preproduction` 或 `production`；
- `deploymentMode`：开发可用 `source-mounted`，其余环境只接受 `package-assembled`；
- `database`：冻结负责服务、环境变量名、隔离库名与禁止库名；
- `assembly`：冻结输出目录、clean Node/Vue Host commit、Pah 业务包 moduleId/version/路径/SHA、角色目录与 Registry 精确依赖证据；
- `lifecycleControl`：production 强制为 `false`。本轮不提供生产写操作，未来必须另建 capability、维护窗口、备份、二次确认与审计契约。

`release-validation` 是“发布验收环境（非正式）”：用于不可变发布包、独立数据库和真实
生命周期测试，但不承诺与正式生产的拓扑、数据或运维策略同构。UI 必须显示“非正式”，
不得将其标成 `preproduction` 或 `production`。

不同 `runtimeSlot` 表示可并行实例，但并行 Profile 仍不得共享端口、数据库、cwd 或
assembly root。package assembly 使用 no-replace 语义，只写 Hub `.runtime`，不修改 Host
输入，也不执行 Pah 安装、DDL、数据库创建或权限操作。

### 合并规则

- 普通对象深度合并；
- `args`、`endpoints` 等数组整体替换；
- `null` 只用于明确清空允许为空的可选字段；
- Profile 只继承所属 Series 的一层模板，不允许 Profile 相互继承；
- 合并后必须形成完整、全局唯一的 `ServiceDefinition`；
- 展开结果继续通过 cwd、命令、端点、URL、环境变量和非 shell 门禁。

旧 version 1 平铺服务仍可读取和导入。解析器会按 `moduleId` 建立隐式 Series 和默认
Profile，再进入同一套 version 2 校验与展开流程。

## 本机覆盖与导入导出

- 可归档示例：`config/services.sample.json`；
- 用户完整基线：Git 忽略的 `config/services.user.json`，由使用者自行备份；
- 旧版兼容入口：Git 忽略的 `config/services.json`；
- 本机覆盖与隐藏状态：Git 忽略的 `.runtime/services.json`，权限 `0600`；当前内部格式为
  version 3，以 `baselineProfileIds` 在仓库新增 Profile 时安全合并旧 version 2 覆盖；
- User 项目：Git 忽略的 `.runtime/projects.json`；
- 整套导出：`phoenix-dev-hub-config` version 2；
- 单个 Series 导出：version 2；
- 单个服务兼容导出：version 1；
- 导入：兼容 version 1/version 2，采用合并语义并由后端重新校验。

导出内容可能包含本机绝对路径。它不包含 Admin 插件工作区、数据库连接串、访问令牌或
备份路径；换机器导入前仍应人工点检路径。

## 服务总览

服务表增加跨列的 Series/Profile 分组行，但实际服务行、状态、端点、PID 和操作保持原有
结构。当前实现包括：

- Series/Profile 逐级折叠及全部展开/折叠；
- 单 Profile 自动压缩；
- 搜索命中时自动展示祖先；
- 系列、实例和服务分别排序，不把叶子全局打散；
- 搜索词、排序方式和折叠状态由 Pinia 持有并持久化；
- Profile 批量启动、停止、重启和切换；
- API 按 `startOrder` 先于 Web 启动，停止时反向执行。

## 安全切换

切换 Profile 时按以下顺序执行：

1. 根据 `runtimeSlot` 找出其他活动 Profile；
2. 展示将停止和启动的版本及服务；
3. 用户确认后逐项停止当前版本；
4. Hub-owned 使用已记录并重新核验的进程组；
5. 外部进程继续要求原有二次确认，身份变化立即取消；
6. 等待进程与端口退出后按 `startOrder` 启动目标版本；
7. 失败时保留真实生命周期、健康度和日志，不隐式回退或启动旧版本。

端口监听不等于 Profile 身份。已知配置匹配时仍区分 Hub-owned 与 external；身份、cwd 或
健康不符时报告 conflict，不能因为属于同一 Series 就停止进程。

## 配置编辑

“服务设置”使用 View 内模态窗口，不新增临时顶部页签：

- **表单**：编辑常用 Series/Profile 元数据、单服务目录、命令参数等；
- **JSON**：编辑源配置，支持格式化和保存前 JSON/后端 schema 校验；
- **最终配置**：只读显示模板与 Profile 合并后的有效服务。

0.3.0 使用轻量 `textarea` JSON 编辑器，没有引入 CodeMirror 或 Monaco。它适合当前本机
配置规模；若以后需要行列错误定位、搜索、折叠和未保存离开保护，再作为单独增强接入，
不应在文档中把计划能力写成已完成能力。

## 已验证

- [x] 同一 Series 可以保存多个 Profile，并只在模板维护共同配置；
- [x] 单 Profile 自动隐藏中间层，多 Profile 显示完整树；
- [x] 搜索、排序和折叠状态刷新后保留；
- [x] 表单、JSON 和最终配置使用同一份草稿/解析结果；
- [x] 非法 JSON 或非法最终配置不能保存；
- [x] 相同 `runtimeSlot` 的不同 Profile 不会重复启动；
- [x] 切换继续复用 ownership、外部确认、PID 复用和端口换主保护；
- [x] version 1 可兼容导入，version 2 可按 Series 或整套导出；
- [x] API-only、Web-only 和多辅助进程可由服务角色表达。

## 后续增强

- 字段级“恢复继承”操作，避免通过 JSON 手工删除覆盖项；
- CodeMirror 等按需编辑器与精确行列错误定位；
- User 项目的可选固定端口、身份和健康检查配置；
- 导入前的新增、覆盖、隐藏和冲突差异预览。
