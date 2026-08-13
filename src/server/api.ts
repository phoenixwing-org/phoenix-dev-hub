import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AddLocalProjectRequest,
  AdminPluginDryRunResponse,
  AdminPluginHostStartResponse,
  AdminPluginCatalogResponse,
  AdminPluginGateOwnerBoundary,
  AdminPluginGateTool,
  AdminPluginRouteCheck,
  AdminPluginVerificationBoundary,
  AdminPluginVerifyResponse,
  ApiErrorResponse,
  DevHubConfigurationDocument,
  HubRuntimeInfo,
  ServiceDefinition,
  StopServiceRequest,
  UpdateLocalProjectRequest,
} from "../shared/contracts.js";
import { DevHubError } from "./errors.js";
import type { PdhBuiltinServiceConfigStore } from "./PdhBuiltinServiceConfig.js";
import type { PdhAdminPluginWorkspace } from "./PdhAdminPluginWorkspace.js";
import type { PdhProjectConfigStore } from "./PdhProjectConfig.js";
import type { PdhServiceManager } from "./PdhServiceManager.js";

const LOOPBACK_HOST_PATTERN = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;
const ADMIN_PLUGIN_MIGRATION_SKILL_COMMIT = "46e25e3041dc9a57dbbb629feedc9e4694dfcd82";
const ADMIN_PLUGIN_GATE_TOOLS: readonly AdminPluginGateTool[] = ["lint", "typecheck", "test", "build"];

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 256 * 1024) throw new DevHubError("BODY_TOO_LARGE", "请求体过大", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new DevHubError("INVALID_JSON", "请求体必须是 JSON 对象", 400);
  }
}

function assertLocalRequest(request: IncomingMessage): void {
  const host = request.headers.host ?? "";
  if (!LOOPBACK_HOST_PATTERN.test(host)) {
    throw new DevHubError("LOCAL_ONLY", "Dev Hub 仅接受本机 Host", 403);
  }
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) {
    throw new DevHubError("INVALID_ORIGIN", "拒绝非同源控制请求", 403);
  }
}

function errorResponse(error: unknown): { statusCode: number; body: ApiErrorResponse } {
  if (error instanceof DevHubError) {
    return {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code, details: error.details },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { statusCode: 500, body: { error: message, code: "INTERNAL_ERROR" } };
}

function portableServiceDefinition(definition: ServiceDefinition): ServiceDefinition {
  const {
    configurationSource: _configurationSource,
    configurationOverridden: _configurationOverridden,
    localProjectId: _localProjectId,
    ...portable
  } = definition;
  return portable;
}

function assertBuiltinDefinitionsMutable(
  manager: PdhServiceManager,
  serviceIds: readonly string[],
): void {
  const registered = manager.serviceIds();
  for (const serviceId of serviceIds) {
    if (registered.has(serviceId)) manager.assertDefinitionMutable(serviceId);
  }
}

function synchronizeBuiltinDefinitions(
  manager: PdhServiceManager,
  previousIds: readonly string[],
  definitions: readonly ServiceDefinition[],
): void {
  const nextById = new Map(definitions.map((definition) => [definition.id, definition]));
  const previous = new Set(previousIds);
  const registeredBefore = manager.serviceIds();
  for (const definition of definitions) {
    if (registeredBefore.has(definition.id) && !previous.has(definition.id)) {
      throw new DevHubError(
        "SERVICE_ID_CONFLICT",
        `新 Profile 的服务 ID 已被其他配置使用：${definition.id}`,
        409,
      );
    }
  }
  for (const serviceId of previousIds) {
    if (!nextById.has(serviceId) && manager.serviceIds().has(serviceId)) manager.unregister(serviceId);
  }
  for (const definition of definitions) {
    if (manager.serviceIds().has(definition.id)) manager.replaceDefinition(definition);
    else manager.register(definition);
  }
}

function requireAdminPluginWorkspace(
  workspace: PdhAdminPluginWorkspace | undefined,
): PdhAdminPluginWorkspace {
  if (!workspace) throw new DevHubError("ADMIN_PLUGIN_WORKSPACE_UNAVAILABLE", "Admin 插件工作区尚未启用", 503);
  return workspace;
}

export interface PdhHubControl {
  readonly projectRoot: string;
  readonly version: string;
  readonly address: string;
  readonly requestShutdown: () => void;
}

function serviceLoopbackBase(manager: PdhServiceManager, serviceId: string): string {
  const endpoint = manager.definition(serviceId).endpoints[0];
  if (!endpoint) throw new DevHubError("ADMIN_HOST_ENDPOINT_MISSING", `服务 ${serviceId} 没有端点配置`, 409);
  return `http://127.0.0.1:${endpoint.port}`;
}

function authorizationHeader(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const token = value.trim();
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function unrecordedGateOwner(
  owner: AdminPluginGateOwnerBoundary["owner"],
  targetId: string,
  label: string,
  candidateRoot: string,
): AdminPluginGateOwnerBoundary {
  return {
    owner,
    targetId,
    label,
    candidateRoot,
    gates: ADMIN_PLUGIN_GATE_TOOLS.map((tool) => ({
      tool,
      command: null,
      scanRoot: null,
      followsSymlinks: "not-recorded",
      exclusionConfig: [],
      status: "not-recorded",
    })),
  };
}

/** 装配核验边界：诚实记录尚未由 Dev Hub 运行的工程门禁，不猜测产品完成度。 */
export function pdhAdminPluginVerificationBoundary(
  catalog: AdminPluginCatalogResponse,
): AdminPluginVerificationBoundary {
  return {
    scope: "development-assembly",
    label: "开发装配核验（非完整 verify）",
    completeProductVerification: false,
    migrationSkillCommit: ADMIN_PLUGIN_MIGRATION_SKILL_COMMIT,
    gitExcludePolicy: ".git/info/exclude 只影响 Git 状态，不是 lint/typecheck/test/build 的扫描或排除配置。",
    hostOwned: [
      unrecordedGateOwner("host", catalog.settings.adminWebServiceId, "Admin Web Host", catalog.settings.adminWebRoot),
      unrecordedGateOwner("host", catalog.settings.adminApiServiceId, "Admin API Host", catalog.settings.adminNodeRoot),
    ],
    pluginOwned: catalog.plugins.map((plugin) => unrecordedGateOwner(
      "plugin",
      plugin.identity.moduleId ?? plugin.registration.id,
      plugin.identity.name,
      plugin.candidate?.productRoot ?? plugin.registration.productRoot,
    )),
    blockingReasons: [
      "Host-owned 与 plugin-owned 的 lint/typecheck/test/build 命令、真实扫描根、symlink 遍历和工具排除配置尚未记录或运行。",
      "Host 不得穿透产品链接使用 --fix；产品格式问题必须退回产品仓处理。",
      "插件自身 lint 与冻结 production 装配的完整类型检查/构建仍是产品完成度强制门禁。",
    ],
  };
}

async function adminApiJson(
  url: string,
  authorization: string | undefined,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(5_000),
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(authorization ? { authorization } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    throw new DevHubError(
      "ADMIN_HOST_UNREACHABLE",
      `Admin API 不可达：${error instanceof Error ? error.message : String(error)}`,
      409,
    );
  }
  const raw = await response.text();
  let body: unknown = raw;
  try { body = JSON.parse(raw) as unknown; } catch { /* error response may be plain text */ }
  if (!response.ok) {
    throw new DevHubError("ADMIN_HOST_REQUEST_FAILED", `Admin API 返回 HTTP ${response.status}`, 409, body);
  }
  if (body && typeof body === "object" && "code" in body) {
    const envelope = body as { code?: number; message?: string; data?: unknown };
    if (envelope.code !== undefined && envelope.code !== 1000 && envelope.code !== 0) {
      throw new DevHubError(
        "ADMIN_HOST_REQUEST_FAILED",
        envelope.message || `Admin API 业务错误：${envelope.code}`,
        409,
        body,
      );
    }
    return envelope.data;
  }
  return body;
}

async function routeCheck(base: string, routePath: string): Promise<AdminPluginRouteCheck> {
  const url = new URL(routePath, `${base}/`).toString();
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(4_000) });
    return {
      path: routePath,
      url,
      reachable: response.status >= 200 && response.status < 300,
      statusCode: response.status,
      ...(response.status >= 200 && response.status < 300 ? {} : { message: "路由未返回 HTTP 2xx" }),
    };
  } catch (error) {
    return {
      path: routePath,
      url,
      reachable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createApiHandler(
  manager: PdhServiceManager,
  projectConfig: PdhProjectConfigStore,
  builtinServiceConfig: PdhBuiltinServiceConfigStore,
  adminPluginWorkspace?: PdhAdminPluginWorkspace,
  hubControl?: PdhHubControl,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/")) return false;

    try {
      assertLocalRequest(request);
      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, { ok: true, service: "phoenix-dev-hub" });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/services") {
        json(response, 200, await manager.list());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/host-capabilities") {
        json(response, 200, manager.hostCapabilities());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/hub") {
        if (!hubControl) throw new DevHubError("HUB_CONTROL_UNAVAILABLE", "Hub 生命周期控制尚未启用", 503);
        const body: HubRuntimeInfo = {
          name: "Phoenix Dev Hub",
          version: hubControl.version,
          address: hubControl.address,
          projectRoot: hubControl.projectRoot,
          systemTerminal: manager.hostCapabilities().systemTerminal,
          restartSupported: false,
          restartMessage: "当前没有外部 supervisor，Hub 退出后不能保证自行拉起；请先打开 Hub 终端，再关闭并手工运行 pnpm dev。",
        };
        json(response, 200, body);
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/hub/terminal") {
        await readJson(request);
        if (!hubControl) throw new DevHubError("HUB_CONTROL_UNAVAILABLE", "Hub 生命周期控制尚未启用", 503);
        json(response, 200, await manager.openHubTerminal(hubControl.projectRoot));
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/hub/shutdown") {
        const body = await readJson(request);
        if (!hubControl) throw new DevHubError("HUB_CONTROL_UNAVAILABLE", "Hub 生命周期控制尚未启用", 503);
        if (body.confirm !== "shutdown-phoenix-dev-hub") {
          throw new DevHubError("HUB_SHUTDOWN_CONFIRMATION_REQUIRED", "关闭 Hub 需要明确二次确认", 409);
        }
        json(response, 202, {
          accepted: true,
          message: "正在安全停止 Hub-owned 服务并关闭 Phoenix Dev Hub",
        });
        setTimeout(hubControl.requestShutdown, 50).unref();
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/projects") {
        json(response, 200, projectConfig.catalog());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/service-config") {
        json(response, 200, builtinServiceConfig.catalog());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/admin-plugins") {
        json(response, 200, requireAdminPluginWorkspace(adminPluginWorkspace).catalog());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/admin-plugins/inspect") {
        const body = await readJson(request);
        json(response, 200, requireAdminPluginWorkspace(adminPluginWorkspace).inspect(String(body.directory ?? "")));
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/admin-plugins") {
        const body = await readJson(request);
        json(response, 201, requireAdminPluginWorkspace(adminPluginWorkspace).add(String(body.directory ?? "")));
        return true;
      }
      if (request.method === "PATCH" && url.pathname === "/api/admin-plugins/settings") {
        const body = await readJson(request);
        json(response, 200, requireAdminPluginWorkspace(adminPluginWorkspace).updateSettings(body));
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/admin-plugins/host/start") {
        await readJson(request);
        const workspace = requireAdminPluginWorkspace(adminPluginWorkspace);
        const settings = workspace.settings();
        const currentApi = await manager.status(settings.adminApiServiceId);
        const api = currentApi.lifecycle === "stopped"
          ? await manager.start(settings.adminApiServiceId)
          : currentApi;
        const currentWeb = await manager.status(settings.adminWebServiceId);
        const web = currentWeb.lifecycle === "stopped"
          ? await manager.start(settings.adminWebServiceId)
          : currentWeb;
        const result: AdminPluginHostStartResponse = { api, web };
        json(response, 202, result);
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/admin-plugins/verify") {
        const body = await readJson(request);
        const authorization = authorizationHeader(body.authorization);
        const workspace = requireAdminPluginWorkspace(adminPluginWorkspace);
        const catalog = workspace.catalog();
        const apiStatus = await manager.status(catalog.settings.adminApiServiceId);
        const webStatus = await manager.status(catalog.settings.adminWebServiceId);
        const webBase = serviceLoopbackBase(manager, catalog.settings.adminWebServiceId);
        const apiBase = serviceLoopbackBase(manager, catalog.settings.adminApiServiceId);
        let lifecycleByModule = new Map<string, string>();
        if (authorization && apiStatus.health === "ready") {
          try {
            const list = await adminApiJson(
              `${apiBase}/admin/phoenix/plugin/list`,
              authorization,
              { method: "POST", body: "{}" },
            );
            const items = Array.isArray(list) ? list : [];
            lifecycleByModule = new Map(items.flatMap((item) => {
              if (!item || typeof item !== "object") return [];
              const plugin = item as { moduleId?: unknown; state?: unknown };
              return typeof plugin.moduleId === "string" && typeof plugin.state === "string"
                ? [[plugin.moduleId, plugin.state] as const]
                : [];
            }));
          } catch {
            // 路由与挂载核验仍可继续；lifecycle 显示为查询失败。
          }
        }
        const plugins = await Promise.all(catalog.plugins.map(async (plugin) => {
          if (!plugin.candidate) {
            return {
              plugin,
              manifestVersion: plugin.identity.version ?? "不可用",
              lifecycle: "源目录不可用，未核验",
              routes: [],
            };
          }
          return {
            plugin,
            manifestVersion: plugin.candidate.manifest.version,
            lifecycle: lifecycleByModule.get(plugin.candidate.manifest.moduleId)
              ?? (authorization ? "查询失败或尚未登记" : "未查询（需要一次性 Admin 令牌）"),
            routes: await Promise.all(plugin.candidate.manifest.routes.map((route) => routeCheck(webBase, route.path))),
          };
        }));
        const result: AdminPluginVerifyResponse = {
          generatedAt: new Date().toISOString(),
          host: { api: apiStatus, web: webStatus },
          plugins,
          ddlPolicy: "Hub 只读取 Admin Node 生成的短时 dry-run；不执行 SQL、不接收 planId/备份证明，也不启用 synchronize。",
          verificationBoundary: pdhAdminPluginVerificationBoundary(catalog),
        };
        json(response, 200, result);
        return true;
      }

      const adminPluginDryRunMatch = /^\/api\/admin-plugins\/([a-z][a-z0-9-]{1,63})\/ddl-dry-run$/.exec(url.pathname);
      if (adminPluginDryRunMatch) {
        if (request.method !== "POST") throw new DevHubError("METHOD_NOT_ALLOWED", "请求方法不支持", 405);
        const body = await readJson(request);
        const authorization = authorizationHeader(body.authorization);
        if (!authorization) throw new DevHubError("ADMIN_TOKEN_REQUIRED", "DDL dry-run 需要一次性 Admin 访问令牌；Hub 不会保存令牌", 400);
        const workspace = requireAdminPluginWorkspace(adminPluginWorkspace);
        const plugin = workspace.status(adminPluginDryRunMatch[1]);
        if (!plugin.candidate) {
          throw new DevHubError("ADMIN_PLUGIN_SOURCE_UNAVAILABLE", "插件源目录不可用，不能请求 DDL dry-run", 409, plugin.sourceError);
        }
        if (plugin.candidate.manifest.migrations.length === 0) {
          throw new DevHubError("ADMIN_PLUGIN_HAS_NO_DDL", "该插件没有声明 DDL migration", 409);
        }
        const apiBase = serviceLoopbackBase(manager, workspace.settings().adminApiServiceId);
        const endpoint = `${apiBase}/admin/phoenix/plugin/migration-plan?moduleId=${encodeURIComponent(plugin.candidate.manifest.moduleId)}`;
        const plan = await adminApiJson(endpoint, authorization);
        const result: AdminPluginDryRunResponse = {
          moduleId: plugin.candidate.manifest.moduleId,
          endpoint,
          plan,
          policy: "只读 dry-run；执行、备份证明和一次性 plan claim 仍由 Admin Node 受控发布流程负责。",
        };
        json(response, 200, result);
        return true;
      }

      const adminPluginMatch = /^\/api\/admin-plugins\/([a-z][a-z0-9-]{1,63})(?:\/(mount|unmount))?$/.exec(url.pathname);
      if (adminPluginMatch) {
        const workspace = requireAdminPluginWorkspace(adminPluginWorkspace);
        const [, pluginId, action] = adminPluginMatch;
        if (request.method === "GET" && !action) json(response, 200, workspace.status(pluginId));
        else if (request.method === "PATCH" && !action) {
          const body = await readJson(request);
          json(response, 200, workspace.repoint(pluginId, String(body.directory ?? "")));
        } else if (request.method === "DELETE" && !action) {
          await readJson(request);
          json(response, 200, { removed: true, plugin: workspace.remove(pluginId) });
        } else if (request.method === "POST" && action === "mount") {
          await readJson(request);
          json(response, 200, workspace.mount(pluginId));
        } else if (request.method === "POST" && action === "unmount") {
          await readJson(request);
          json(response, 200, workspace.unmount(pluginId));
        } else throw new DevHubError("METHOD_NOT_ALLOWED", "请求方法不支持", 405);
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/config/export") {
        const body: DevHubConfigurationDocument = {
          format: "phoenix-dev-hub-config",
          version: 2,
          series: builtinServiceConfig.sourceDocument().series,
          hiddenServiceIds: builtinServiceConfig.hiddenServiceIds(),
          projects: projectConfig.exportDocument().projects,
        };
        json(response, 200, body);
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/config/import") {
        const body = await readJson(request);
        if (body.format !== "phoenix-dev-hub-config" || !Array.isArray(body.projects)) {
          throw new DevHubError(
            "INVALID_CONFIG_IMPORT",
            "导入配置必须使用 phoenix-dev-hub-config version=1 或 version=2 格式",
            400,
          );
        }
        const version1 = body.version === 1 && Array.isArray(body.services);
        const version2 = body.version === 2
          && Array.isArray(body.series)
          && Array.isArray(body.hiddenServiceIds);
        if (!version1 && !version2) {
          throw new DevHubError("INVALID_CONFIG_IMPORT", "配置版本或字段不完整", 400);
        }
        const previousBuiltinIds = builtinServiceConfig.effectiveDefinitions().map((definition) => definition.id);
        const builtinPlan = version1
          ? builtinServiceConfig.prepareImport(body.services as readonly unknown[])
          : undefined;
        const seriesPlan = version2
          ? builtinServiceConfig.prepareSeriesImport(
              body.series as readonly unknown[],
              body.hiddenServiceIds as readonly unknown[],
            )
          : undefined;
        const projectPlan = projectConfig.prepareImport({
          format: "phoenix-dev-hub-projects",
          version: 1,
          projects: body.projects,
        }, manager.serviceIds());
        const registeredBefore = manager.serviceIds();
        assertBuiltinDefinitionsMutable(manager, previousBuiltinIds);
        for (const definition of builtinPlan?.definitions ?? []) {
          if (registeredBefore.has(definition.id)) manager.assertDefinitionMutable(definition.id);
        }
        for (const change of projectPlan.updated) manager.assertDefinitionMutable(change.project.serviceId);

        const builtinDefinitions = builtinPlan
          ? builtinServiceConfig.commitImport(builtinPlan)
          : builtinServiceConfig.commitSeriesImport(seriesPlan!);
        projectConfig.commitImport(projectPlan);
        synchronizeBuiltinDefinitions(manager, previousBuiltinIds, builtinServiceConfig.effectiveDefinitions());
        for (const change of projectPlan.updated) manager.replaceDefinition(change.definition);
        for (const change of projectPlan.added) manager.register(change.definition);
        const changedIds = [
          ...builtinDefinitions.map((definition) => definition.id),
          ...projectPlan.updated.map((change) => change.project.serviceId),
          ...projectPlan.added.map((change) => change.project.serviceId),
        ];
        json(response, 200, {
          builtinUpdated: builtinDefinitions.length,
          seriesUpdated: seriesPlan?.series.length,
          projectsAdded: projectPlan.added.length,
          projectsUpdated: projectPlan.updated.length,
          services: await Promise.all(changedIds.map((serviceId) => manager.status(serviceId))),
        });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/service-config/reset") {
        await readJson(request);
        const previousIds = builtinServiceConfig.effectiveDefinitions().map((definition) => definition.id);
        assertBuiltinDefinitionsMutable(manager, previousIds);
        const reset = builtinServiceConfig.reset();
        synchronizeBuiltinDefinitions(manager, previousIds, reset);
        json(response, 200, builtinServiceConfig.catalog());
        return true;
      }

      const builtinSeriesMatch = /^\/api\/service-series\/([a-z][a-z0-9-]{1,63})$/.exec(url.pathname);
      if (builtinSeriesMatch) {
        if (request.method !== "PATCH") {
          throw new DevHubError("METHOD_NOT_ALLOWED", "请求方法不支持", 405);
        }
        const seriesId = builtinSeriesMatch[1];
        const previous = builtinServiceConfig.effectiveDefinitions();
        const affected = previous.filter((definition) => definition.seriesId === seriesId);
        assertBuiltinDefinitionsMutable(manager, affected.map((definition) => definition.id));
        const body = await readJson(request);
        builtinServiceConfig.updateSeries(seriesId, body);
        const next = builtinServiceConfig.effectiveDefinitions();
        synchronizeBuiltinDefinitions(
          manager,
          affected.map((definition) => definition.id),
          next.filter((definition) => definition.seriesId === seriesId),
        );
        json(response, 200, builtinServiceConfig.catalog().series.find((entry) => entry.id === seriesId));
        return true;
      }

      const builtinServiceMatch = /^\/api\/service-config\/([a-z][a-z0-9-]{1,63})$/.exec(url.pathname);
      if (builtinServiceMatch) {
        const serviceId = builtinServiceMatch[1];
        const registered = manager.serviceIds().has(serviceId);
        if (request.method === "PATCH") {
          const body = await readJson(request);
          if (registered) manager.assertDefinitionMutable(serviceId);
          const definition = builtinServiceConfig.update(serviceId, body);
          if (registered) manager.replaceDefinition(definition);
          else manager.register(definition);
          json(response, 200, await manager.status(serviceId));
          return true;
        }
        if (request.method === "DELETE") {
          if (!registered) throw new DevHubError("BUILTIN_SERVICE_REMOVED", "该默认服务已隐藏", 409);
          manager.assertDefinitionMutable(serviceId);
          builtinServiceConfig.remove(serviceId);
          manager.unregister(serviceId);
          json(response, 200, { removed: true, serviceId });
          return true;
        }
        if (request.method === "POST") {
          await readJson(request);
          if (registered) {
            throw new DevHubError("BUILTIN_SERVICE_NOT_REMOVED", "该默认服务当前未隐藏", 409);
          }
          const definition = builtinServiceConfig.restore(serviceId);
          manager.register(definition);
          json(response, 200, await manager.status(serviceId));
          return true;
        }
        throw new DevHubError("METHOD_NOT_ALLOWED", "请求方法不支持", 405);
      }
      if (request.method === "GET" && url.pathname === "/api/projects/export") {
        json(response, 200, projectConfig.exportDocument());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/projects/inspect") {
        const body = await readJson(request);
        json(response, 200, projectConfig.inspect(String(body.directory ?? "")));
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/projects") {
        const body = await readJson(request) as unknown as AddLocalProjectRequest;
        const added = projectConfig.add(
          String(body.directory ?? ""),
          String(body.script ?? ""),
          manager.serviceIds(),
          typeof body.name === "string" ? body.name : undefined,
        );
        manager.register(added.definition);
        json(response, 201, {
          project: added.project,
          service: await manager.status(added.definition.id),
        });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/projects/import") {
        const body = await readJson(request);
        const plan = projectConfig.prepareImport(body, manager.serviceIds());
        for (const change of plan.updated) {
          manager.assertDefinitionMutable(change.project.serviceId);
        }
        projectConfig.commitImport(plan);
        for (const change of plan.updated) manager.replaceDefinition(change.definition);
        for (const change of plan.added) manager.register(change.definition);
        json(response, 200, {
          projects: projectConfig.listProjects(),
          added: plan.added.length,
          updated: plan.updated.length,
          services: await Promise.all([
            ...plan.added,
            ...plan.updated,
          ].map((change) => manager.status(change.project.serviceId))),
        });
        return true;
      }

      const projectMatch = /^\/api\/projects\/([a-z][a-z0-9-]{1,63})$/.exec(url.pathname);
      if (projectMatch) {
        const projectId = projectMatch[1];
        const project = projectConfig.listProjects().find((item) => item.id === projectId);
        if (!project) throw new DevHubError("PROJECT_NOT_FOUND", `未知本机项目：${projectId}`, 404);
        if (request.method === "PATCH") {
          const body = await readJson(request) as unknown as UpdateLocalProjectRequest;
          manager.assertDefinitionMutable(project.serviceId);
          const updated = projectConfig.update(
            projectId,
            String(body.directory ?? ""),
            String(body.script ?? ""),
            typeof body.name === "string" ? body.name : undefined,
          );
          manager.replaceDefinition(updated.definition);
          json(response, 200, {
            project: updated.project,
            service: await manager.status(updated.project.serviceId),
          });
          return true;
        }
        if (request.method === "DELETE") {
          manager.assertDefinitionMutable(project.serviceId);
          const removed = projectConfig.remove(projectId);
          manager.unregister(project.serviceId);
          json(response, 200, { removed: true, project: removed });
          return true;
        }
        throw new DevHubError("METHOD_NOT_ALLOWED", "请求方法不支持", 405);
      }

      const clearLogsMatch = /^\/api\/services\/([a-z][a-z0-9-]{1,63})\/logs\/clear$/.exec(
        url.pathname,
      );
      if (clearLogsMatch) {
        if (request.method !== "POST") {
          throw new DevHubError("METHOD_NOT_ALLOWED", "请求方法不支持", 405);
        }
        await readJson(request);
        json(response, 200, await manager.clearLogs(clearLogsMatch[1]));
        return true;
      }

      const match = /^\/api\/services\/([a-z][a-z0-9-]{1,63})(?:\/(start|stop|restart|logs|terminal|database))?$/.exec(
        url.pathname,
      );
      if (!match) throw new DevHubError("API_NOT_FOUND", "API 路径不存在", 404);
      const [, serviceId, action] = match;
      if (request.method === "GET" && !action) {
        json(response, 200, await manager.status(serviceId));
      } else if (request.method === "GET" && action === "logs") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const generation = Number(url.searchParams.get("generation"));
        json(response, 200, await manager.logs(
          serviceId,
          Number.isInteger(after) && after >= 0 ? after : 0,
          Number.isInteger(generation) && generation > 0 ? generation : undefined,
        ));
      } else if (request.method === "POST" && action === "start") {
        await readJson(request);
        json(response, 202, await manager.start(serviceId));
      } else if (request.method === "POST" && action === "stop") {
        const body = await readJson(request) as StopServiceRequest;
        json(response, 200, await manager.stop(serviceId, {
          mode: body.mode,
          token: typeof body.token === "string" ? body.token : undefined,
        }));
      } else if (request.method === "POST" && action === "restart") {
        await readJson(request);
        json(response, 202, await manager.restart(serviceId));
      } else if (request.method === "POST" && action === "database") {
        const body = await readJson(request);
        json(response, 201, await manager.createProfileDatabase(
          serviceId,
          typeof body.confirm === "string" ? body.confirm : "",
        ));
      } else if (request.method === "POST" && action === "terminal") {
        await readJson(request);
        json(response, 200, await manager.openSystemTerminal(serviceId));
      } else {
        throw new DevHubError("METHOD_NOT_ALLOWED", "请求方法不支持", 405);
      }
      return true;
    } catch (error) {
      const resolved = errorResponse(error);
      json(response, resolved.statusCode, resolved.body);
      return true;
    }
  };
}
