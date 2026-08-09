import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  EndpointStatus,
  HostCapabilitiesResponse,
  OpenSystemTerminalResponse,
  ProcessSummary,
  ServiceDefinition,
  ServiceHealthState,
  ServiceListResponse,
  ServiceLogsResponse,
  ServiceOwnership,
  ServiceProfileDatabaseCreationEvidence,
  ServiceRuntimeStatus,
  StopServiceRequest,
  StopTargetDetails,
} from "../shared/contracts.js";
import { probeEndpoint, probeServiceIdentity } from "./endpointProbe.js";
import { DevHubError } from "./errors.js";
import { ServiceLogBuffer } from "./logBuffer.js";
import { PdhBuildOutputTracker } from "./PdhBuildOutputTracker.js";
import { PdhProfileAssembly } from "./PdhProfileAssembly.js";
import {
  PdhPostgresPreflight,
  type PdhProfileDatabasePreflight,
} from "./PdhPostgresPreflight.js";
import {
  PDH_CONTROLLED_TOOL_PROFILE_ENV,
  pdhControlledToolProfileLogMessage,
} from "./PdhControlledToolProfileResolver.js";
import { PdhSystemTerminal } from "./PdhSystemTerminal.js";
import {
  describeProcess,
  isPathInside,
  listenerPids,
  processGroupMembers,
  sameProcessIdentity,
} from "./processDiscovery.js";

interface ManagedProcess {
  readonly child: ChildProcess;
  readonly root: ProcessSummary;
  readonly ownershipId: string;
  readonly startedAt: string;
  readonly build: PdhBuildOutputTracker;
  stopping: boolean;
}

interface LastExit {
  readonly exitedAt: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

interface StopIntent {
  readonly token: string;
  readonly serviceId: string;
  readonly ownership: "hub" | "external";
  readonly purpose: "confirm-external" | "force";
  readonly expiresAtMs: number;
  readonly processGroupIds: readonly number[];
  readonly processes: readonly ProcessSummary[];
  readonly portOwners: Readonly<Record<number, readonly number[]>>;
  readonly ownershipId?: string;
}

const STARTING_WINDOW_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
const FORCE_TIMEOUT_MS = 1_500;
const INTENT_TTL_MS = 30_000;
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export type PdhRuntimeEnvProvider = (
  definition: ServiceDefinition,
) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;

const PDH_SERVICE_ID_ENV = "PHOENIX_DEV_HUB_SERVICE_ID";
export const PDH_SERVICE_SPAWN_SHELL = false as const;
const PDH_RESERVED_RUNTIME_ENV_KEYS = [
  PDH_SERVICE_ID_ENV,
  PDH_CONTROLLED_TOOL_PROFILE_ENV,
] as const;

/** 合并顺序固定为 process → command → Hub runtime；已知保留键不会从父进程或用户配置继承。 */
export function pdhServiceSpawnEnvironment(
  definition: ServiceDefinition,
  runtimeEnv: Readonly<Record<string, string>> = {},
  processEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...processEnv,
    ...definition.command.env,
  };
  for (const key of PDH_RESERVED_RUNTIME_ENV_KEYS) delete result[key];
  Object.assign(result, runtimeEnv);
  result[PDH_SERVICE_ID_ENV] = definition.id;
  return result;
}

function processCommand(definition: ServiceDefinition): string {
  return [definition.command.executable, ...definition.command.args].join(" ");
}

function endpointReady(endpoint: EndpointStatus): boolean {
  return endpoint.reachable && (endpoint.healthUrl ? endpoint.healthy === true : false);
}

function endpointOperational(endpoint: EndpointStatus): boolean {
  return endpoint.probeState === "healthy" || endpoint.probeState === "reachable-unverified";
}

function healthState(endpoints: readonly EndpointStatus[], processPresent: boolean): ServiceHealthState {
  if (!processPresent) return "unknown";
  if (endpoints.length === 0) return "partial";
  const required = endpoints.filter((endpoint) => endpoint.required !== false);
  const evaluated = required.length > 0 ? required : endpoints;
  if (evaluated.every(endpointReady)) return "ready";
  if (evaluated.every(endpointOperational) && evaluated.some((endpoint) => (
    endpoint.probeState === "reachable-unverified"
  ))) return "reachable";
  if (endpoints.some((endpoint) => endpointReady(endpoint) || (
    endpoint.probeState === "reachable-unverified"
  ))) return "partial";
  return "unhealthy";
}

function healthMessage(endpoints: readonly EndpointStatus[], health: ServiceHealthState): string | undefined {
  if (health === "ready" || health === "unknown") return undefined;
  const unverified = endpoints.filter((endpoint) => endpoint.probeState === "reachable-unverified");
  if (health === "reachable") {
    const details = unverified
      .map((endpoint) => `${endpoint.label}：${endpoint.probeMessage}`)
      .join("；");
    return `必需端口均可达；${details}；仅确认监听可达，不代表业务健康`;
  }
  const issues = endpoints
    .filter((endpoint) => endpoint.probeState !== "healthy")
    .map((endpoint) => `${endpoint.label}：${endpoint.probeMessage}`);
  return issues.length > 0 ? issues.join("；") : undefined;
}

function uniqueProcesses(processes: readonly ProcessSummary[]): readonly ProcessSummary[] {
  return [...new Map(processes.map((item) => [item.pid, item])).values()]
    .sort((left, right) => left.pid - right.pid);
}

function sameNumberSet(left: readonly number[], right: readonly number[]): boolean {
  const a = [...new Set(left)].sort((x, y) => x - y);
  const b = [...new Set(right)].sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 协调 Dev Hub 受控服务的探测、启停、身份复核与日志生命周期。 */
export class PdhServiceManager {
  readonly #definitions = new Map<string, ServiceDefinition>();
  readonly #managed = new Map<string, ManagedProcess>();
  readonly #lastExit = new Map<string, LastExit>();
  readonly #logs = new Map<string, ServiceLogBuffer>();
  readonly #stopIntents = new Map<string, StopIntent>();
  readonly #starting = new Set<string>();
  readonly #preparingProfiles = new Map<string, Promise<unknown>>();
  readonly #systemTerminal: PdhSystemTerminal;
  readonly #runtimeEnvProvider: PdhRuntimeEnvProvider;
  readonly #profileAssembly: PdhProfileAssembly;
  readonly #profileDatabasePreflight: PdhProfileDatabasePreflight;
  #configurationErrors: readonly string[] = [];

  constructor(
    definitions: readonly ServiceDefinition[],
    systemTerminal = new PdhSystemTerminal(),
    runtimeEnvProvider: PdhRuntimeEnvProvider = () => ({}),
    profileAssembly = new PdhProfileAssembly(),
    profileDatabasePreflight: PdhProfileDatabasePreflight = new PdhPostgresPreflight(),
  ) {
    this.#systemTerminal = systemTerminal;
    this.#runtimeEnvProvider = runtimeEnvProvider;
    this.#profileAssembly = profileAssembly;
    this.#profileDatabasePreflight = profileDatabasePreflight;
    for (const definition of definitions) this.register(definition);
  }

  serviceIds(): ReadonlySet<string> {
    return new Set(this.#definitions.keys());
  }

  setConfigurationErrors(errors: readonly string[]): void {
    this.#configurationErrors = [...new Set(errors)];
  }

  definition(serviceId: string): ServiceDefinition {
    return this.#definition(serviceId);
  }

  async createProfileDatabase(
    serviceId: string,
    confirmation: string,
  ): Promise<ServiceProfileDatabaseCreationEvidence> {
    const definition = this.#definition(serviceId);
    this.#assertLifecycleControl(definition, "创建隔离数据库");
    if (!this.#profileDatabasePreflight.createIsolated) {
      throw new DevHubError("PROFILE_DATABASE_CREATE_UNAVAILABLE", "当前数据库 preflight 不支持显式建库", 503);
    }
    const profileDefinitions = [...this.#definitions.values()].filter((candidate) => (
      (candidate.seriesId ?? candidate.moduleId) === (definition.seriesId ?? definition.moduleId)
      && (candidate.profileId ?? "default") === (definition.profileId ?? "default")
    ));
    const statuses = await Promise.all(profileDefinitions.map((candidate) => this.status(candidate.id)));
    if (statuses.some((status) => status.lifecycle !== "stopped")) {
      throw new DevHubError(
        "PROFILE_DATABASE_CREATE_BUSY",
        "创建隔离数据库前必须停止该 Profile 的全部服务，并确认没有外部进程或端口冲突",
        409,
      );
    }
    const evidence = await this.#profileDatabasePreflight.createIsolated(
      definition,
      [...this.#definitions.values()],
      confirmation,
    );
    for (const candidate of profileDefinitions) {
      this.#logs.get(candidate.id)?.append(
        "system",
        `[Profile] 已显式创建隔离数据库 ${evidence.databaseName}；原先不存在；回收责任：${evidence.cleanupResponsibility}`,
      );
    }
    return evidence;
  }

  register(definition: ServiceDefinition): void {
    if (this.#definitions.has(definition.id)) {
      throw new DevHubError("SERVICE_ALREADY_REGISTERED", `服务 ID 已存在：${definition.id}`, 409);
    }
    this.#definitions.set(definition.id, definition);
    const logs = new ServiceLogBuffer();
    logs.append("system", `已加载受控命令：${processCommand(definition)}`);
    this.#logs.set(definition.id, logs);
  }

  assertDefinitionMutable(serviceId: string): void {
    const definition = this.#definition(serviceId);
    if (
      this.#starting.has(serviceId)
      || this.#managed.has(serviceId)
      || this.#stopIntents.has(serviceId)
    ) {
      throw new DevHubError(
        "SERVICE_CONFIG_BUSY",
        `${definition.name} 正在运行或执行生命周期操作，请先停止后再修改项目配置`,
        409,
      );
    }
  }

  replaceDefinition(definition: ServiceDefinition): void {
    this.assertDefinitionMutable(definition.id);
    this.#definitions.set(definition.id, definition);
    this.#lastExit.delete(definition.id);
    this.#logs.get(definition.id)?.append("system", `项目配置已更新：${processCommand(definition)}`);
  }

  unregister(serviceId: string): void {
    this.assertDefinitionMutable(serviceId);
    this.#definitions.delete(serviceId);
    this.#lastExit.delete(serviceId);
    this.#logs.delete(serviceId);
    this.#stopIntents.delete(serviceId);
  }

  async list(): Promise<ServiceListResponse> {
    const services = await Promise.all(
      [...this.#definitions.values()].map((definition) => this.status(definition.id)),
    );
    const pathWarnings = new Map<string, string[]>();
    for (const definition of this.#definitions.values()) {
      for (const warning of definition.configurationErrors ?? []) {
        pathWarnings.set(warning, [...(pathWarnings.get(warning) ?? []), definition.name]);
      }
    }
    const configurationErrors = [
      ...this.#configurationErrors,
      ...[...pathWarnings].map(([warning, affectedServices]) => (
        `${warning}（影响：${affectedServices.join("、")}）`
      )),
    ];
    return {
      services,
      generatedAt: new Date().toISOString(),
      ...(configurationErrors.length > 0
        ? { configurationErrors: [...new Set(configurationErrors)] }
        : {}),
    };
  }

  async status(serviceId: string): Promise<ServiceRuntimeStatus> {
    const definition = this.#definition(serviceId);
    if (definition.configurationErrors?.length) {
      const message = `配置错误：${definition.configurationErrors.join("；")}`;
      return {
        definition,
        lifecycle: "stopped",
        health: "unhealthy",
        build: { state: "unknown" },
        ownership: "none",
        managed: false,
        endpoints: definition.endpoints.map((endpoint) => ({
          ...endpoint,
          reachable: false,
          healthy: null,
          probeState: "unreachable",
          probeMessage: message,
          pids: [],
        })),
        externalProcesses: [],
        identityMatched: null,
        logSource: "captured",
        message,
      };
    }
    const assemblyEvidence = this.#profileAssembly.inspect(definition);
    const [databaseEvidence, endpoints, identityProbe] = await Promise.all([
      this.#profileDatabasePreflight.inspect(definition, [...this.#definitions.values()]),
      Promise.all(definition.endpoints.map(probeEndpoint)),
      probeServiceIdentity(definition.identity),
    ]);
    const profileEvidence = assemblyEvidence && databaseEvidence
      ? { ...assemblyEvidence, database: databaseEvidence }
      : assemblyEvidence;
    const listenerIds = [...new Set(endpoints.flatMap((endpoint) => endpoint.pids))];
    const listeners = uniqueProcesses((await Promise.all(listenerIds.map(describeProcess))).filter(
      (item): item is ProcessSummary => Boolean(item),
    ));

    let managed = this.#managed.get(serviceId);
    if (managed) {
      const currentRoot = await describeProcess(managed.root.pid);
      if (!sameProcessIdentity(managed.root, currentRoot)) {
        this.#logs.get(serviceId)?.append(
          "system",
          `已撤销过期 ownership：PID ${managed.root.pid} 的身份发生变化或已退出`,
        );
        this.#managed.delete(serviceId);
        managed = undefined;
      }
    }

    if (managed) {
      const ownedMemberIds = new Set(
        (await processGroupMembers(managed.root.processGroupId)).map((item) => item.pid),
      );
      const foreignListeners = listeners.filter((item) => !ownedMemberIds.has(item.pid));
      const endpointHealth = healthState(endpoints, true);
      const build = managed.build.snapshot();
      const health = build.state === "failed"
        ? "unhealthy"
        : build.state === "building" && (endpointHealth === "ready" || endpointHealth === "reachable")
          ? "partial"
          : endpointHealth;
      const starting = Date.now() - Date.parse(managed.startedAt) < STARTING_WINDOW_MS
        && health !== "ready"
        && health !== "reachable";
      const lifecycle = managed.stopping
        ? "stopping"
        : foreignListeners.length > 0
          ? "conflict"
          : starting
            ? "starting"
            : "running";
      return {
        definition,
        ...(profileEvidence ? { profileEvidence } : {}),
        lifecycle,
        health,
        build,
        ownership: "hub",
        managed: true,
        pid: managed.root.pid,
        processGroupId: managed.root.processGroupId,
        ownershipId: managed.ownershipId,
        rootProcess: managed.root,
        startedAt: managed.startedAt,
        endpoints,
        externalProcesses: foreignListeners,
        identityMatched: identityProbe.matched ?? true,
        identityMessage: identityProbe.message,
        logSource: "captured",
        message: foreignListeners.length > 0
          ? "检测到不属于 Hub ownership 的端口所有者；仍可停止 Hub 自己的进程组"
          : build.state === "failed"
            ? `${endpointHealth === "ready" ? "端口健康但当前构建失败" : endpointHealth === "reachable" ? "端口可达但当前构建失败" : "当前构建失败"}：${build.message ?? "编译器报告错误"}`
            : build.state === "building" && (endpointHealth === "ready" || endpointHealth === "reachable")
              ? "端口已响应，但当前构建尚未确认成功；这不影响停止操作"
          : managed.stopping
            ? "正在停止 Hub 管理的进程组"
            : health === "ready"
              ? undefined
              : health === "reachable"
                ? healthMessage(endpoints, health)
              : starting
                ? "进程已启动，正在等待身份与健康检查就绪；这不影响停止操作"
                : `${healthMessage(endpoints, health) ?? "健康检查未完全就绪"}；Hub 管理的进程仍在运行，这不影响停止操作`,
      };
    }

    if (listeners.length > 0) {
      const cwdMatched = listeners.every((item) => isPathInside(item.cwd, definition.cwd));
      const identityMatched = cwdMatched && identityProbe.matched !== false;
      const health = healthState(endpoints, true);
      const external = identityMatched && health !== "unhealthy";
      return {
        definition,
        ...(profileEvidence ? { profileEvidence } : {}),
        lifecycle: external ? "external" : "conflict",
        health,
        build: { state: "unknown" },
        ownership: external ? "external" : "conflict",
        managed: false,
        endpoints,
        externalProcesses: listeners,
        identityMatched,
        identityMessage: !cwdMatched
          ? "监听进程工作目录与服务清单不匹配"
          : identityProbe.message,
        logSource: "monitoring-only",
        message: external
          ? health === "reachable"
            ? `服务由 Hub 外部启动；${healthMessage(endpoints, health)}`
            : "服务由 Hub 外部启动，当前仅监控身份、端口与健康状态"
          : health === "unhealthy"
            ? `${healthMessage(endpoints, health) ?? "预期 HTTP 2xx 健康检查失败"}；已标记端口冲突`
            : "端口所有者身份与服务清单不匹配；已标记端口冲突",
      };
    }

    const lastExit = this.#lastExit.get(serviceId);
    return {
      definition,
      ...(profileEvidence ? { profileEvidence } : {}),
      lifecycle: "stopped",
      health: "unknown",
      build: { state: "unknown" },
      ownership: "none",
      managed: false,
      endpoints,
      externalProcesses: [],
      identityMatched: null,
      identityMessage: definition.identity ? identityProbe.message : undefined,
      logSource: "captured",
      ...(lastExit ?? {}),
      message: lastExit ? "Hub 启动的进程已经退出" : undefined,
    };
  }

  async logs(serviceId: string, afterSequence = 0, generation?: number): Promise<ServiceLogsResponse> {
    const status = await this.status(serviceId);
    const logBuffer = this.#logs.get(serviceId)!;
    if (status.logSource === "monitoring-only") {
      return {
        serviceId,
        ...logBuffer.snapshot(logBuffer.nextSequence, logBuffer.generation),
        entries: [],
        available: false,
        source: "monitoring-only",
        message: "仅健康监控：外部进程未向 Hub 提供 stdout/stderr 或配置日志文件，进程日志不可用",
      };
    }
    return {
      serviceId,
      ...logBuffer.snapshot(afterSequence, generation),
      available: true,
      source: "captured",
    };
  }

  async clearLogs(serviceId: string): Promise<ServiceLogsResponse> {
    const status = await this.status(serviceId);
    const logBuffer = this.#logs.get(serviceId)!;
    if (status.logSource === "monitoring-only") {
      return {
        serviceId,
        ...logBuffer.snapshot(logBuffer.nextSequence, logBuffer.generation),
        entries: [],
        available: false,
        source: "monitoring-only",
        message: "仅健康监控：没有可由 Hub 清空的外部进程日志",
      };
    }
    return {
      serviceId,
      ...logBuffer.clear(),
      available: true,
      source: "captured",
      message: "已清空本次 Hub 会话日志并建立新 generation",
    };
  }

  hostCapabilities(): HostCapabilitiesResponse {
    return { systemTerminal: this.#systemTerminal.capability() };
  }

  openSystemTerminal(serviceId: string): Promise<OpenSystemTerminalResponse> {
    const definition = this.#definition(serviceId);
    this.#assertLifecycleControl(definition, "打开系统终端");
    return this.#systemTerminal.open(serviceId, definition.cwd);
  }

  openHubTerminal(projectRoot: string): Promise<OpenSystemTerminalResponse> {
    return this.#systemTerminal.open("phoenix-dev-hub", projectRoot);
  }

  async start(serviceId: string): Promise<ServiceRuntimeStatus> {
    const definition = this.#definition(serviceId);
    this.#assertLifecycleControl(definition, "启动");
    if (definition.configurationErrors?.length) {
      throw new DevHubError(
        "SERVICE_CONFIG_INVALID",
        `${definition.name} 配置无效：${definition.configurationErrors.join("；")}`,
        409,
      );
    }
    if (this.#starting.has(serviceId)) {
      throw new DevHubError("START_IN_PROGRESS", "服务正在启动，请勿重复操作", 409);
    }
    this.#starting.add(serviceId);
    try {
      return await this.#startService(serviceId);
    } finally {
      this.#starting.delete(serviceId);
    }
  }

  async #startService(serviceId: string): Promise<ServiceRuntimeStatus> {
    const definition = this.#definition(serviceId);
    if (definition.runtimeSlot && definition.profileId) {
      const sameSlotOtherProfiles = [...this.#definitions.values()].filter((candidate) => (
        candidate.id !== definition.id
        && candidate.runtimeSlot === definition.runtimeSlot
        && candidate.profileId
        && candidate.profileId !== definition.profileId
      ));
      const blockers: ServiceRuntimeStatus[] = [];
      for (const candidate of sameSlotOtherProfiles) {
        const status = await this.status(candidate.id);
        if (status.lifecycle !== "stopped") blockers.push(status);
      }
      if (blockers.length > 0) {
        const activeProfiles = [...new Set(blockers.map((status) => status.definition.profileName
          ?? status.definition.profileId
          ?? status.definition.name))];
        throw new DevHubError(
          "RUNTIME_SLOT_OCCUPIED",
          `${definition.name} 所属运行槽 ${definition.runtimeSlot} 正由 ${activeProfiles.join("、")} 使用，请先切换版本`,
          409,
          {
            runtimeSlot: definition.runtimeSlot,
            targetProfileId: definition.profileId,
            blockers,
          },
        );
      }
    }
    await this.#prepareProfile(definition);
    const current = await this.status(serviceId);
    if (current.ownership === "hub") {
      throw new DevHubError("ALREADY_RUNNING", `${definition.name} 已由 Hub 启动`, 409);
    }
    if (current.lifecycle === "external") return current;
    if (current.lifecycle === "conflict") {
      throw new DevHubError(
        "PORT_CONFLICT",
        `${definition.name} 的端口已被身份不符或不健康的进程占用`,
        409,
        current,
      );
    }

    const logBuffer = this.#logs.get(serviceId)!;
    logBuffer.append("system", `启动：${processCommand(definition)}`);
    const runtimeEnv = await this.#runtimeEnvProvider(definition);
    const controlledToolMessage = pdhControlledToolProfileLogMessage(
      runtimeEnv[PDH_CONTROLLED_TOOL_PROFILE_ENV],
    );
    if (controlledToolMessage) logBuffer.append("system", controlledToolMessage);
    const child = spawn(definition.command.executable, [...definition.command.args], {
      cwd: definition.cwd,
      env: pdhServiceSpawnEnvironment(definition, runtimeEnv),
      detached: process.platform !== "win32",
      shell: PDH_SERVICE_SPAWN_SHELL,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logBuffer.append("system", `启动失败：${message}`);
      throw new DevHubError("SPAWN_FAILED", `无法启动 ${definition.name}：${message}`, 500);
    });

    if (!child.pid) throw new DevHubError("SPAWN_FAILED", `无法取得 ${definition.name} 的 PID`, 500);
    const root = await this.#captureRootIdentity(child.pid);
    if (!root || root.processGroupId !== child.pid || !isPathInside(root.cwd, definition.cwd)) {
      child.kill("SIGTERM");
      throw new DevHubError(
        "SPAWN_IDENTITY_FAILED",
        `无法建立 ${definition.name} 的稳定 PID/PGID/cwd ownership，已取消启动`,
        500,
        root,
      );
    }

    const managed: ManagedProcess = {
      child,
      root,
      ownershipId: randomUUID(),
      startedAt: new Date().toISOString(),
      build: new PdhBuildOutputTracker(),
      stopping: false,
    };
    this.#managed.set(serviceId, managed);
    this.#lastExit.delete(serviceId);
    logBuffer.append(
      "system",
      `ownership=${managed.ownershipId} rootPid=${root.pid} pgid=${root.processGroupId} cwd=${root.cwd} ports=${definition.endpoints.map((item) => item.port).join(",") || "none"}`,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      managed.build.appendChunk("stdout", chunk);
      logBuffer.appendChunk("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      managed.build.appendChunk("stderr", chunk);
      logBuffer.appendChunk("stderr", chunk);
    });
    child.once("exit", (exitCode, signal) => {
      managed.build.flush("stdout");
      managed.build.flush("stderr");
      logBuffer.flush("stdout");
      logBuffer.flush("stderr");
      logBuffer.append("system", `进程退出：code=${exitCode ?? "null"} signal=${signal ?? "null"}`);
      if (this.#managed.get(serviceId)?.ownershipId === managed.ownershipId) {
        this.#managed.delete(serviceId);
      }
      this.#lastExit.set(serviceId, {
        exitedAt: new Date().toISOString(),
        exitCode,
        signal,
      });
    });

    await wait(150);
    return this.status(serviceId);
  }

  async stop(serviceId: string, request: StopServiceRequest = {}): Promise<ServiceRuntimeStatus> {
    this.#assertLifecycleControl(this.#definition(serviceId), "停止");
    const mode = request.mode ?? "request";
    if (!["request", "confirm-external", "force"].includes(mode)) {
      throw new DevHubError("INVALID_STOP_MODE", "停止模式不合法", 400);
    }
    if (mode === "force") return this.#forceStop(serviceId, request.token);

    const managed = this.#managed.get(serviceId);
    if (managed) return this.#stopManaged(serviceId, managed, false);

    const current = await this.status(serviceId);
    if (current.lifecycle === "stopped") return current;
    if (current.lifecycle === "conflict") {
      throw new DevHubError(
        "PORT_CONFLICT",
        "端口冲突或身份不符的进程不能作为目标服务一键停止",
        409,
        current,
      );
    }
    if (current.lifecycle !== "external") return current;

    const definition = this.#definition(serviceId);
    if (definition.externalStop !== "confirm-matching-cwd") {
      throw new DevHubError("EXTERNAL_STOP_DENIED", `${definition.name} 禁止停止外部进程`, 409);
    }
    if (mode !== "confirm-external") {
      const intent = await this.#createIntent(serviceId, "external", "confirm-external");
      throw new DevHubError(
        "EXTERNAL_CONFIRMATION_REQUIRED",
        `${definition.name} 不是由 Hub 启动；请核对影响范围后再次确认`,
        409,
        this.#intentDetails(intent),
      );
    }
    const intent = this.#consumeIntent(serviceId, request.token, "confirm-external");
    await this.#revalidateIntent(intent);
    return this.#stopTarget(intent, false);
  }

  async stopAllManaged(): Promise<void> {
    await Promise.allSettled(
      [...this.#managed.entries()].map(
        ([serviceId, managed]) => this.#stopManaged(serviceId, managed, true),
      ),
    );
  }

  async restart(serviceId: string): Promise<ServiceRuntimeStatus> {
    const definition = this.#definition(serviceId);
    this.#assertLifecycleControl(definition, "重启");
    const current = await this.status(serviceId);
    if (current.lifecycle === "conflict") {
      throw new DevHubError("PORT_CONFLICT", `${definition.name} 存在端口或身份冲突，不能重启`, 409, current);
    }
    if (current.lifecycle === "external") {
      throw new DevHubError(
        "EXTERNAL_RESTART_DENIED",
        `${definition.name} 不是由 Hub 启动；请先按外部停止二次确认流程停止，再单独启动`,
        409,
        current,
      );
    }
    const managed = this.#managed.get(serviceId);
    if (managed) await this.#stopManaged(serviceId, managed, false);
    return this.start(serviceId);
  }

  async #prepareProfile(definition: ServiceDefinition): Promise<void> {
    if (!definition.profilePolicy) return;
    const key = `${definition.seriesId ?? definition.moduleId}/${definition.profileId ?? "default"}`;
    let preparing = this.#preparingProfiles.get(key);
    if (!preparing) {
      const definitions = [...this.#definitions.values()].filter((candidate) => (
        (candidate.seriesId ?? candidate.moduleId) === (definition.seriesId ?? definition.moduleId)
        && (candidate.profileId ?? "default") === (definition.profileId ?? "default")
      ));
      const log = (message: string) => {
        for (const candidate of definitions) this.#logs.get(candidate.id)?.append("system", `[Profile] ${message}`);
      };
      preparing = (async () => {
        try {
          await this.#profileDatabasePreflight.assertReady(definition, [...this.#definitions.values()]);
        } catch (error) {
          log(error instanceof Error ? error.message : "数据库 preflight 失败");
          throw error;
        }
        return this.#profileAssembly.prepare(definitions, log);
      })().finally(() => {
        this.#preparingProfiles.delete(key);
      });
      this.#preparingProfiles.set(key, preparing);
    }
    await preparing;
  }

  #assertLifecycleControl(definition: ServiceDefinition, action: string): void {
    if (definition.profilePolicy?.lifecycleControl === false) {
      throw new DevHubError(
        "PROFILE_LIFECYCLE_READ_ONLY",
        `${definition.profileName ?? definition.name} 为 ${definition.profilePolicy.environmentKind} 只读 Profile；Hub 已拒绝${action}`,
        403,
        {
          seriesId: definition.seriesId,
          profileId: definition.profileId,
          environmentKind: definition.profilePolicy.environmentKind,
          requiredControls: ["独立 capability", "维护窗口", "可信备份", "二次确认", "完整审计"],
        },
      );
    }
  }

  async #captureRootIdentity(pid: number): Promise<ProcessSummary | undefined> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const identity = await describeProcess(pid);
      if (identity?.startedAt) return identity;
      await wait(40);
    }
    return undefined;
  }

  async #stopManaged(
    serviceId: string,
    managed: ManagedProcess,
    forceOnTimeout: boolean,
  ): Promise<ServiceRuntimeStatus> {
    if (this.#managed.get(serviceId)?.ownershipId !== managed.ownershipId) return this.status(serviceId);
    const currentRoot = await describeProcess(managed.root.pid);
    if (!sameProcessIdentity(managed.root, currentRoot)) {
      this.#managed.delete(serviceId);
      throw new DevHubError(
        "OWNERSHIP_STALE",
        "Hub ownership 已过期或 PID 被复用，已取消停止并重新检测",
        409,
      );
    }
    managed.stopping = true;
    const intent = await this.#createIntent(serviceId, "hub", "force", managed.ownershipId);
    this.#logs.get(serviceId)?.append(
      "system",
      `向 Hub ownership ${managed.ownershipId} 的进程组 ${intent.processGroupIds.join(",")} 发送 SIGTERM`,
    );
    await this.#signalGroups(intent.processGroupIds, "SIGTERM");
    if (await this.#waitForTargetExit(intent, STOP_TIMEOUT_MS)) {
      this.#managed.delete(serviceId);
      return this.status(serviceId);
    }

    const forceIntent = await this.#refreshForceIntent(intent);
    if (forceOnTimeout) {
      await this.#revalidateIntent(forceIntent);
      this.#logs.get(serviceId)?.append(
        "system",
        `Hub 关闭期间优雅停止超时；身份复核通过，向 PGID ${forceIntent.processGroupIds.join(",")} 发送 SIGKILL`,
      );
      await this.#signalGroups(forceIntent.processGroupIds, "SIGKILL");
      await this.#waitForTargetExit(forceIntent, FORCE_TIMEOUT_MS);
      this.#managed.delete(serviceId);
      return this.status(serviceId);
    }
    this.#stopIntents.set(forceIntent.token, forceIntent);
    throw new DevHubError(
      "FORCE_STOP_REQUIRED",
      "优雅停止超时；请重新核对当前身份后确认强制终止",
      409,
      this.#intentDetails(forceIntent),
    );
  }

  async #forceStop(serviceId: string, token: string | undefined): Promise<ServiceRuntimeStatus> {
    const intent = this.#consumeIntent(serviceId, token, "force");
    await this.#revalidateIntent(intent);
    this.#logs.get(serviceId)?.append(
      "system",
      `用户确认强制终止 PGID ${intent.processGroupIds.join(",")}；发送 SIGKILL`,
    );
    await this.#signalGroups(intent.processGroupIds, "SIGKILL");
    if (!(await this.#waitForTargetExit(intent, FORCE_TIMEOUT_MS))) {
      throw new DevHubError("FORCE_STOP_FAILED", "强制终止后目标进程或端口仍存在", 500);
    }
    if (intent.ownership === "hub") this.#managed.delete(serviceId);
    return this.status(serviceId);
  }

  async #stopTarget(intent: StopIntent, forceOnTimeout: boolean): Promise<ServiceRuntimeStatus> {
    this.#logs.get(intent.serviceId)?.append(
      "system",
      `经确认向外部进程组 ${intent.processGroupIds.join(",")} 发送 SIGTERM`,
    );
    await this.#signalGroups(intent.processGroupIds, "SIGTERM");
    if (await this.#waitForTargetExit(intent, STOP_TIMEOUT_MS)) return this.status(intent.serviceId);
    const forceIntent = await this.#refreshForceIntent(intent);
    if (forceOnTimeout) {
      await this.#signalGroups(forceIntent.processGroupIds, "SIGKILL");
      await this.#waitForTargetExit(forceIntent, FORCE_TIMEOUT_MS);
      return this.status(intent.serviceId);
    }
    this.#stopIntents.set(forceIntent.token, forceIntent);
    throw new DevHubError(
      "FORCE_STOP_REQUIRED",
      "外部进程未在限时内退出；再次核对后才可强制终止",
      409,
      this.#intentDetails(forceIntent),
    );
  }

  async #createIntent(
    serviceId: string,
    ownership: "hub" | "external",
    purpose: StopIntent["purpose"],
    ownershipId?: string,
  ): Promise<StopIntent> {
    const definition = this.#definition(serviceId);
    const portOwners = Object.fromEntries(await Promise.all(definition.endpoints.map(async (endpoint) => [
      endpoint.port,
      await listenerPids(endpoint.port),
    ] as const)));
    const listenerIds = [...new Set(Object.values(portOwners).flat())];
    const listenerProcesses = (await Promise.all(listenerIds.map(describeProcess))).filter(
      (item): item is ProcessSummary => Boolean(item),
    );
    const managed = this.#managed.get(serviceId);
    const groupIds = ownership === "hub"
      ? managed ? [managed.root.processGroupId] : []
      : [...new Set(listenerProcesses.map((item) => item.processGroupId))];
    if (groupIds.length === 0) {
      throw new DevHubError("STOP_TARGET_CHANGED", "目标进程或端口已经变化，请重新检测", 409);
    }
    if (groupIds.includes(process.pid) || groupIds.includes(process.ppid)) {
      throw new DevHubError("UNSAFE_STOP_TARGET", "目标进程组与 Hub 自身重叠，已拒绝停止", 409);
    }
    const groupMembers = uniqueProcesses((await Promise.all(groupIds.map(processGroupMembers))).flat());
    if (groupMembers.length === 0 || groupMembers.some((item) => !item.startedAt)) {
      throw new DevHubError("UNVERIFIED_STOP_TARGET", "无法取得稳定启动时间，已拒绝停止", 409);
    }
    if (ownership === "external" && groupMembers.some((item) => !isPathInside(item.cwd, definition.cwd))) {
      throw new DevHubError(
        "EXTERNAL_CWD_MISMATCH",
        "外部进程组包含工作目录不匹配的成员，已拒绝停止",
        409,
        groupMembers,
      );
    }
    const memberIds = new Set(groupMembers.map((item) => item.pid));
    if (listenerProcesses.some((item) => !memberIds.has(item.pid))) {
      throw new DevHubError("STOP_TARGET_CHANGED", "端口所有者在检测期间发生变化", 409);
    }
    const intent: StopIntent = {
      token: randomUUID(),
      serviceId,
      ownership,
      purpose,
      expiresAtMs: Date.now() + INTENT_TTL_MS,
      processGroupIds: groupIds,
      processes: groupMembers,
      portOwners,
      ownershipId,
    };
    if (purpose === "confirm-external") this.#stopIntents.set(intent.token, intent);
    return intent;
  }

  #consumeIntent(
    serviceId: string,
    token: string | undefined,
    purpose: StopIntent["purpose"],
  ): StopIntent {
    const intent = token ? this.#stopIntents.get(token) : undefined;
    if (token) this.#stopIntents.delete(token);
    if (!intent || intent.serviceId !== serviceId || intent.purpose !== purpose) {
      throw new DevHubError("STOP_CONFIRMATION_INVALID", "停止确认已失效，请重新检测", 409);
    }
    if (intent.expiresAtMs < Date.now()) {
      throw new DevHubError("STOP_CONFIRMATION_EXPIRED", "停止确认已过期，请重新检测", 409);
    }
    return intent;
  }

  async #revalidateIntent(intent: StopIntent): Promise<void> {
    const definition = this.#definition(intent.serviceId);
    if (intent.ownership === "hub") {
      const managed = this.#managed.get(intent.serviceId);
      if (!managed || managed.ownershipId !== intent.ownershipId) {
        throw new DevHubError("OWNERSHIP_STALE", "Hub ownership 已变化，停止已取消", 409);
      }
    }
    const currentGroups = uniqueProcesses(
      (await Promise.all(intent.processGroupIds.map(processGroupMembers))).flat(),
    );
    if (
      currentGroups.length !== intent.processes.length
      || intent.processes.some((expected) => {
        return !sameProcessIdentity(expected, currentGroups.find((item) => item.pid === expected.pid));
      })
    ) {
      throw new DevHubError(
        "STOP_TARGET_CHANGED",
        "确认期间进程身份、成员或 PID 已变化，停止已取消并要求重新检测",
        409,
      );
    }
    if (intent.ownership === "external" && currentGroups.some(
      (item) => !isPathInside(item.cwd, definition.cwd),
    )) {
      throw new DevHubError("STOP_TARGET_CHANGED", "确认期间进程工作目录发生变化", 409);
    }
    for (const [port, expectedPids] of Object.entries(intent.portOwners)) {
      const currentPids = await listenerPids(Number(port));
      if (!sameNumberSet(expectedPids, currentPids)) {
        throw new DevHubError(
          "STOP_TARGET_CHANGED",
          `确认期间端口 ${port} 已换主，停止已取消并要求重新检测`,
          409,
        );
      }
    }
  }

  async #refreshForceIntent(previous: StopIntent): Promise<StopIntent> {
    const definition = this.#definition(previous.serviceId);
    const members = process.platform === "win32"
      ? uniqueProcesses((await Promise.all(previous.processes.map(async (expected) => {
          const current = await describeProcess(expected.pid);
          return sameProcessIdentity(expected, current) ? [current!] : [];
        }))).flat())
      : uniqueProcesses((await Promise.all(previous.processGroupIds.map(processGroupMembers))).flat());
    const changed = members.some((current) => {
      const expected = previous.processes.find((item) => item.pid === current.pid);
      return !sameProcessIdentity(expected ?? current, expected ? current : undefined);
    });
    if (changed || (previous.ownership === "external" && members.some(
      (item) => !isPathInside(item.cwd, definition.cwd),
    ))) {
      throw new DevHubError(
        "STOP_TARGET_CHANGED",
        "优雅停止期间进程身份发生变化，已取消升级操作",
        409,
      );
    }
    const portOwners = Object.fromEntries(await Promise.all(definition.endpoints.map(async (endpoint) => [
      endpoint.port,
      await listenerPids(endpoint.port),
    ] as const)));
    const survivingGroups = process.platform === "win32"
      ? members.map((item) => item.pid)
      : [...new Set(members.map((item) => item.processGroupId))];
    const currentListenerIds = Object.values(portOwners).flat();
    const currentListeners = (await Promise.all(currentListenerIds.map(describeProcess))).filter(
      (item): item is ProcessSummary => Boolean(item),
    );
    if (currentListeners.some((item) => !survivingGroups.includes(item.processGroupId))) {
      throw new DevHubError("STOP_TARGET_CHANGED", "优雅停止期间端口已换主，已取消升级操作", 409);
    }
    if (members.length === 0 && currentListenerIds.length === 0) {
      throw new DevHubError("STOP_ALREADY_COMPLETED", "目标已退出，无需强制终止", 409);
    }
    return {
      token: randomUUID(),
      serviceId: previous.serviceId,
      ownership: previous.ownership,
      purpose: "force",
      expiresAtMs: Date.now() + INTENT_TTL_MS,
      processGroupIds: survivingGroups,
      processes: members,
      portOwners,
      ownershipId: previous.ownershipId,
    };
  }

  async #signalGroups(
    processGroupIds: readonly number[],
    signal: "SIGTERM" | "SIGKILL",
  ): Promise<void> {
    for (const processGroupId of processGroupIds) {
      try {
        if (process.platform === "win32") process.kill(processGroupId, signal);
        else process.kill(-processGroupId, signal);
      } catch (error) {
        const current = await processGroupMembers(processGroupId);
        if (current.length > 0) {
          const message = error instanceof Error ? error.message : String(error);
          throw new DevHubError("STOP_FAILED", `无法向进程组 ${processGroupId} 发送 ${signal}：${message}`, 500);
        }
      }
    }
  }

  async #waitForTargetExit(intent: StopIntent, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const groups = (await Promise.all(intent.processGroupIds.map(processGroupMembers))).flat();
      const ports = (await Promise.all(Object.keys(intent.portOwners).map((port) => listenerPids(Number(port))))).flat();
      if (groups.length === 0 && ports.length === 0) return true;
      await wait(100);
    }
    const groups = (await Promise.all(intent.processGroupIds.map(processGroupMembers))).flat();
    const ports = (await Promise.all(Object.keys(intent.portOwners).map((port) => listenerPids(Number(port))))).flat();
    return groups.length === 0 && ports.length === 0;
  }

  #intentDetails(intent: StopIntent): StopTargetDetails {
    const definition = this.#definition(intent.serviceId);
    return {
      serviceId: intent.serviceId,
      ownership: intent.ownership,
      token: intent.token,
      expiresAt: new Date(intent.expiresAtMs).toISOString(),
      ports: definition.endpoints.map((item) => item.port),
      processGroupIds: intent.processGroupIds,
      processes: intent.processes,
      command: processCommand(definition),
      cwd: definition.cwd,
      impact: `将向 ${intent.processGroupIds.length} 个精确进程组、共 ${intent.processes.length} 个已复核成员发送信号；不会按名称查杀，也不会影响目标端口之外的进程`,
    };
  }

  #definition(serviceId: string): ServiceDefinition {
    const definition = this.#definitions.get(serviceId);
    if (!definition) throw new DevHubError("SERVICE_NOT_FOUND", `未知服务：${serviceId}`, 404);
    return definition;
  }
}
