import path from "node:path";
import type { ServiceDefinition } from "../shared/contracts.js";
import { HubError } from "./errors.js";

const PHOENIX_ADMIN_SERIES_ID = "phoenix-admin";
const RELEASE_VALIDATION_COMMAND = ["dev:plugin-installer"] as const;

type ContractErrorCode = "INVALID_CONFIG" | "PROFILE_SPAWN_CONTRACT_FAILED";

function contractError(code: ContractErrorCode, message: string): never {
  throw new HubError(code, message, code === "INVALID_CONFIG" ? 500 : 409);
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isPhoenixAdminReleaseValidation(definition: ServiceDefinition): boolean {
  return (definition.seriesId ?? definition.moduleId) === PHOENIX_ADMIN_SERIES_ID
    && definition.profilePolicy?.environmentKind === "release-validation";
}

/**
 * Phoenix Admin 发布验收 API 的进程契约。
 *
 * 配置解析和最终 spawn 环境各调用一次：前者拒绝缺失配置，后者阻止父进程或
 * Hub runtime env 覆盖冻结值。该函数不访问文件系统、端口或数据库。
 */
export function assertPhoenixAdminReleaseValidationSpawnContract(
  definition: ServiceDefinition,
  environment: Readonly<Record<string, string | undefined>> = definition.command.env ?? {},
  code: ContractErrorCode = "INVALID_CONFIG",
): void {
  if (!isPhoenixAdminReleaseValidation(definition)) return;
  const policy = definition.profilePolicy!;
  if (policy.deploymentMode !== "package-assembled" || !policy.assembly) {
    contractError(code, `${definition.name} 发布验收只允许 package-assembled`);
  }
  if (definition.serviceRole !== policy.database.serviceRole) return;
  if (policy.database.envName !== "PAH_DB_DATABASE") {
    contractError(code, `${definition.name} 必须使用 PAH_DB_DATABASE 固定隔离数据库`);
  }

  const assembly = policy.assembly;
  const nodeRole = Object.entries(assembly.roleDirectories)
    .find(([, directory]) => directory === "node")?.[0];
  const vueRole = Object.entries(assembly.roleDirectories)
    .find(([, directory]) => directory === "vue")?.[0];
  if (!nodeRole || !vueRole || nodeRole !== policy.database.serviceRole) {
    contractError(code, `${definition.name} 的 package assembly 必须唯一映射 Node/Vue，且数据库责任服务必须是 Node`);
  }

  if (path.basename(definition.command.executable).toLowerCase() !== "pnpm"
    || definition.command.args.length !== RELEASE_VALIDATION_COMMAND.length
    || definition.command.args.some((argument, index) => argument !== RELEASE_VALIDATION_COMMAND[index])) {
    contractError(code, `${definition.name} 必须由 Hub 执行 pnpm dev:plugin-installer；pnpm dev 不能作为发布验收证据`);
  }

  const expected = {
    PAH_DB_DATABASE: policy.database.name,
    PAH_DB_SYNCHRONIZE: "false",
    PAH_DB_INITIALIZE: "false",
    PAH_LOCAL_PACKAGE_MODE: "true",
  } as const;
  for (const [name, value] of Object.entries(expected)) {
    if (environment[name] !== value) {
      contractError(code, `${definition.name} 的 ${name} 必须显式固定为 ${value}`);
    }
  }

  const serverPort = environment.PAH_SERVER_PORT;
  if (!serverPort || !/^\d{1,5}$/.test(serverPort)) {
    contractError(code, `${definition.name} 必须显式设置 PAH_SERVER_PORT；普通 PORT 不能替代`);
  }
  const numericPort = Number(serverPort);
  if (!definition.endpoints.some((endpoint) => endpoint.port === numericPort)) {
    contractError(code, `${definition.name} 的 PAH_SERVER_PORT 必须与受控 endpoint 端口一致`);
  }

  const expectedNodeRoot = path.join(assembly.outputRoot, assembly.roleDirectories[nodeRole]!);
  const expectedVueRoot = path.join(assembly.outputRoot, assembly.roleDirectories[vueRole]!);
  const configuredNodeRoot = environment.PHOENIX_ADMIN_NODE_ROOT;
  const configuredVueRoot = environment.PHOENIX_ADMIN_VUE_ROOT;
  if (!configuredNodeRoot || !samePath(path.resolve(definition.cwd, configuredNodeRoot), expectedNodeRoot)) {
    contractError(code, `${definition.name} 的 PHOENIX_ADMIN_NODE_ROOT 必须指向当前 assembly Node 根`);
  }
  if (!configuredVueRoot || !samePath(path.resolve(definition.cwd, configuredVueRoot), expectedVueRoot)) {
    contractError(code, `${definition.name} 的 PHOENIX_ADMIN_VUE_ROOT 必须指向当前 assembly Vue 根`);
  }
}
