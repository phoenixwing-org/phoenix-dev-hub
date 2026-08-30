import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BuiltinServiceConfigCatalogResponse,
  HubConfigurationDocument,
  LocalProjectTransferDocument,
  ServiceDefinition,
  ServiceProfileDatabaseCreationEvidence,
  ServiceRuntimeStatus,
} from "../shared/contracts.js";
import { createApiHandler } from "./api.js";
import { PnhBuiltinServiceConfigStore } from "./PnhBuiltinServiceConfig.js";
import { PnhProjectConfigStore } from "./PnhProjectConfig.js";
import { PnhServiceManager } from "./PnhServiceManager.js";
import { PnhSystemTerminal } from "./PnhSystemTerminal.js";

const roots: string[] = [];
const servers: Server[] = [];

class CapturingTerminal extends PnhSystemTerminal {
  readonly directories: string[] = [];

  override capability() {
    return { available: true, label: "Test Terminal" } as const;
  }

  override async open(serviceId: string, directory: string) {
    this.directories.push(directory);
    return { opened: true, serviceId, terminalLabel: "Test Terminal" } as const;
  }
}

function nodeProject(directory: string, name: string): void {
  mkdirSync(directory);
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    name,
    scripts: { dev: "vite", test: "vitest run" },
  }));
}

async function createFixture(includeBuiltin = false): Promise<{
  readonly baseUrl: string;
  readonly first: string;
  readonly second: string;
  readonly baseline: ServiceDefinition;
  readonly shutdownRequests: string[];
  readonly restartRequests: string[];
  readonly databaseCreateRequests: readonly { serviceId: string; confirm: string }[];
  readonly terminalDirectories: readonly string[];
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), "pnh-api-projects-"));
  roots.push(root);
  const hub = path.join(root, "phoenix-hub");
  const first = path.join(root, "first-app");
  const second = path.join(root, "second-app");
  mkdirSync(hub);
  nodeProject(first, "first-app");
  nodeProject(second, "second-app");

  const baseline: ServiceDefinition = {
    id: "default-web",
    name: "Default Web",
    moduleId: "default-site",
    moduleName: "Default Site",
    description: "baseline",
    cwd: first,
    command: { executable: "node", args: ["server.js"] },
    endpoints: [{ id: "web", label: "Web", port: 64_532, required: true }],
    externalStop: "deny",
  };
  const projectConfig = new PnhProjectConfigStore(hub);
  const builtinServiceConfig = new PnhBuiltinServiceConfigStore(hub, includeBuiltin ? [baseline] : []);
  const terminal = new CapturingTerminal();
  const manager = new PnhServiceManager(builtinServiceConfig.effectiveDefinitions(), terminal);
  const restartRequests: string[] = [];
  manager.restart = async (serviceId: string) => {
    restartRequests.push(serviceId);
    return manager.status(serviceId);
  };
  const databaseCreateRequests: { serviceId: string; confirm: string }[] = [];
  manager.createProfileDatabase = async (serviceId: string, confirm: string): Promise<ServiceProfileDatabaseCreationEvidence> => {
    databaseCreateRequests.push({ serviceId, confirm });
    return {
      state: "ready",
      databaseName: "fixture_release_validation_20260804",
      server: "127.0.0.1:5432/postgres",
      exists: true,
      message: "已创建",
      checkedAt: new Date().toISOString(),
      existingBefore: false,
      createdAt: new Date().toISOString(),
      cleanupResponsibility: "fixture cleanup",
      evidenceFile: "database-evidence/fixture.json",
    };
  };
  const shutdownRequests: string[] = [];
  const handleApi = createApiHandler(manager, projectConfig, builtinServiceConfig, undefined, {
    projectRoot: hub,
    version: "test-version",
    address: "http://127.0.0.1:42100",
    requestShutdown: () => shutdownRequests.push("requested"),
  });
  const server = createServer((request, response) => void handleApi(request, response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得测试 API 端口");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    first,
    second,
    baseline,
    shutdownRequests,
    restartRequests,
    databaseCreateRequests,
    terminalDirectories: terminal.directories,
  };
}

async function jsonRequest<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(parsed.error ?? `HTTP ${response.status}`);
  return parsed;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("项目配置 API", () => {
  it("只从后端固定信息展示 Hub 设置，并要求明确确认后异步关闭", async () => {
    const fixture = await createFixture();
    const info = await jsonRequest<{
      version: string;
      projectRoot: string;
      restartSupported: boolean;
    }>(`${fixture.baseUrl}/api/hub`);
    expect(info).toMatchObject({
      version: "test-version",
      projectRoot: path.join(path.dirname(fixture.first), "phoenix-hub"),
      restartSupported: false,
    });

    const terminal = await jsonRequest<{ opened: true; serviceId: string }>(
      `${fixture.baseUrl}/api/hub/terminal`,
      "POST",
      { directory: "/tmp/evil", command: "ignored" },
    );
    expect(terminal).toMatchObject({ opened: true, serviceId: "phoenix-hub" });
    expect(fixture.terminalDirectories).toEqual([info.projectRoot]);

    const rejected = await fetch(`${fixture.baseUrl}/api/hub/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "no" }),
    });
    expect(rejected.status).toBe(409);
    expect(fixture.shutdownRequests).toEqual([]);

    const accepted = await jsonRequest<{ accepted: true }>(
      `${fixture.baseUrl}/api/hub/shutdown`,
      "POST",
      { confirm: "shutdown-phoenix-hub" },
    );
    expect(accepted.accepted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fixture.shutdownRequests).toEqual(["requested"]);
  });

  it("将通用服务 restart API 路由到受控 Manager", async () => {
    const fixture = await createFixture(true);
    const status = await jsonRequest<ServiceRuntimeStatus>(
      `${fixture.baseUrl}/api/services/${fixture.baseline.id}/restart`,
      "POST",
      {},
    );
    expect(status.definition.id).toBe(fixture.baseline.id);
    expect(fixture.restartRequests).toEqual([fixture.baseline.id]);
  });

  it("显式数据库 API 只转发固定服务 ID 与确认文本", async () => {
    const fixture = await createFixture(true);
    const confirmation = "create-release-validation-database:fixture_release_validation_20260804";
    const evidence = await jsonRequest<ServiceProfileDatabaseCreationEvidence>(
      `${fixture.baseUrl}/api/services/${fixture.baseline.id}/database`,
      "POST",
      { confirm: confirmation, password: "must-be-ignored", dsn: "must-be-ignored" },
    );
    expect(evidence).toMatchObject({ state: "ready", existingBefore: false });
    expect(fixture.databaseCreateRequests).toEqual([{
      serviceId: fixture.baseline.id,
      confirm: confirmation,
    }]);
    expect(JSON.stringify(evidence)).not.toContain("must-be-ignored");
  });

  it("完成添加、编辑、导出、合并导入和删除闭环", async () => {
    const fixture = await createFixture();
    const added = await jsonRequest<{
      project: { id: string; serviceId: string };
    }>(`${fixture.baseUrl}/api/projects`, "POST", {
      directory: fixture.first,
      script: "dev",
      name: "第一个项目",
    });

    const updated = await jsonRequest<{
      project: { id: string; serviceId: string; name: string; script: string };
    }>(`${fixture.baseUrl}/api/projects/${added.project.id}`, "PATCH", {
      directory: fixture.first,
      script: "test",
      name: "已编辑项目",
    });
    expect(updated.project).toMatchObject({
      serviceId: added.project.serviceId,
      name: "已编辑项目",
      script: "test",
    });

    const exported = await jsonRequest<LocalProjectTransferDocument>(
      `${fixture.baseUrl}/api/projects/export`,
    );
    expect(exported.projects).toHaveLength(1);
    const imported = await jsonRequest<{ added: number; updated: number; projects: unknown[] }>(
      `${fixture.baseUrl}/api/projects/import`,
      "POST",
      {
        ...exported,
        projects: [
          { ...exported.projects[0], name: "再次更新", script: "dev" },
          { name: "第二个项目", directory: fixture.second, script: "dev" },
        ],
      },
    );
    expect(imported).toMatchObject({ added: 1, updated: 1 });
    expect(imported.projects).toHaveLength(2);

    const removed = await jsonRequest<{ removed: true }>(
      `${fixture.baseUrl}/api/projects/${added.project.id}`,
      "DELETE",
      {},
    );
    expect(removed.removed).toBe(true);
    const services = await jsonRequest<{ services: unknown[] }>(`${fixture.baseUrl}/api/services`);
    expect(services.services).toHaveLength(1);
  });

  it("完成默认服务标记、覆盖、总配置导出导入、隐藏显示与重置闭环", async () => {
    const fixture = await createFixture(true);
    const initial = await jsonRequest<BuiltinServiceConfigCatalogResponse>(
      `${fixture.baseUrl}/api/service-config`,
    );
    expect(initial.services[0]).toMatchObject({
      id: fixture.baseline.id,
      source: "builtin",
      overridden: false,
      removed: false,
    });

    const updated = await jsonRequest<ServiceRuntimeStatus>(
      `${fixture.baseUrl}/api/service-config/${fixture.baseline.id}`,
      "PATCH",
      { ...fixture.baseline, name: "本机默认 Web" },
    );
    expect(updated.definition).toMatchObject({
      name: "本机默认 Web",
      configurationSource: "builtin",
      configurationOverridden: true,
    });

    const exported = await jsonRequest<HubConfigurationDocument>(
      `${fixture.baseUrl}/api/config/export`,
    );
    expect(exported).toMatchObject({ format: "phoenix-hub-config", version: 2 });
    if (exported.version !== 2) throw new Error("期望 version 2 配置");
    expect(exported.series).toHaveLength(1);
    const exportedSeries = exported.series[0]!;
    const exportedProfile = exportedSeries.profiles[0]!;
    const exportedService = exportedProfile.services[fixture.baseline.id];
    if (!exportedService) throw new Error("缺少导出服务");

    const imported = await jsonRequest<{ builtinUpdated: number; projectsAdded: number }>(
      `${fixture.baseUrl}/api/config/import`,
      "POST",
      {
        ...exported,
        series: [{
          ...exportedSeries,
          profiles: [{
            ...exportedProfile,
            services: {
              ...exportedProfile.services,
              [fixture.baseline.id]: { ...exportedService, name: "导入后的默认 Web" },
            },
          }],
        }],
      },
    );
    expect(imported).toMatchObject({ builtinUpdated: 1, projectsAdded: 0 });

    await jsonRequest(
      `${fixture.baseUrl}/api/service-config/${fixture.baseline.id}`,
      "DELETE",
      {},
    );
    const removed = await jsonRequest<BuiltinServiceConfigCatalogResponse>(
      `${fixture.baseUrl}/api/service-config`,
    );
    expect(removed.services[0]).toMatchObject({ removed: true, overridden: false });

    const restored = await jsonRequest<ServiceRuntimeStatus>(
      `${fixture.baseUrl}/api/service-config/${fixture.baseline.id}`,
      "POST",
      {},
    );
    expect(restored.definition).toMatchObject({
      name: "Default Web",
      configurationSource: "builtin",
      configurationOverridden: false,
    });

    await jsonRequest(
      `${fixture.baseUrl}/api/service-config/${fixture.baseline.id}`,
      "DELETE",
      {},
    );

    const reset = await jsonRequest<BuiltinServiceConfigCatalogResponse>(
      `${fixture.baseUrl}/api/service-config/reset`,
      "POST",
      {},
    );
    expect(reset.services[0]).toMatchObject({ removed: false, overridden: false });
    expect(reset.services[0].definition?.name).toBe("Default Web");
  }, 20_000);
});
