import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  ServiceCommandDefinition,
  ServiceConfigurationFileV2,
  ServiceDefinition,
  ServiceEndpointDefinition,
  ServiceIdentityDefinition,
  ServiceProfileMetadata,
  ServiceProfilePolicy,
  ServiceProfileRegistryPackage,
  ServiceProfileSource,
  ServiceSeriesSource,
  ServiceSourceDefinition,
} from "../shared/contracts.js";
import { DevHubError } from "./errors.js";

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const BLOCKED_EXECUTABLES = new Set(["bash", "cmd", "fish", "powershell", "pwsh", "sh", "zsh"]);
const BLOCKED_ENV_NAMES = new Set(["DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "NODE_OPTIONS"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

interface ServiceConfigFileV1 {
  readonly version: 1;
  readonly services: readonly unknown[];
}

export interface LoadedServiceConfiguration {
  readonly source: ServiceConfigurationFileV2;
  readonly definitions: readonly ServiceDefinition[];
  readonly configurationErrors?: readonly string[];
}

export interface ResolveServiceConfigurationOptions {
  /** 启动 Hub 时允许本机路径暂时不存在；编辑、导入等写入口仍使用严格校验。 */
  readonly tolerateUnavailablePaths?: boolean;
}

const SERVICE_CONFIG_CANDIDATES = [
  "config/services.user.json",
  "config/services.json",
] as const;

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DevHubError("INVALID_CONFIG", `${label} 必须是对象`, 500);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DevHubError("INVALID_CONFIG", `${label} 必须是非空字符串`, 500);
  }
  return value.trim();
}

function requiredId(value: unknown, label: string): string {
  const id = requiredString(value, label);
  if (!ID_PATTERN.test(id)) {
    throw new DevHubError("INVALID_CONFIG", `${label} 不合法：${id}`, 500);
  }
  return id;
}

function resolveLoopbackUrl(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const raw = requiredString(value, label);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DevHubError("INVALID_CONFIG", `${label} 不是合法 URL`, 500);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || !["http:", "https:"].includes(url.protocol)) {
    throw new DevHubError("INVALID_CONFIG", `${label} 只能使用本机 HTTP(S) 地址`, 500);
  }
  return url.toString();
}

function parseEndpoint(value: unknown, serviceId: string): ServiceEndpointDefinition {
  assertObject(value, `服务 ${serviceId} endpoint`);
  const id = requiredId(value.id, `服务 ${serviceId} endpoint.id`);
  const port = value.port;
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new DevHubError("INVALID_CONFIG", `服务 ${serviceId}/${id} 端口不合法`, 500);
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    throw new DevHubError("INVALID_CONFIG", `服务 ${serviceId}/${id} required 必须是布尔值`, 500);
  }
  return {
    id,
    label: requiredString(value.label, `服务 ${serviceId}/${id} label`),
    port: Number(port),
    openUrl: resolveLoopbackUrl(value.openUrl, `服务 ${serviceId}/${id} openUrl`),
    healthUrl: resolveLoopbackUrl(value.healthUrl, `服务 ${serviceId}/${id} healthUrl`),
    required: value.required === undefined ? true : value.required === true,
  };
}

function parseIdentity(value: unknown, serviceId: string): ServiceIdentityDefinition | undefined {
  if (value === undefined || value === null) return undefined;
  assertObject(value, `服务 ${serviceId} identity`);
  const urlLabel = `服务 ${serviceId} identity.url`;
  assertObject(value.expected, `服务 ${serviceId} identity.expected`);
  const entries = Object.entries(value.expected);
  if (entries.length === 0 || entries.some(([, expected]) => !["string", "number", "boolean"].includes(typeof expected))) {
    throw new DevHubError(
      "INVALID_CONFIG",
      `服务 ${serviceId} identity.expected 必须包含字符串、数字或布尔字段`,
      500,
    );
  }
  return {
    url: resolveLoopbackUrl(requiredString(value.url, urlLabel), urlLabel)!,
    expected: Object.fromEntries(entries) as Readonly<Record<string, string | number | boolean>>,
  };
}

function parseCommand(value: unknown, serviceId: string): ServiceCommandDefinition {
  assertObject(value, `服务 ${serviceId} command`);
  const executable = requiredString(value.executable, `服务 ${serviceId} command.executable`);
  if (BLOCKED_EXECUTABLES.has(path.basename(executable).toLowerCase())) {
    throw new DevHubError(
      "INVALID_CONFIG",
      `服务 ${serviceId} 不允许直接使用 shell 作为启动命令：${executable}`,
      500,
    );
  }
  if (!Array.isArray(value.args) || !value.args.every((item) => typeof item === "string")) {
    throw new DevHubError("INVALID_CONFIG", `服务 ${serviceId} command.args 必须是字符串数组`, 500);
  }
  const rawArgs = value.args as string[];
  const executableName = path.basename(executable).toLowerCase();
  const args = executableName === "pnpm" && rawArgs[1] === "--"
    ? [rawArgs[0]!, ...rawArgs.slice(2)]
    : [...rawArgs];

  let env: Readonly<Record<string, string>> | undefined;
  if (value.env !== undefined && value.env !== null) {
    assertObject(value.env, `服务 ${serviceId} command.env`);
    const entries = Object.entries(value.env).map(([name, raw]) => {
      if (!ENV_NAME_PATTERN.test(name) || BLOCKED_ENV_NAMES.has(name) || typeof raw !== "string") {
        throw new DevHubError("INVALID_CONFIG", `服务 ${serviceId} 环境变量不合法：${name}`, 500);
      }
      return [name, raw] as const;
    });
    env = Object.fromEntries(entries);
  }
  return { executable, args, env };
}

export function parseServiceDefinition(
  value: unknown,
  projectRoot: string,
  options: { readonly allowMissingCwd?: boolean } = {},
): ServiceDefinition {
  assertObject(value, "service");
  const id = requiredId(value.id, "service.id");
  const configuredCwd = requiredString(value.cwd, `服务 ${id} cwd`);
  const cwd = path.resolve(projectRoot, configuredCwd);
  if ((!existsSync(cwd) && !options.allowMissingCwd) || (existsSync(cwd) && !statSync(cwd).isDirectory())) {
    throw new DevHubError("INVALID_CONFIG", `服务 ${id} 工作目录不存在：${cwd}`, 500);
  }
  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0) {
    throw new DevHubError("INVALID_CONFIG", `服务 ${id} 至少需要一个 endpoint`, 500);
  }
  const endpoints = value.endpoints.map((endpoint) => parseEndpoint(endpoint, id));
  const endpointIds = new Set<string>();
  const endpointPorts = new Set<number>();
  for (const endpoint of endpoints) {
    if (endpointIds.has(endpoint.id) || endpointPorts.has(endpoint.port)) {
      throw new DevHubError("INVALID_CONFIG", `服务 ${id} endpoint ID 或端口重复`, 500);
    }
    endpointIds.add(endpoint.id);
    endpointPorts.add(endpoint.port);
  }

  const externalStop = value.externalStop ?? "deny";
  if (externalStop !== "deny" && externalStop !== "confirm-matching-cwd") {
    throw new DevHubError("INVALID_CONFIG", `服务 ${id} externalStop 不合法`, 500);
  }
  const moduleId = requiredId(value.moduleId, `服务 ${id} moduleId`);
  const startOrder = value.startOrder === undefined ? 0 : Number(value.startOrder);
  if (!Number.isInteger(startOrder) || startOrder < -10_000 || startOrder > 10_000) {
    throw new DevHubError("INVALID_CONFIG", `服务 ${id} startOrder 必须是整数`, 500);
  }

  return {
    id,
    name: requiredString(value.name, `服务 ${id} name`),
    moduleId,
    moduleName: requiredString(value.moduleName, `服务 ${id} moduleName`),
    description: typeof value.description === "string" ? value.description.trim() : undefined,
    cwd,
    command: parseCommand(value.command, id),
    endpoints,
    identity: parseIdentity(value.identity, id),
    externalStop,
    startOrder,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 对象深度合并；数组整体替换；null 保留为显式清空。 */
export function mergeServiceSource(
  base: ServiceSourceDefinition | undefined,
  override: ServiceSourceDefinition,
): ServiceSourceDefinition {
  const merge = (left: unknown, right: unknown): unknown => {
    if (!isPlainObject(left) || !isPlainObject(right)) return cloneJson(right);
    const result: Record<string, unknown> = { ...cloneJson(left) };
    for (const [key, value] of Object.entries(right)) {
      result[key] = isPlainObject(value) && isPlainObject(result[key])
        ? merge(result[key], value)
        : cloneJson(value);
    }
    return result;
  };
  return merge(base ?? {}, override) as ServiceSourceDefinition;
}

function parseMetadata(value: unknown, label: string): ServiceProfileMetadata | undefined {
  if (value === undefined) return undefined;
  assertObject(value, label);
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new DevHubError("INVALID_CONFIG", `${label} 的值必须是字符串`, 500);
  }
  return Object.fromEntries(entries) as ServiceProfileMetadata;
}

function resolveExistingPath(
  value: unknown,
  label: string,
  projectRoot: string,
  kind: "file" | "directory",
  options: ResolveServiceConfigurationOptions = {},
): string {
  const resolved = path.resolve(projectRoot, requiredString(value, label));
  if (!existsSync(resolved)) {
    if (options.tolerateUnavailablePaths) return resolved;
    throw new DevHubError("INVALID_CONFIG", `${label} 不存在：${resolved}`, 500);
  }
  const stat = statSync(resolved);
  if ((kind === "file" && !stat.isFile()) || (kind === "directory" && !stat.isDirectory())) {
    if (options.tolerateUnavailablePaths) return resolved;
    throw new DevHubError("INVALID_CONFIG", `${label} 必须是${kind === "file" ? "文件" : "目录"}：${resolved}`, 500);
  }
  return resolved;
}

function safeRelativeDirectory(value: unknown, label: string): string {
  const raw = requiredString(value, label).replaceAll("\\", "/");
  if (path.posix.isAbsolute(raw) || raw === "." || raw.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new DevHubError("INVALID_CONFIG", `${label} 必须是安全相对目录`, 500);
  }
  return raw;
}

function parseGitInput(
  value: unknown,
  label: string,
  projectRoot: string,
  options: ResolveServiceConfigurationOptions,
) {
  assertObject(value, label);
  const commit = requiredString(value.commit, `${label}.commit`);
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new DevHubError("INVALID_CONFIG", `${label}.commit 必须是 40 位 Git commit`, 500);
  }
  return {
    root: resolveExistingPath(value.root, `${label}.root`, projectRoot, "directory", options),
    commit,
  };
}

function parseRegistryPackages(
  value: unknown,
  label: string,
  serviceRoles: ReadonlySet<string>,
): readonly ServiceProfileRegistryPackage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DevHubError("INVALID_CONFIG", `${label} 至少需要一项 Registry 包`, 500);
  }
  const identities = new Set<string>();
  return value.map((raw, index) => {
    const itemLabel = `${label}[${index}]`;
    assertObject(raw, itemLabel);
    const serviceRole = requiredId(raw.serviceRole, `${itemLabel}.serviceRole`);
    if (!serviceRoles.has(serviceRole)) {
      throw new DevHubError("INVALID_CONFIG", `${itemLabel} 引用了未知 serviceRole：${serviceRole}`, 500);
    }
    const name = requiredString(raw.name, `${itemLabel}.name`);
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new DevHubError("INVALID_CONFIG", `${itemLabel}.name 不是合法包名`, 500);
    }
    const version = requiredString(raw.version, `${itemLabel}.version`);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new DevHubError("INVALID_CONFIG", `${itemLabel}.version 必须是精确版本`, 500);
    }
    const integrity = requiredString(raw.integrity, `${itemLabel}.integrity`);
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
      throw new DevHubError("INVALID_CONFIG", `${itemLabel}.integrity 必须是 sha512 SRI`, 500);
    }
    const identity = `${serviceRole}:${name}`;
    if (identities.has(identity)) {
      throw new DevHubError("INVALID_CONFIG", `${label} 包含重复包：${identity}`, 500);
    }
    identities.add(identity);
    return { serviceRole, name, version, integrity };
  });
}

function parseProfilePolicy(
  value: unknown,
  label: string,
  projectRoot: string,
  serviceRoles: ReadonlySet<string>,
  options: ResolveServiceConfigurationOptions,
): ServiceProfilePolicy {
  assertObject(value, label);
  const environmentKind = requiredString(value.environmentKind, `${label}.environmentKind`);
  if (!["development", "release-validation", "preproduction", "production"].includes(environmentKind)) {
    throw new DevHubError("INVALID_CONFIG", `${label}.environmentKind 不合法：${environmentKind}`, 500);
  }
  const deploymentMode = requiredString(value.deploymentMode, `${label}.deploymentMode`);
  if (!["source-mounted", "package-assembled"].includes(deploymentMode)) {
    throw new DevHubError("INVALID_CONFIG", `${label}.deploymentMode 不合法：${deploymentMode}`, 500);
  }
  if (environmentKind !== "development" && deploymentMode !== "package-assembled") {
    throw new DevHubError("INVALID_CONFIG", `${label} 的 ${environmentKind} 禁止源码挂载`, 500);
  }
  const lifecycleControl = value.lifecycleControl === undefined
    ? environmentKind !== "production"
    : value.lifecycleControl;
  if (typeof lifecycleControl !== "boolean" || (environmentKind === "production" && lifecycleControl)) {
    throw new DevHubError("INVALID_CONFIG", `${label} 的 production 生命周期必须为只读`, 500);
  }
  assertObject(value.database, `${label}.database`);
  const serviceRole = requiredId(value.database.serviceRole, `${label}.database.serviceRole`);
  if (!serviceRoles.has(serviceRole)) {
    throw new DevHubError("INVALID_CONFIG", `${label}.database 引用了未知 serviceRole：${serviceRole}`, 500);
  }
  const envName = requiredString(value.database.envName, `${label}.database.envName`);
  if (!ENV_NAME_PATTERN.test(envName) || BLOCKED_ENV_NAMES.has(envName)) {
    throw new DevHubError("INVALID_CONFIG", `${label}.database.envName 不合法`, 500);
  }
  const databaseName = requiredString(value.database.name, `${label}.database.name`);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) {
    throw new DevHubError("INVALID_CONFIG", `${label}.database.name 必须是安全 PostgreSQL 标识符`, 500);
  }
  const forbiddenNames = value.database.forbiddenNames === undefined
    ? []
    : value.database.forbiddenNames;
  if (!Array.isArray(forbiddenNames) || !forbiddenNames.every((item) => typeof item === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(item))) {
    throw new DevHubError("INVALID_CONFIG", `${label}.database.forbiddenNames 不合法`, 500);
  }
  if (forbiddenNames.includes(databaseName)) {
    throw new DevHubError("INVALID_CONFIG", `${label} 数据库命中禁止名单：${databaseName}`, 500);
  }
  let databasePreflight: ServiceProfilePolicy["database"]["preflight"];
  if (value.database.preflight !== undefined) {
    assertObject(value.database.preflight, `${label}.database.preflight`);
    if (value.database.preflight.provider !== "postgresql") {
      throw new DevHubError("INVALID_CONFIG", `${label}.database.preflight.provider 只接受 postgresql`, 500);
    }
    const host = requiredString(value.database.preflight.host, `${label}.database.preflight.host`);
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new DevHubError(
        "INVALID_CONFIG",
        `${label}.database.preflight.host 只允许本机 PostgreSQL，拒绝连接远程或生产数据库`,
        500,
      );
    }
    const port = Number(value.database.preflight.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new DevHubError("INVALID_CONFIG", `${label}.database.preflight.port 不合法`, 500);
    }
    const maintenanceDatabase = requiredString(
      value.database.preflight.maintenanceDatabase,
      `${label}.database.preflight.maintenanceDatabase`,
    );
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(maintenanceDatabase) || maintenanceDatabase === databaseName) {
      throw new DevHubError(
        "INVALID_CONFIG",
        `${label}.database.preflight.maintenanceDatabase 必须是独立的安全维护库`,
        500,
      );
    }
    const usernameEnv = requiredString(
      value.database.preflight.usernameEnv,
      `${label}.database.preflight.usernameEnv`,
    );
    const passwordEnv = requiredString(
      value.database.preflight.passwordEnv,
      `${label}.database.preflight.passwordEnv`,
    );
    if (
      !ENV_NAME_PATTERN.test(usernameEnv)
      || !ENV_NAME_PATTERN.test(passwordEnv)
      || BLOCKED_ENV_NAMES.has(usernameEnv)
      || BLOCKED_ENV_NAMES.has(passwordEnv)
    ) {
      throw new DevHubError("INVALID_CONFIG", `${label}.database.preflight 凭据环境变量名不合法`, 500);
    }
    const requiredRelations = value.database.preflight.requiredRelations;
    if (
      !Array.isArray(requiredRelations)
      || requiredRelations.length === 0
      || requiredRelations.length > 64
      || !requiredRelations.every((item) => typeof item === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(item))
      || new Set(requiredRelations).size !== requiredRelations.length
    ) {
      throw new DevHubError(
        "INVALID_CONFIG",
        `${label}.database.preflight.requiredRelations 必须是非空、去重的安全 SQL 标识符白名单`,
        500,
      );
    }
    const requiredRelationsStatus = value.database.preflight.requiredRelationsStatus;
    if (requiredRelationsStatus !== "provisional" && requiredRelationsStatus !== "versioned-manifest") {
      throw new DevHubError(
        "INVALID_CONFIG",
        `${label}.database.preflight.requiredRelationsStatus 必须是 provisional 或 versioned-manifest`,
        500,
      );
    }
    let creation: NonNullable<ServiceProfilePolicy["database"]["preflight"]>["creation"];
    if (value.database.preflight.creation !== undefined) {
      assertObject(value.database.preflight.creation, `${label}.database.preflight.creation`);
      const allowedDatabaseNames = value.database.preflight.creation.allowedDatabaseNames;
      if (
        !Array.isArray(allowedDatabaseNames)
        || allowedDatabaseNames.length === 0
        || !allowedDatabaseNames.every((item) => typeof item === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(item))
        || new Set(allowedDatabaseNames).size !== allowedDatabaseNames.length
        || !allowedDatabaseNames.includes(databaseName)
      ) {
        throw new DevHubError(
          "INVALID_CONFIG",
          `${label}.database.preflight.creation 必须用精确 allowlist 授权当前验收数据库名`,
          500,
        );
      }
      const cleanupResponsibility = requiredString(
        value.database.preflight.creation.cleanupResponsibility,
        `${label}.database.preflight.creation.cleanupResponsibility`,
      );
      if (cleanupResponsibility.length > 240) {
        throw new DevHubError("INVALID_CONFIG", `${label}.database.preflight.creation.cleanupResponsibility 过长`, 500);
      }
      creation = { allowedDatabaseNames, cleanupResponsibility };
    }
    databasePreflight = {
      provider: "postgresql",
      host,
      port,
      maintenanceDatabase,
      usernameEnv,
      passwordEnv,
      requiredRelations,
      requiredRelationsStatus,
      ...(creation ? { creation } : {}),
    };
  }
  if (environmentKind === "release-validation" && !databasePreflight) {
    throw new DevHubError(
      "INVALID_CONFIG",
      `${label} 的 release-validation 必须配置本机 PostgreSQL spawn 前 preflight`,
      500,
    );
  }

  let assembly: ServiceProfilePolicy["assembly"];
  if (deploymentMode === "package-assembled") {
    assertObject(value.assembly, `${label}.assembly`);
    const outputRoot = path.resolve(projectRoot, requiredString(value.assembly.outputRoot, `${label}.assembly.outputRoot`));
    const runtimeRoot = path.join(path.resolve(projectRoot), ".runtime");
    const relativeOutput = path.relative(runtimeRoot, outputRoot);
    if (!relativeOutput || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
      throw new DevHubError("INVALID_CONFIG", `${label}.assembly.outputRoot 必须位于 Hub .runtime 的独立子目录`, 500);
    }
    assertObject(value.assembly.roleDirectories, `${label}.assembly.roleDirectories`);
    const roleDirectories = Object.fromEntries(Object.entries(value.assembly.roleDirectories).map(([role, directory]) => {
      const normalizedRole = requiredId(role, `${label}.assembly.roleDirectories role`);
      if (!serviceRoles.has(normalizedRole)) {
        throw new DevHubError("INVALID_CONFIG", `${label}.assembly.roleDirectories 引用了未知 role：${normalizedRole}`, 500);
      }
      const normalizedDirectory = safeRelativeDirectory(directory, `${label}.assembly.roleDirectories.${normalizedRole}`);
      if (normalizedDirectory !== "node" && normalizedDirectory !== "vue") {
        throw new DevHubError(
          "INVALID_CONFIG",
          `${label}.assembly.roleDirectories.${normalizedRole} 只允许映射到独立 node 或 vue Host 快照`,
          500,
        );
      }
      return [normalizedRole, normalizedDirectory];
    }));
    for (const role of serviceRoles) {
      if (!roleDirectories[role]) {
        throw new DevHubError("INVALID_CONFIG", `${label}.assembly.roleDirectories 缺少 ${role}`, 500);
      }
    }
    const packageSha256 = requiredString(value.assembly.packageSha256, `${label}.assembly.packageSha256`);
    if (!/^[a-f0-9]{64}$/.test(packageSha256)) {
      throw new DevHubError("INVALID_CONFIG", `${label}.assembly.packageSha256 必须是 SHA-256`, 500);
    }
    if (value.assembly.packageKind !== "pah-business-module") {
      throw new DevHubError("INVALID_CONFIG", `${label}.assembly.packageKind 只接受 pah-business-module`, 500);
    }
    const moduleId = requiredId(value.assembly.moduleId, `${label}.assembly.moduleId`);
    const packageVersion = requiredString(value.assembly.version, `${label}.assembly.version`);
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(packageVersion)) {
      throw new DevHubError("INVALID_CONFIG", `${label}.assembly.version 不合法`, 500);
    }
    if (value.assembly.installDependencies !== undefined && typeof value.assembly.installDependencies !== "boolean") {
      throw new DevHubError("INVALID_CONFIG", `${label}.assembly.installDependencies 必须是布尔值`, 500);
    }
    const registryPackages = parseRegistryPackages(
      value.assembly.registryPackages,
      `${label}.assembly.registryPackages`,
      serviceRoles,
    );
    if (!registryPackages.some((item) => item.name === "phoenix-wing")) {
      throw new DevHubError(
        "INVALID_CONFIG",
        `${label}.assembly.registryPackages 必须冻结 Registry phoenix-wing 的精确版本与 integrity`,
        500,
      );
    }
    assembly = {
      outputRoot,
      roleDirectories,
      packagePath: resolveExistingPath(
        value.assembly.packagePath,
        `${label}.assembly.packagePath`,
        projectRoot,
        "file",
        options,
      ),
      packageSha256,
      packageKind: "pah-business-module",
      moduleId,
      version: packageVersion,
      nodeHost: parseGitInput(value.assembly.nodeHost, `${label}.assembly.nodeHost`, projectRoot, options),
      vueHost: parseGitInput(value.assembly.vueHost, `${label}.assembly.vueHost`, projectRoot, options),
      registryPackages,
      installDependencies: value.assembly.installDependencies === true,
    };
  } else if (value.assembly !== undefined) {
    throw new DevHubError("INVALID_CONFIG", `${label} 的 source-mounted 不允许 assembly`, 500);
  }

  return {
    environmentKind: environmentKind as ServiceProfilePolicy["environmentKind"],
    deploymentMode: deploymentMode as ServiceProfilePolicy["deploymentMode"],
    lifecycleControl,
    database: {
      serviceRole,
      envName,
      name: databaseName,
      forbiddenNames,
      ...(databasePreflight ? { preflight: databasePreflight } : {}),
    },
    ...(assembly ? { assembly } : {}),
  };
}

function parseSourceFragment(value: unknown, label: string): ServiceSourceDefinition {
  assertObject(value, label);
  return cloneJson(value) as ServiceSourceDefinition;
}

function normalizeSeries(
  value: unknown,
  index: number,
  projectRoot: string,
  options: ResolveServiceConfigurationOptions = {},
): ServiceSeriesSource {
  assertObject(value, `series[${index}]`);
  const id = requiredId(value.id, `series[${index}].id`);
  assertObject(value.template, `series ${id}.template`);
  assertObject(value.template.services, `series ${id}.template.services`);
  const templateServices = Object.fromEntries(Object.entries(value.template.services).map(([role, source]) => [
    requiredId(role, `series ${id} service role`),
    parseSourceFragment(source, `series ${id}.template.services.${role}`),
  ]));
  const templateSlot = value.template.runtimeSlot === undefined
    ? undefined
    : requiredId(value.template.runtimeSlot, `series ${id}.template.runtimeSlot`);
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) {
    throw new DevHubError("INVALID_CONFIG", `series ${id} 至少需要一个 profile`, 500);
  }
  const profileIds = new Set<string>();
  const profiles = value.profiles.map((raw, profileIndex): ServiceProfileSource => {
    assertObject(raw, `series ${id}.profiles[${profileIndex}]`);
    const profileId = requiredId(raw.id, `series ${id}.profiles[${profileIndex}].id`);
    if (profileIds.has(profileId)) {
      throw new DevHubError("INVALID_CONFIG", `series ${id} profile ID 重复：${profileId}`, 500);
    }
    profileIds.add(profileId);
    assertObject(raw.services, `series ${id}/profile ${profileId}.services`);
    const services = Object.fromEntries(Object.entries(raw.services).map(([role, source]) => [
      requiredId(role, `series ${id}/profile ${profileId} service role`),
      source === false ? false : parseSourceFragment(source, `series ${id}/profile ${profileId}.services.${role}`),
    ])) as Readonly<Record<string, ServiceSourceDefinition | false>>;
    const runtimeSlot = raw.runtimeSlot === undefined
      ? undefined
      : requiredId(raw.runtimeSlot, `series ${id}/profile ${profileId}.runtimeSlot`);
    const policy = raw.policy === undefined
      ? undefined
      : parseProfilePolicy(
          raw.policy,
          `series ${id}/profile ${profileId}.policy`,
          projectRoot,
          new Set([
            ...Object.keys(templateServices).filter((role) => services[role] !== false),
            ...Object.entries(services).filter(([, source]) => source !== false).map(([role]) => role),
          ]),
          options,
        );
    return {
      id: profileId,
      name: requiredString(raw.name, `series ${id}/profile ${profileId}.name`),
      runtimeSlot,
      metadata: parseMetadata(raw.metadata, `series ${id}/profile ${profileId}.metadata`),
      policy,
      services,
    };
  });
  return {
    id,
    name: requiredString(value.name, `series ${id}.name`),
    template: { runtimeSlot: templateSlot, services: templateServices },
    profiles,
  };
}

export function resolveServiceConfiguration(
  source: ServiceConfigurationFileV2,
  projectRoot: string,
  options: ResolveServiceConfigurationOptions = {},
): readonly ServiceDefinition[] {
  const definitions: ServiceDefinition[] = [];
  const serviceIds = new Set<string>();
  const seriesIds = new Set<string>();
  for (const [seriesIndex, rawSeries] of source.series.entries()) {
    const series = normalizeSeries(rawSeries, seriesIndex, projectRoot, options);
    if (seriesIds.has(series.id)) {
      throw new DevHubError("INVALID_CONFIG", `Series ID 重复：${series.id}`, 500);
    }
    seriesIds.add(series.id);
    for (const profile of series.profiles) {
      const roles = new Set([
        ...Object.keys(series.template.services),
        ...Object.keys(profile.services),
      ]);
      let serviceCount = 0;
      for (const role of roles) {
        const override = profile.services[role];
        if (override === false) continue;
        const merged = mergeServiceSource(series.template.services[role], override ?? {});
        const assembledDirectory = profile.policy?.assembly?.roleDirectories[role];
        const raw = {
          ...merged,
          ...(assembledDirectory
            ? { cwd: path.join(profile.policy!.assembly!.outputRoot, assembledDirectory) }
            : {}),
          moduleId: series.id,
          moduleName: series.name,
        };
        const definition = parseServiceDefinition(raw, projectRoot, {
          allowMissingCwd: Boolean(assembledDirectory) || options.tolerateUnavailablePaths,
        });
        const configurationErrors: string[] = [];
        if (options.tolerateUnavailablePaths && !assembledDirectory) {
          if (!existsSync(definition.cwd) || !statSync(definition.cwd).isDirectory()) {
            configurationErrors.push(`工作目录不存在：${definition.cwd}`);
          }
        }
        const assembly = profile.policy?.assembly;
        if (options.tolerateUnavailablePaths && assembly) {
          if (!existsSync(assembly.packagePath) || !statSync(assembly.packagePath).isFile()) {
            configurationErrors.push(`发布装配包不存在：${assembly.packagePath}`);
          }
          for (const [label, root] of [["Admin Node Host", assembly.nodeHost.root], ["Admin Vue Host", assembly.vueHost.root]] as const) {
            if (!existsSync(root) || !statSync(root).isDirectory()) {
              configurationErrors.push(`${label} 目录不存在：${root}`);
            }
          }
        }
        if (profile.policy?.database.serviceRole === role) {
          const database = profile.policy.database;
          if (definition.command.env?.[database.envName] !== database.name) {
            throw new DevHubError(
              "INVALID_CONFIG",
              `series ${series.id}/profile ${profile.id} 的 ${role} 必须显式固定 ${database.envName}=${database.name}`,
              500,
            );
          }
          if (profile.policy.deploymentMode === "package-assembled" && (
            definition.command.env?.PAH_DB_SYNCHRONIZE !== "false"
            || definition.command.env?.PAH_DB_INITIALIZE !== "false"
          )) {
            throw new DevHubError(
              "INVALID_CONFIG",
              `series ${series.id}/profile ${profile.id} 的发布装配必须关闭数据库 synchronize 与 initialize`,
              500,
            );
          }
        }
        if (serviceIds.has(definition.id)) {
          throw new DevHubError("INVALID_CONFIG", `服务 ID 重复：${definition.id}`, 500);
        }
        serviceIds.add(definition.id);
        serviceCount += 1;
        definitions.push({
          ...definition,
          seriesId: series.id,
          seriesName: series.name,
          profileId: profile.id,
          profileName: profile.name,
          serviceRole: role,
          runtimeSlot: profile.runtimeSlot ?? series.template.runtimeSlot ?? series.id,
          profileMetadata: profile.metadata,
          profilePolicy: profile.policy,
          startOrder: merged.startOrder ?? definition.startOrder ?? 0,
          ...(configurationErrors.length > 0 ? { configurationErrors } : {}),
        });
      }
      if (serviceCount === 0) {
        throw new DevHubError("INVALID_CONFIG", `series ${series.id}/profile ${profile.id} 至少需要一个服务`, 500);
      }
    }
  }
  for (let leftIndex = 0; leftIndex < definitions.length; leftIndex += 1) {
    const left = definitions[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < definitions.length; rightIndex += 1) {
      const right = definitions[rightIndex]!;
      if (left.seriesId !== right.seriesId || left.profileId === right.profileId) continue;
      const leftProfile = `${left.seriesName}/${left.profileName}`;
      const rightProfile = `${right.seriesName}/${right.profileName}`;
      const independent = left.runtimeSlot !== right.runtimeSlot;
      if (independent) {
        const sharedPort = left.endpoints.find((endpoint) => right.endpoints.some((candidate) => candidate.port === endpoint.port));
        if (sharedPort) {
          throw new DevHubError(
            "INVALID_CONFIG",
            `${leftProfile} 与 ${rightProfile} 的并行端口冲突：${sharedPort.port}`,
            500,
          );
        }
        const leftCwd = path.resolve(left.cwd);
        const rightCwd = path.resolve(right.cwd);
        if (leftCwd === rightCwd || leftCwd.startsWith(`${rightCwd}${path.sep}`) || rightCwd.startsWith(`${leftCwd}${path.sep}`)) {
          throw new DevHubError(
            "INVALID_CONFIG",
            `${leftProfile} 与 ${rightProfile} 的并行工作目录冲突：${leftCwd} / ${rightCwd}`,
            500,
          );
        }
      }
      const leftPolicy = left.profilePolicy;
      const rightPolicy = right.profilePolicy;
      if (leftPolicy && rightPolicy && leftPolicy.database.name === rightPolicy.database.name) {
        throw new DevHubError(
          "INVALID_CONFIG",
          `${leftProfile} 与 ${rightProfile} 的数据库冲突：${leftPolicy.database.name}`,
          500,
        );
      }
      if (
        leftPolicy?.assembly?.outputRoot
        && leftPolicy.assembly.outputRoot === rightPolicy?.assembly?.outputRoot
      ) {
        throw new DevHubError(
          "INVALID_CONFIG",
          `${leftProfile} 与 ${rightProfile} 的装配目录冲突：${leftPolicy.assembly.outputRoot}`,
          500,
        );
      }
    }
  }
  return definitions;
}

export function configurationFromDefinitions(
  definitions: readonly ServiceDefinition[],
): ServiceConfigurationFileV2 {
  const grouped = new Map<string, ServiceDefinition[]>();
  for (const definition of definitions) {
    const seriesId = definition.seriesId ?? definition.moduleId;
    grouped.set(seriesId, [...(grouped.get(seriesId) ?? []), definition]);
  }
  return {
    version: 2,
    series: [...grouped.entries()].map(([seriesId, items]) => {
      const profiles = new Map<string, ServiceDefinition[]>();
      for (const item of items) {
        const profileId = item.profileId ?? "default";
        profiles.set(profileId, [...(profiles.get(profileId) ?? []), item]);
      }
      return {
        id: seriesId,
        name: items[0]?.seriesName ?? items[0]?.moduleName ?? seriesId,
        template: {
          runtimeSlot: items[0]?.runtimeSlot ?? seriesId,
          services: {},
        },
        profiles: [...profiles.entries()].map(([profileId, profileItems]) => ({
          id: profileId,
          name: profileItems[0]?.profileName ?? "默认实例",
          metadata: profileItems[0]?.profileMetadata,
          policy: profileItems[0]?.profilePolicy,
          services: Object.fromEntries(profileItems.map((definition) => [
            definition.serviceRole ?? definition.id,
            serviceSourceFromDefinition(definition),
          ])),
        })),
      };
    }),
  };
}

export function serviceSourceFromDefinition(definition: ServiceDefinition): ServiceSourceDefinition {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    cwd: definition.cwd,
    command: {
      executable: definition.command.executable,
      args: [...definition.command.args],
      ...(definition.command.env ? { env: { ...definition.command.env } } : {}),
    },
    endpoints: definition.endpoints.map((endpoint) => ({ ...endpoint })),
    ...(definition.identity ? { identity: cloneJson(definition.identity) } : {}),
    externalStop: definition.externalStop,
    startOrder: definition.startOrder,
  };
}

function convertVersion1(file: ServiceConfigFileV1): ServiceConfigurationFileV2 {
  const definitions = file.services.map((value) => {
    assertObject(value, "version 1 service");
    return value;
  });
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const definition of definitions) {
    const moduleId = requiredId(definition.moduleId, "version 1 service.moduleId");
    groups.set(moduleId, [...(groups.get(moduleId) ?? []), definition]);
  }
  return {
    version: 2,
    series: [...groups.entries()].map(([seriesId, services]) => ({
      id: seriesId,
      name: requiredString(services[0]?.moduleName, `series ${seriesId}.name`),
      template: { runtimeSlot: seriesId, services: {} },
      profiles: [{
        id: "default",
        name: "默认实例",
        services: Object.fromEntries(services.map((service) => {
          const { moduleId: _moduleId, moduleName: _moduleName, ...source } = service;
          return [requiredId(service.id, "version 1 service.id"), source as ServiceSourceDefinition];
        })),
      }],
    })),
  };
}

export function parseServiceConfigurationDocument(
  value: unknown,
  projectRoot: string,
  options: ResolveServiceConfigurationOptions = {},
): LoadedServiceConfiguration {
  assertObject(value, "services.json");
  let source: ServiceConfigurationFileV2;
  if (value.version === 1 && Array.isArray(value.services)) {
    source = convertVersion1(value as unknown as ServiceConfigFileV1);
  } else if (value.version === 2 && Array.isArray(value.series)) {
    source = {
      version: 2,
      series: value.series.map((series, index) => normalizeSeries(series, index, projectRoot, options)),
    };
  } else {
    throw new DevHubError("INVALID_CONFIG", "services.json 必须使用 version=1 services 或 version=2 series", 500);
  }
  return { source, definitions: resolveServiceConfiguration(source, projectRoot, options) };
}

export function resolveServiceConfigurationPath(
  projectRoot: string,
  explicitPath?: string,
): string {
  if (explicitPath) {
    const resolved = path.resolve(projectRoot, explicitPath);
    if (existsSync(resolved)) return resolved;
    throw new DevHubError("INVALID_CONFIG", `服务配置不存在：${resolved}`, 500);
  }
  for (const relativePath of SERVICE_CONFIG_CANDIDATES) {
    const candidate = path.join(projectRoot, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  throw new DevHubError(
    "INVALID_CONFIG",
    "未找到用户服务配置：请复制 config/services.sample.json 为 config/services.user.json 并替换全部示例值",
    500,
  );
}

export function loadServiceConfiguration(
  projectRoot: string,
  explicitPath?: string,
): LoadedServiceConfiguration {
  try {
    const configPath = resolveServiceConfigurationPath(projectRoot, explicitPath);
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    return parseServiceConfigurationDocument(parsed, projectRoot, { tolerateUnavailablePaths: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      source: { version: 2, series: [] },
      definitions: [],
      configurationErrors: [message],
    };
  }
}

export function loadServiceDefinitions(projectRoot: string): readonly ServiceDefinition[] {
  return loadServiceConfiguration(projectRoot).definitions;
}
