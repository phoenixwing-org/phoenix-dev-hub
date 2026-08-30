import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ServiceDefinition,
  ServiceRuntimeStatus,
  StopTargetDetails,
} from "../shared/contracts.js";
import { DevHubError } from "./errors.js";
import {
  PDH_CONTROLLED_TOOL_PROFILE_ENV,
  PdhControlledToolProfileResolver,
  serializePdhControlledToolProfile,
} from "./PdhControlledToolProfileResolver.js";
import {
  PDH_SERVICE_SPAWN_SHELL,
  PdhServiceManager,
  pdhServiceSpawnEnvironment,
} from "./PdhServiceManager.js";
import {
  PdhMemoryServiceOwnershipStore,
  PdhServiceOwnershipStore,
  pdhServiceDefinitionIdentity,
} from "./PdhServiceOwnershipStore.js";
import { describeProcess } from "./processDiscovery.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = path.join(projectRoot, "test/fixtures/http-service.mjs");
const watchFixturePath = path.join(projectRoot, "test/fixtures/watch-service.mjs");
const stubbornFixturePath = path.join(projectRoot, "test/fixtures/stubborn-service.mjs");
const buildWatchFixturePath = path.join(projectRoot, "test/fixtures/build-watch-service.mjs");
const environmentFixturePath = path.join(projectRoot, "test/fixtures/environment-service.mjs");
const routedHealthFixturePath = path.join(projectRoot, "test/fixtures/routed-health-service.mjs");
const managers: PdhServiceManager[] = [];
const externalChildren: ChildProcess[] = [];
const temporaryRoots: string[] = [];
const platformTimeout = (milliseconds: number): number => (
  process.platform === "win32" ? milliseconds * 3 : milliseconds
);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配测试端口");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function definition(
  id: string,
  port: number,
  fixture = fixturePath,
  cwd = projectRoot,
  extraEndpoints: ServiceDefinition["endpoints"] = [],
): ServiceDefinition {
  return {
    id,
    name: id,
    moduleId: `${id}-site`,
    moduleName: `${id} site`,
    cwd,
    command: { executable: process.execPath, args: [fixture, String(port)] },
    endpoints: [{
      id: "web",
      label: "Web",
      port,
      openUrl: `http://127.0.0.1:${port}/`,
      healthUrl: `http://127.0.0.1:${port}/`,
      required: true,
    }, ...extraEndpoints],
    externalStop: "confirm-matching-cwd",
  };
}

async function waitForState(
  manager: PdhServiceManager,
  serviceId: string,
  predicate: (status: ServiceRuntimeStatus) => boolean,
  timeoutMs = 6_000,
): Promise<ServiceRuntimeStatus> {
  const deadline = Date.now() + timeoutMs;
  let latest = await manager.status(serviceId);
  while (!predicate(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = await manager.status(serviceId);
  }
  return latest;
}

async function spawnExternal(
  fixture: string,
  port: number,
  cwd = projectRoot,
  args: readonly string[] = [],
): Promise<ChildProcess> {
  const child = spawn(process.execPath, [fixture, String(port), ...args], {
    cwd,
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  externalChildren.push(child);
  return child;
}

async function waitForProcess(child: ChildProcess): Promise<NonNullable<Awaited<ReturnType<typeof describeProcess>>>> {
  if (!child.pid) throw new Error("测试进程没有 PID");
  const deadline = Date.now() + 3_000;
  let process = await describeProcess(child.pid);
  while (!process?.startedAt && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    process = await describeProcess(child.pid);
  }
  if (!process?.startedAt) throw new Error(`无法取得测试进程 ${child.pid} 的身份`);
  return process;
}

async function exactFixtureCleanup(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // 测试目标已退出。
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function captureStopDetails(
  action: () => Promise<unknown>,
  code: string,
): Promise<StopTargetDetails> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(DevHubError);
    expect((error as DevHubError).code).toBe(code);
    return (error as DevHubError).details as StopTargetDetails;
  }
  throw new Error(`期望 ${code}`);
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.stopAllManaged()));
  await Promise.allSettled(externalChildren.splice(0).map(exactFixtureCleanup));
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PdhServiceManager", () => {
  it("Hub 重启后精确复核并恢复原 ownership，不把同一 PGID 误报为 external", async () => {
    const port = await freePort();
    const service = definition("recover-owned", port);
    const runtimeRoot = mkdtempSync(path.join(tmpdir(), "pdh-ownership-recovery-"));
    temporaryRoots.push(runtimeRoot);
    const firstManager = new PdhServiceManager(
      [service],
      undefined,
      undefined,
      undefined,
      undefined,
      new PdhServiceOwnershipStore(runtimeRoot),
    );
    managers.push(firstManager);

    const started = await firstManager.start(service.id);
    const ready = await waitForState(firstManager, service.id, (status) => status.health === "ready");
    expect(started.ownershipId).toBeTruthy();

    const reloadedManager = new PdhServiceManager(
      [service],
      undefined,
      undefined,
      undefined,
      undefined,
      new PdhServiceOwnershipStore(runtimeRoot),
    );
    managers.push(reloadedManager);
    const recovered = await waitForState(reloadedManager, service.id, (status) => status.health === "ready");

    expect(recovered).toMatchObject({
      lifecycle: "running",
      ownership: "hub",
      managed: true,
      pid: ready.pid,
      processGroupId: ready.processGroupId,
      ownershipId: ready.ownershipId,
      logSource: "recovered-ownership",
      build: { state: "unknown" },
    });
    await expect(reloadedManager.logs(service.id)).resolves.toMatchObject({
      available: false,
      source: "recovered-ownership",
      message: expect.stringContaining("无法重新接入"),
    });

    await reloadedManager.stop(service.id);
    expect(await waitForState(reloadedManager, service.id, (status) => status.lifecycle === "stopped"))
      .toMatchObject({ ownership: "none", managed: false });
    expect(new PdhServiceOwnershipStore(runtimeRoot).entries()).toHaveLength(0);
  }, platformTimeout(20_000));

  it("持久记录 PID 身份过期时撤销恢复并按外部进程重新检测", async () => {
    const port = await freePort();
    const service = definition("stale-owned", port);
    const child = await spawnExternal(fixturePath, port);
    const root = await waitForProcess(child);
    const store = new PdhMemoryServiceOwnershipStore([{
      serviceId: service.id,
      ownershipId: "stale-ownership",
      root: { ...root, startedAt: `${root.startedAt}-reused` },
      startedAt: new Date().toISOString(),
      ports: [port],
      definitionIdentity: pdhServiceDefinitionIdentity(service),
    }]);
    const manager = new PdhServiceManager(
      [service], undefined, undefined, undefined, undefined, store,
    );
    managers.push(manager);

    expect(await waitForState(manager, service.id, (status) => status.lifecycle === "external"))
      .toMatchObject({ ownership: "external", managed: false, logSource: "monitoring-only" });
    expect(store.entries()).toHaveLength(0);
  }, platformTimeout(15_000));

  it("恢复时端口已换主则拒绝 Hub ownership，且不得误杀任一外部进程", async () => {
    const targetPort = await freePort();
    const otherPort = await freePort();
    const service = definition("changed-port-owner", targetPort);
    const target = await spawnExternal(fixturePath, targetPort);
    const recordedRootChild = await spawnExternal(fixturePath, otherPort);
    const recordedRoot = await waitForProcess(recordedRootChild);
    const store = new PdhMemoryServiceOwnershipStore([{
      serviceId: service.id,
      ownershipId: "old-ownership",
      root: recordedRoot,
      startedAt: new Date().toISOString(),
      ports: [targetPort],
      definitionIdentity: pdhServiceDefinitionIdentity(service),
    }]);
    const manager = new PdhServiceManager(
      [service], undefined, undefined, undefined, undefined, store,
    );
    managers.push(manager);

    expect(await waitForState(manager, service.id, (status) => status.lifecycle === "external"))
      .toMatchObject({ ownership: "external", managed: false });
    expect(store.entries()).toHaveLength(0);
    expect(await describeProcess(target.pid!)).toBeTruthy();
    expect(await describeProcess(recordedRootChild.pid!)).toBeTruthy();
  }, 15_000);

  it("配置路径失效时显示不健康并在 spawn 前拒绝启动", async () => {
    const port = await freePort();
    const runtimeEnvProvider = vi.fn(() => ({}));
    const service = {
      ...definition("invalid-config", port),
      cwd: path.join(projectRoot, "deleted-worktree"),
      configurationErrors: ["工作目录不存在：deleted-worktree"],
    };
    const manager = new PdhServiceManager([service], undefined, runtimeEnvProvider);
    managers.push(manager);

    await expect(manager.status(service.id)).resolves.toMatchObject({
      lifecycle: "stopped",
      health: "unhealthy",
      managed: false,
      message: expect.stringContaining("配置错误"),
      endpoints: [{ probeState: "unreachable", pids: [] }],
    });
    await expect(manager.list()).resolves.toMatchObject({
      configurationErrors: [expect.stringMatching(/工作目录不存在.*影响：invalid-config/)],
      services: [{ definition: { id: service.id }, health: "unhealthy" }],
    });
    await expect(manager.start(service.id)).rejects.toMatchObject({
      code: "SERVICE_CONFIG_INVALID",
      statusCode: 409,
    });
    expect(runtimeEnvProvider).not.toHaveBeenCalled();
  });

  it("固定 process → command → Hub runtime 环境顺序，并清除父进程与用户伪造的保留键", () => {
    const service: ServiceDefinition = {
      ...definition("environment-merge", 1),
      command: {
        executable: process.execPath,
        args: [environmentFixturePath, "1"],
        env: {
          SHARED_VALUE: "command",
          PHOENIX_DEV_HUB_SERVICE_ID: "user-service-id",
          [PDH_CONTROLLED_TOOL_PROFILE_ENV]: "user-profile",
        },
      },
    };
    const environment = pdhServiceSpawnEnvironment(service, {
      SHARED_VALUE: "runtime",
      [PDH_CONTROLLED_TOOL_PROFILE_ENV]: "trusted-profile",
    }, {
      SHARED_VALUE: "process",
      PROCESS_ONLY: "kept",
      PHOENIX_DEV_HUB_SERVICE_ID: "parent-service-id",
      [PDH_CONTROLLED_TOOL_PROFILE_ENV]: "parent-profile",
    });

    expect(environment).toMatchObject({
      PROCESS_ONLY: "kept",
      SHARED_VALUE: "runtime",
      PHOENIX_DEV_HUB_SERVICE_ID: service.id,
      [PDH_CONTROLLED_TOOL_PROFILE_ENV]: "trusted-profile",
    });
    expect(PDH_SERVICE_SPAWN_SHELL).toBe(false);
  });

  it("start 最后注入保留 Profile；unavailable 不阻止目标服务，其他服务不继承 Profile", async () => {
    const [targetPort, otherPort] = await Promise.all([freePort(), freePort()]);
    const keys = [PDH_CONTROLLED_TOOL_PROFILE_ENV, "PHOENIX_DEV_HUB_SERVICE_ID", "SHARED_VALUE"];
    const target: ServiceDefinition = {
      ...definition("profile-target", targetPort, environmentFixturePath),
      command: {
        executable: process.execPath,
        args: [environmentFixturePath, String(targetPort), ...keys],
        env: {
          SHARED_VALUE: "command",
          PHOENIX_DEV_HUB_SERVICE_ID: "forged-service",
          [PDH_CONTROLLED_TOOL_PROFILE_ENV]: "forged-profile",
        },
      },
    };
    const other: ServiceDefinition = {
      ...definition("profile-other", otherPort, environmentFixturePath),
      command: {
        executable: process.execPath,
        args: [environmentFixturePath, String(otherPort), ...keys],
        env: {
          SHARED_VALUE: "command",
          [PDH_CONTROLLED_TOOL_PROFILE_ENV]: "forged-other-profile",
        },
      },
    };
    const unavailableProfile = new PdhControlledToolProfileResolver().resolve(
      path.join(tmpdir(), "pdh-controlled-tool-missing-host"),
    );
    expect(unavailableProfile).toMatchObject({
      availability: "unavailable",
      unavailableReason: { code: "HOST_ROOT_UNAVAILABLE" },
    });
    const manager = new PdhServiceManager([target, other], undefined, (service) => (
      service.id === target.id
        ? {
            SHARED_VALUE: "runtime",
            [PDH_CONTROLLED_TOOL_PROFILE_ENV]: serializePdhControlledToolProfile(unavailableProfile),
          }
        : {}
    ));
    managers.push(manager);

    await Promise.all([manager.start(target.id), manager.start(other.id)]);
    await Promise.all([
      waitForState(manager, target.id, (status) => status.health === "ready"),
      waitForState(manager, other.id, (status) => status.health === "ready"),
    ]);
    const targetEnvironment = await fetch(`http://127.0.0.1:${targetPort}/`).then((response) => response.json()) as Record<string, string | null>;
    const otherEnvironment = await fetch(`http://127.0.0.1:${otherPort}/`).then((response) => response.json()) as Record<string, string | null>;
    expect(JSON.parse(targetEnvironment[PDH_CONTROLLED_TOOL_PROFILE_ENV]!)).toMatchObject({
      availability: "unavailable",
      unavailableReason: { code: "HOST_ROOT_UNAVAILABLE" },
    });
    expect(targetEnvironment).toMatchObject({
      PHOENIX_DEV_HUB_SERVICE_ID: target.id,
      SHARED_VALUE: "runtime",
    });
    expect(otherEnvironment).toMatchObject({
      [PDH_CONTROLLED_TOOL_PROFILE_ENV]: null,
      PHOENIX_DEV_HUB_SERVICE_ID: other.id,
      SHARED_VALUE: "command",
    });
    const targetLogs = await manager.logs(target.id);
    expect(targetLogs.entries.some((entry) => entry.text.includes("HOST_ROOT_UNAVAILABLE"))).toBe(true);
    expect(targetLogs.entries.some((entry) => entry.text.includes("pdh-controlled-tool-missing-host"))).toBe(false);
  }, 15_000);

  it("启动失败不会缓存 runtime env，修正定义后重新启动会调用最新 Provider", async () => {
    const port = await freePort();
    const failed: ServiceDefinition = {
      ...definition("profile-retry", port, environmentFixturePath),
      command: {
        executable: path.join(tmpdir(), "pdh-missing-executable"),
        args: [],
      },
    };
    let providerCalls = 0;
    const manager = new PdhServiceManager([failed], undefined, () => ({
      [PDH_CONTROLLED_TOOL_PROFILE_ENV]: JSON.stringify({ marker: ++providerCalls }),
    }));
    managers.push(manager);

    await expect(manager.start(failed.id)).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(providerCalls).toBe(1);
    manager.replaceDefinition({
      ...failed,
      command: {
        executable: process.execPath,
        args: [environmentFixturePath, String(port), PDH_CONTROLLED_TOOL_PROFILE_ENV],
      },
    });
    await manager.start(failed.id);
    await waitForState(manager, failed.id, (status) => status.health === "ready");
    const environment = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.json()) as Record<string, string>;
    expect(JSON.parse(environment[PDH_CONTROLLED_TOOL_PROFILE_ENV]!)).toEqual({ marker: 2 });
    expect(providerCalls).toBe(2);
  }, 15_000);

  it("同一 runtimeSlot 只允许一个 Profile 活动", async () => {
    const [stablePort, developPort] = await Promise.all([freePort(), freePort()]);
    const stable = {
      ...definition("slot-stable", stablePort),
      seriesId: "slot-site",
      seriesName: "Slot Site",
      profileId: "stable",
      profileName: "稳定版",
      serviceRole: "web",
      runtimeSlot: "slot-site",
    };
    const develop = {
      ...definition("slot-develop", developPort),
      seriesId: "slot-site",
      seriesName: "Slot Site",
      profileId: "develop",
      profileName: "开发版",
      serviceRole: "web",
      runtimeSlot: "slot-site",
    };
    const manager = new PdhServiceManager([stable, develop]);
    managers.push(manager);

    await manager.start(stable.id);
    await waitForState(manager, stable.id, (status) => status.health === "ready");
    await expect(manager.start(develop.id)).rejects.toMatchObject({
      code: "RUNTIME_SLOT_OCCUPIED",
    });

    await manager.stop(stable.id);
    await manager.start(develop.id);
    expect((await waitForState(manager, develop.id, (status) => status.health === "ready")))
      .toMatchObject({ lifecycle: "running", ownership: "hub" });
  }, platformTimeout(20_000));

  it("独立 runtimeSlot 的同系列 Profile 可并行、独立重启并在 Hub 重建后恢复外部状态", async () => {
    const [developmentPort, releasePort] = await Promise.all([freePort(), freePort()]);
    const developmentRoot = mkdtempSync(path.join(tmpdir(), "pdh-admin-development-"));
    const releaseRoot = mkdtempSync(path.join(tmpdir(), "pdh-admin-release-"));
    temporaryRoots.push(developmentRoot, releaseRoot);
    const profile = (
      id: string,
      profileId: string,
      profileName: string,
      slot: string,
      cwd: string,
      port: number,
      database: string,
    ): ServiceDefinition => ({
      ...definition(id, port, fixturePath, cwd),
      moduleId: "admin-series",
      moduleName: "Admin Series",
      seriesId: "admin-series",
      seriesName: "Admin Series",
      profileId,
      profileName,
      serviceRole: "web",
      runtimeSlot: slot,
      profilePolicy: {
        environmentKind: "development",
        deploymentMode: "source-mounted",
        lifecycleControl: true,
        database: { serviceRole: "web", envName: "TEST_DB", name: database },
      },
      command: {
        executable: process.execPath,
        args: [fixturePath, String(port)],
        env: { TEST_DB: database },
      },
    });
    const development = profile(
      "admin-development",
      "development",
      "Admin 开发联调",
      "admin-development-slot",
      developmentRoot,
      developmentPort,
      "admin_development_db",
    );
    const release = profile(
      "admin-release",
      "release-validation",
      "Admin 发布包验收",
      "admin-release-slot",
      releaseRoot,
      releasePort,
      "admin_release_db",
    );
    const manager = new PdhServiceManager([development, release]);
    managers.push(manager);

    await Promise.all([manager.start(development.id), manager.start(release.id)]);
    const [developmentReady, releaseReady] = await Promise.all([
      waitForState(manager, development.id, (status) => status.health === "ready"),
      waitForState(manager, release.id, (status) => status.health === "ready"),
    ]);
    expect(developmentReady).toMatchObject({
      lifecycle: "running",
      ownership: "hub",
      profileEvidence: { state: "source-mounted", databaseName: "admin_development_db" },
    });
    expect(releaseReady).toMatchObject({
      lifecycle: "running",
      ownership: "hub",
      profileEvidence: { state: "source-mounted", databaseName: "admin_release_db" },
    });
    expect(developmentReady.pid).not.toBe(releaseReady.pid);
    expect(developmentReady.processGroupId).not.toBe(releaseReady.processGroupId);
    expect(developmentReady.rootProcess?.cwd).toBe(realpathSync(developmentRoot));
    expect(releaseReady.rootProcess?.cwd).toBe(realpathSync(releaseRoot));
    const releasePid = releaseReady.pid;

    const restarted = await manager.restart(development.id);
    const developmentRestarted = await waitForState(
      manager,
      development.id,
      (status) => status.health === "ready" && status.pid !== developmentReady.pid,
    );
    expect(restarted.definition.id).toBe(development.id);
    expect(developmentRestarted.pid).not.toBe(developmentReady.pid);
    expect((await manager.status(release.id)).pid).toBe(releasePid);
    expect((await manager.logs(development.id)).entries.some((entry) => entry.text.includes("fixture-ready"))).toBe(true);
    expect((await manager.logs(release.id)).entries.some((entry) => entry.text.includes("fixture-ready"))).toBe(true);

    const reloadedManager = new PdhServiceManager([development, release]);
    managers.push(reloadedManager);
    expect(await waitForState(reloadedManager, development.id, (status) => status.lifecycle === "external"))
      .toMatchObject({ ownership: "external", profileEvidence: { databaseName: "admin_development_db" } });
    expect(await waitForState(reloadedManager, release.id, (status) => status.lifecycle === "external"))
      .toMatchObject({ ownership: "external", profileEvidence: { databaseName: "admin_release_db" } });
  }, platformTimeout(25_000));

  it("production Profile 只允许状态探测，启动、停止与重启均 fail-closed", async () => {
    const port = await freePort();
    const service: ServiceDefinition = {
      ...definition("production-readonly", port),
      profileId: "production",
      profileName: "Production",
      profilePolicy: {
        environmentKind: "production",
        deploymentMode: "source-mounted",
        lifecycleControl: false,
        database: { serviceRole: "web", envName: "TEST_DB", name: "production_db" },
      },
    };
    const manager = new PdhServiceManager([service]);
    managers.push(manager);
    expect(await manager.status(service.id)).toMatchObject({ lifecycle: "stopped" });
    await expect(manager.start(service.id)).rejects.toMatchObject({ code: "PROFILE_LIFECYCLE_READ_ONLY" });
    await expect(manager.stop(service.id)).rejects.toMatchObject({ code: "PROFILE_LIFECYCLE_READ_ONLY" });
    await expect(manager.restart(service.id)).rejects.toMatchObject({ code: "PROFILE_LIFECYCLE_READ_ONLY" });
    expect(() => manager.openSystemTerminal(service.id)).toThrow(expect.objectContaining({
      code: "PROFILE_LIFECYCLE_READ_ONLY",
    }));
  });

  it("发布装配 preflight 失败时不创建服务进程", async () => {
    const port = await freePort();
    const service: ServiceDefinition = {
      ...definition("preflight-failed", port),
      profileId: "release-validation",
      profileName: "Release Validation",
      profilePolicy: {
        environmentKind: "release-validation",
        deploymentMode: "package-assembled",
        lifecycleControl: true,
        database: { serviceRole: "web", envName: "TEST_DB", name: "release_db" },
      },
    };
    const manager = new PdhServiceManager(
      [service],
      undefined,
      undefined,
      {
        inspect: () => ({
          state: "invalid",
          environmentKind: "release-validation",
          deploymentMode: "package-assembled",
          message: "fixture evidence invalid",
          databaseName: "release_db",
        }),
        prepare: async () => {
          throw new DevHubError("PROFILE_PREFLIGHT_FAILED", "package SHA mismatch", 409);
        },
      },
    );
    managers.push(manager);
    await expect(manager.start(service.id)).rejects.toMatchObject({ code: "PROFILE_PREFLIGHT_FAILED" });
    expect(await manager.status(service.id)).toMatchObject({
      lifecycle: "stopped",
      ownership: "none",
      profileEvidence: { state: "invalid" },
    });
  });

  it("发布验收数据库缺失时在 spawn 前停止且不会进入 keepalive 重启", async () => {
    const port = await freePort();
    const service: ServiceDefinition = {
      ...definition("database-missing", port),
      profileId: "release-validation",
      profileName: "Release Validation",
      serviceRole: "api",
      profilePolicy: {
        environmentKind: "release-validation",
        deploymentMode: "package-assembled",
        lifecycleControl: true,
        database: { serviceRole: "api", envName: "TEST_DB", name: "fixture_release_validation_20260804" },
      },
    };
    const databaseEvidence = {
      state: "missing" as const,
      databaseName: "fixture_release_validation_20260804",
      server: "127.0.0.1:5432/postgres",
      exists: false,
      message: "PostgreSQL 可达，但隔离数据库不存在",
      checkedAt: new Date().toISOString(),
    };
    const assertReady = vi.fn().mockRejectedValue(
      new DevHubError(
        "PROFILE_DATABASE_MISSING",
        "发布验收数据库不存在；已在 spawn 前阻断，未启动 keepalive 进程",
        409,
        databaseEvidence,
      ),
    );
    const manager = new PdhServiceManager(
      [service],
      undefined,
      undefined,
      {
        inspect: () => ({
          state: "verified",
          environmentKind: "release-validation",
          deploymentMode: "package-assembled",
          message: "fixture assembly verified",
          databaseName: databaseEvidence.databaseName,
        }),
        prepare: vi.fn().mockResolvedValue(undefined),
      },
      {
        inspect: vi.fn().mockResolvedValue(databaseEvidence),
        assertReady,
      },
    );
    managers.push(manager);

    await expect(manager.start(service.id)).rejects.toMatchObject({ code: "PROFILE_DATABASE_MISSING" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(assertReady).toHaveBeenCalledOnce();
    expect(await manager.status(service.id)).toMatchObject({
      lifecycle: "stopped",
      ownership: "none",
      profileEvidence: {
        state: "verified",
        database: { state: "missing", exists: false },
      },
    });
    const logs = await manager.logs(service.id);
    expect(logs.entries.filter((entry) => entry.text.includes("spawn 前阻断"))).toHaveLength(1);
    expect(logs.entries.some((entry) => entry.text.includes("fixture-ready"))).toBe(false);
  });

  it("发布验收数据库未初始化时在 spawn 前阻断且不调用装配或生成进程", async () => {
    const port = await freePort();
    const service: ServiceDefinition = {
      ...definition("database-uninitialized", port),
      profileId: "release-validation",
      serviceRole: "api",
      profilePolicy: {
        environmentKind: "release-validation",
        deploymentMode: "package-assembled",
        lifecycleControl: true,
        database: { serviceRole: "api", envName: "TEST_DB", name: "fixture_release_validation_20260804" },
      },
    };
    const databaseEvidence = {
      state: "uninitialized" as const,
      databaseName: "fixture_release_validation_20260804",
      server: "127.0.0.1:5432/postgres",
      exists: true,
      missingRelations: ["task_info", "pah_plugin_installation"],
      message: "隔离数据库存在，但缺少 2 个 Host/Pah 基线关系",
      checkedAt: new Date().toISOString(),
    };
    const prepare = vi.fn();
    const manager = new PdhServiceManager(
      [service],
      undefined,
      undefined,
      {
        inspect: () => ({
          state: "verified",
          environmentKind: "release-validation",
          deploymentMode: "package-assembled",
          message: "fixture assembly verified",
          databaseName: databaseEvidence.databaseName,
        }),
        prepare,
      },
      {
        inspect: vi.fn().mockResolvedValue(databaseEvidence),
        assertReady: vi.fn().mockRejectedValue(new DevHubError(
          "PROFILE_DATABASE_UNINITIALIZED",
          "发布验收数据库缺少 Host/Pah 基线关系；已在 spawn 前阻断，未启动 keepalive 进程",
          409,
          databaseEvidence,
        )),
      },
    );
    managers.push(manager);

    await expect(manager.start(service.id)).rejects.toMatchObject({ code: "PROFILE_DATABASE_UNINITIALIZED" });
    expect(prepare).not.toHaveBeenCalled();
    expect(await manager.status(service.id)).toMatchObject({
      lifecycle: "stopped",
      ownership: "none",
      profileEvidence: {
        database: {
          state: "uninitialized",
          missingRelations: ["task_info", "pah_plugin_installation"],
        },
      },
    });
  });

  it("任一 Profile 服务活动时拒绝显式建库且不调用数据库写动作", async () => {
    const port = await freePort();
    const service: ServiceDefinition = {
      ...definition("database-create-active", port),
      seriesId: "database-create-series",
      profileId: "release-validation",
      serviceRole: "api",
      profilePolicy: {
        environmentKind: "release-validation",
        deploymentMode: "package-assembled",
        lifecycleControl: true,
        database: { serviceRole: "api", envName: "TEST_DB", name: "fixture_release_validation_20260804" },
      },
    };
    const databaseEvidence = {
      state: "ready" as const,
      databaseName: "fixture_release_validation_20260804",
      server: "127.0.0.1:5432/postgres",
      exists: true,
      message: "隔离数据库存在",
      checkedAt: new Date().toISOString(),
    };
    const createIsolated = vi.fn();
    const manager = new PdhServiceManager(
      [service],
      undefined,
      undefined,
      {
        inspect: () => ({
          state: "verified",
          environmentKind: "release-validation",
          deploymentMode: "package-assembled",
          message: "fixture assembly verified",
          databaseName: databaseEvidence.databaseName,
        }),
        prepare: vi.fn().mockResolvedValue(undefined),
      },
      {
        inspect: vi.fn().mockResolvedValue(databaseEvidence),
        assertReady: vi.fn().mockResolvedValue(databaseEvidence),
        createIsolated,
      },
    );
    managers.push(manager);

    await manager.start(service.id);
    await waitForState(manager, service.id, (status) => status.health === "ready");
    await expect(manager.createProfileDatabase(
      service.id,
      "create-release-validation-database:fixture_release_validation_20260804",
    )).rejects.toMatchObject({ code: "PROFILE_DATABASE_CREATE_BUSY" });
    expect(createIsolated).not.toHaveBeenCalled();
  }, 15_000);

  it("只允许替换或移除已停止的服务定义", async () => {
    const port = await freePort();
    const service = definition("configurable-service", port);
    const manager = new PdhServiceManager([service]);
    managers.push(manager);

    const startPromise = manager.start(service.id);
    expect(() => manager.replaceDefinition({ ...service, name: "启动期间不可修改" })).toThrow(
      "请先停止",
    );
    await startPromise;
    expect(() => manager.unregister(service.id)).toThrow("请先停止");

    await manager.stop(service.id);
    manager.replaceDefinition({ ...service, name: "已更新服务" });
    expect((await manager.status(service.id)).definition.name).toBe("已更新服务");
    manager.unregister(service.id);
    await expect(manager.status(service.id)).rejects.toThrow("未知服务");
  });

  it("记录 ownership 身份、捕获日志并幂等停止无 TTY 的受控进程组", async () => {
    const port = await freePort();
    const service = definition("owned-service", port);
    const manager = new PdhServiceManager([service]);
    managers.push(manager);

    await manager.start(service.id);
    const ready = await waitForState(manager, service.id, (status) => status.health === "ready");
    expect(ready).toMatchObject({
      lifecycle: "running",
      health: "ready",
      ownership: "hub",
      managed: true,
      processGroupId: ready.pid,
      logSource: "captured",
    });
    expect(ready.ownershipId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ready.rootProcess).toMatchObject({
      pid: ready.pid,
      processGroupId: ready.pid,
      cwd: projectRoot,
    });
    if (process.platform === "win32") expect(ready.rootProcess?.sessionId).toBeUndefined();
    else expect(ready.rootProcess?.sessionId).toBeTypeOf("number");
    expect(["??", "?", "none"]).toContain(ready.rootProcess?.tty);
    const beforeClear = await manager.logs(service.id);
    expect(beforeClear.entries.some(
      (entry) => entry.text.includes("fixture-ready"),
    )).toBe(true);
    const cleared = await manager.clearLogs(service.id);
    expect(cleared).toMatchObject({ entries: [], retainedCount: 0, totalWritten: 0 });
    expect(cleared.generation).toBe(beforeClear.generation + 1);
    expect((await manager.logs(service.id, 0, beforeClear.generation)).entries).toEqual([]);

    const stopped = await manager.stop(service.id);
    expect(stopped).toMatchObject({ lifecycle: "stopped", ownership: "none", managed: false });
    expect(stopped.endpoints[0].reachable).toBe(false);
    const afterClear = await manager.logs(service.id, 0, cleared.generation);
    expect(afterClear.entries.length).toBeGreaterThan(0);
    expect(afterClear.entries.some((entry) => entry.text.includes("fixture-ready"))).toBe(false);
    expect((await manager.stop(service.id)).lifecycle).toBe("stopped");
  }, platformTimeout(15_000));

  it("当前构建失败时不被健康端口的 HTTP 200 掩盖，并可由后续成功构建恢复", async () => {
    const failedPort = await freePort();
    const failedService = definition("build-failed-service", failedPort, buildWatchFixturePath);
    const manager = new PdhServiceManager([failedService]);
    managers.push(manager);
    await manager.start(failedService.id);
    const failed = await waitForState(
      manager,
      failedService.id,
      (status) => status.build.state === "failed" && status.endpoints[0]?.healthy === true,
    );
    expect(failed).toMatchObject({
      lifecycle: "starting",
      health: "unhealthy",
      ownership: "hub",
      build: { state: "failed" },
    });
    expect(failed.message).toContain("端口健康但当前构建失败");
    await manager.stop(failedService.id);

    const recoveredPort = await freePort();
    const recoveredService: ServiceDefinition = {
      ...definition("build-recovered-service", recoveredPort, buildWatchFixturePath),
      command: { executable: process.execPath, args: [buildWatchFixturePath, String(recoveredPort), "recover"] },
      endpoints: [{
        id: "web",
        label: "Web",
        port: recoveredPort,
        openUrl: `http://127.0.0.1:${recoveredPort}/`,
        healthUrl: `http://127.0.0.1:${recoveredPort}/`,
        required: true,
      }],
    };
    manager.register(recoveredService);
    await manager.start(recoveredService.id);
    const recovered = await waitForState(
      manager,
      recoveredService.id,
      (status) => status.build.state === "ready" && status.health === "ready",
    );
    expect(recovered).toMatchObject({ build: { state: "ready" }, health: "ready" });
  }, platformTimeout(15_000));

  it("区分显式 HTTP 健康路径、根路由缺失与仅端口可达", async () => {
    const [unverifiedPort, verifiedPort, rootFallbackPort, wrongPathPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
      freePort(),
    ]);
    const unverified: ServiceDefinition = {
      ...definition("listen-only-api", unverifiedPort, routedHealthFixturePath),
      endpoints: [{ id: "api", label: "API", port: unverifiedPort, required: true }],
    };
    const verified: ServiceDefinition = {
      ...definition("verified-api", verifiedPort, routedHealthFixturePath),
      endpoints: [{
        id: "api",
        label: "API",
        port: verifiedPort,
        healthUrl: `http://127.0.0.1:${verifiedPort}/api/health`,
        required: true,
      }],
    };
    const wrongPath: ServiceDefinition = {
      ...definition("wrong-health-path-api", wrongPathPort, routedHealthFixturePath),
      endpoints: [{
        id: "api",
        label: "API",
        port: wrongPathPort,
        healthUrl: `http://127.0.0.1:${wrongPathPort}/missing-health`,
        required: true,
      }],
    };
    const rootFallback: ServiceDefinition = {
      ...definition("root-route-missing-api", rootFallbackPort, routedHealthFixturePath),
      endpoints: [{
        id: "api",
        label: "API",
        port: rootFallbackPort,
        healthUrl: `http://127.0.0.1:${rootFallbackPort}/`,
        required: true,
      }],
    };
    const manager = new PdhServiceManager([unverified, verified, rootFallback, wrongPath]);
    managers.push(manager);

    await manager.start(unverified.id);
    const listenOnly = await waitForState(manager, unverified.id, (status) => status.health === "reachable");
    expect(listenOnly).toMatchObject({
      lifecycle: "running",
      health: "reachable",
      endpoints: [{
        reachable: true,
        healthy: null,
        probeState: "reachable-unverified",
        probeMessage: "端口可达；未配置 HTTP 健康路径",
      }],
    });
    expect(listenOnly.message).toContain("不代表业务健康");
    expect(listenOnly.message).not.toContain("部分就绪");
    await manager.stop(unverified.id);

    const externalChild = await spawnExternal(routedHealthFixturePath, unverifiedPort);
    const monitored = await waitForState(manager, unverified.id, (status) => status.lifecycle === "external");
    expect(monitored).toMatchObject({
      ownership: "external",
      health: "reachable",
      identityMatched: true,
    });
    expect(monitored.message).toContain("未配置 HTTP 健康路径");
    await exactFixtureCleanup(externalChild);
    await waitForState(manager, unverified.id, (status) => status.lifecycle === "stopped");

    await manager.start(verified.id);
    const healthy = await waitForState(manager, verified.id, (status) => status.health === "ready");
    expect(healthy.endpoints[0]).toMatchObject({
      statusCode: 204,
      probeState: "healthy",
      probeMessage: "健康路径返回 HTTP 204",
    });
    await manager.stop(verified.id);

    await manager.start(rootFallback.id);
    const rootMissing = await waitForState(
      manager,
      rootFallback.id,
      (status) => status.health === "reachable",
    );
    expect(rootMissing).toMatchObject({
      lifecycle: "running",
      health: "reachable",
      endpoints: [{
        reachable: true,
        healthy: null,
        statusCode: 404,
        probeState: "reachable-unverified",
        probeMessage: "端口可达；配置的根路径返回 HTTP 404，未发现可用健康路径",
      }],
    });
    expect(rootMissing.message).toContain("未发现可用健康路径");
    expect(rootMissing.message).not.toContain("部分就绪");
    await manager.stop(rootFallback.id);

    await manager.start(wrongPath.id);
    const failed = await waitForState(manager, wrongPath.id, (status) => status.health === "unhealthy");
    expect(failed.endpoints[0]).toMatchObject({
      reachable: true,
      healthy: false,
      statusCode: 404,
      probeState: "unhealthy",
      probeMessage: "健康路径返回 HTTP 404",
    });
    await manager.stop(wrongPath.id);
  }, platformTimeout(25_000));

  it("停止整个 watch 进程组，监听子进程重生后也不会遗留或再次拉起", async () => {
    const port = await freePort();
    const service = definition("watch-service", port, watchFixturePath);
    const manager = new PdhServiceManager([service]);
    managers.push(manager);
    await manager.start(service.id);
    const ready = await waitForState(manager, service.id, (status) => status.health === "ready");
    const firstListener = ready.endpoints[0].pids[0];
    expect(firstListener).toBeTypeOf("number");

    process.kill(firstListener, "SIGTERM");
    const respawned = await waitForState(
      manager,
      service.id,
      (status) => status.endpoints[0].pids.some((pid) => pid !== firstListener),
    );
    expect(respawned.endpoints[0].pids).not.toContain(firstListener);

    const stopped = await manager.stop(service.id);
    expect(stopped.lifecycle).toBe("stopped");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await manager.status(service.id)).endpoints[0].pids).toEqual([]);
  }, platformTimeout(15_000));

  it("部分就绪仍可停止，且不会误杀其他服务进程组", async () => {
    const [partialPort, missingPort, otherPort] = await Promise.all([freePort(), freePort(), freePort()]);
    const partial = definition("partial-service", partialPort, fixturePath, projectRoot, [{
      id: "api",
      label: "API",
      port: missingPort,
      healthUrl: `http://127.0.0.1:${missingPort}/`,
      required: true,
    }]);
    const other = definition("unrelated-service", otherPort);
    const manager = new PdhServiceManager([partial, other]);
    managers.push(manager);
    await Promise.all([manager.start(partial.id), manager.start(other.id)]);

    const partialStatus = await waitForState(
      manager,
      partial.id,
      (status) => status.health === "partial",
    );
    expect(partialStatus).toMatchObject({ ownership: "hub", health: "partial" });
    expect((await manager.stop(partial.id)).lifecycle).toBe("stopped");

    const unrelated = await waitForState(manager, other.id, (status) => status.health === "ready");
    expect(unrelated).toMatchObject({ lifecycle: "running", ownership: "hub", health: "ready" });
  }, 18_000);

  it("匹配的外部服务只监控且不重复启动，确认令牌复核后才能精确停止", async () => {
    const port = await freePort();
    const service = definition("external-service", port);
    const child = await spawnExternal(fixturePath, port);
    let runtimeEnvCalls = 0;
    const manager = new PdhServiceManager([service], undefined, () => {
      runtimeEnvCalls += 1;
      return { [PDH_CONTROLLED_TOOL_PROFILE_ENV]: "must-not-be-injected" };
    });
    managers.push(manager);

    const external = await waitForState(manager, service.id, (status) => status.lifecycle === "external");
    expect(external).toMatchObject({
      ownership: "external",
      health: "ready",
      managed: false,
      logSource: "monitoring-only",
    });
    expect((await manager.logs(service.id))).toMatchObject({
      available: false,
      source: "monitoring-only",
      entries: [],
    });
    expect((await manager.start(service.id)).lifecycle).toBe("external");
    expect(runtimeEnvCalls).toBe(0);
    expect(child.exitCode).toBeNull();
    await manager.stopAllManaged();
    expect((await manager.status(service.id)).lifecycle).toBe("external");
    expect(child.exitCode).toBeNull();

    const details = await captureStopDetails(
      () => manager.stop(service.id),
      "EXTERNAL_CONFIRMATION_REQUIRED",
    );
    expect(details).toMatchObject({
      serviceId: service.id,
      ownership: "external",
      ports: [port],
      processGroupIds: [child.pid],
      cwd: projectRoot,
    });
    const stopped = await manager.stop(service.id, {
      mode: "confirm-external",
      token: details.token,
    });
    expect(stopped.lifecycle).toBe("stopped");
  }, 15_000);

  it("身份、健康或 cwd 不匹配时标记冲突，不能一键停止", async () => {
    const [port, unhealthyPort, cwdPort] = await Promise.all([freePort(), freePort(), freePort()]);
    const service: ServiceDefinition = {
      ...definition("conflict-service", port),
      identity: {
        url: `http://127.0.0.1:${port}/`,
        expected: { service: "expected", version: "2.0.0" },
      },
    };
    const unhealthy: ServiceDefinition = {
      ...definition("unhealthy-service", unhealthyPort),
      endpoints: [{
        id: "web",
        label: "Web",
        port: unhealthyPort,
        openUrl: `http://127.0.0.1:${unhealthyPort}/`,
        healthUrl: `http://127.0.0.1:${unhealthyPort}/health`,
        required: true,
      }],
    };
    const cwdMismatch = definition("cwd-conflict-service", cwdPort);
    const child = await spawnExternal(fixturePath, port);
    const unhealthyChild = await spawnExternal(fixturePath, unhealthyPort, projectRoot, ["404"]);
    const cwdChild = await spawnExternal(
      fixturePath,
      cwdPort,
      mkdtempSync(path.join(tmpdir(), "pdh-conflict-")),
    );
    const manager = new PdhServiceManager([service, unhealthy, cwdMismatch]);
    managers.push(manager);
    const conflict = await waitForState(manager, service.id, (status) => status.lifecycle === "conflict");
    expect(conflict).toMatchObject({ ownership: "conflict", identityMatched: false });
    await expect(manager.stop(service.id)).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    expect(child.exitCode).toBeNull();

    const unhealthyStatus = await waitForState(
      manager,
      unhealthy.id,
      (status) => status.lifecycle === "conflict",
    );
    expect(unhealthyStatus).toMatchObject({ health: "unhealthy", identityMatched: true });
    expect(unhealthyChild.exitCode).toBeNull();

    const cwdStatus = await waitForState(
      manager,
      cwdMismatch.id,
      (status) => status.lifecycle === "conflict",
    );
    expect(cwdStatus).toMatchObject({ health: "ready", identityMatched: false });
    expect(cwdChild.exitCode).toBeNull();
  }, 12_000);

  it("确认期间端口换主会取消操作，不会停止新进程", async () => {
    const port = await freePort();
    const service = definition("handoff-service", port);
    const first = await spawnExternal(fixturePath, port);
    const manager = new PdhServiceManager([service]);
    managers.push(manager);
    await waitForState(manager, service.id, (status) => status.lifecycle === "external");
    const details = await captureStopDetails(
      () => manager.stop(service.id),
      "EXTERNAL_CONFIRMATION_REQUIRED",
    );

    await exactFixtureCleanup(first);
    await waitForState(manager, service.id, (status) => status.lifecycle === "stopped");
    const replacement = await spawnExternal(fixturePath, port);
    await waitForState(manager, service.id, (status) => status.lifecycle === "external");

    await expect(manager.stop(service.id, {
      mode: "confirm-external",
      token: details.token,
    })).rejects.toMatchObject({ code: "STOP_TARGET_CHANGED" });
    expect(replacement.exitCode).toBeNull();
  }, 15_000);

  // Windows 的 Node.js SIGTERM 使用 TerminateProcess，无法构造可拒绝 SIGTERM 的进程。
  it.skipIf(process.platform === "win32")("外部进程优雅停止超时后必须再次确认，才会精确 SIGKILL", async () => {
    const port = await freePort();
    const service = definition("stubborn-service", port, stubbornFixturePath);
    const child = await spawnExternal(stubbornFixturePath, port);
    const manager = new PdhServiceManager([service]);
    managers.push(manager);
    await waitForState(manager, service.id, (status) => status.lifecycle === "external");
    const confirmation = await captureStopDetails(
      () => manager.stop(service.id),
      "EXTERNAL_CONFIRMATION_REQUIRED",
    );
    const force = await captureStopDetails(
      () => manager.stop(service.id, { mode: "confirm-external", token: confirmation.token }),
      "FORCE_STOP_REQUIRED",
    );
    expect(child.exitCode).toBeNull();
    const stopped = await manager.stop(service.id, { mode: "force", token: force.token });
    expect(stopped.lifecycle).toBe("stopped");
  }, 20_000);
});
