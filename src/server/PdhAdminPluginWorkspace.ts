import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  AdminPluginCandidate,
  AdminPluginCatalogResponse,
  AdminPluginManifestSummary,
  AdminPluginMountKind,
  AdminPluginMountPath,
  AdminPluginMountState,
  AdminPluginOperationChange,
  AdminPluginOperationResult,
  AdminPluginRegistration,
  AdminPluginStatus,
  AdminPluginWorkspaceSettings,
} from "../shared/contracts.js";
import { DevHubError } from "./errors.js";

interface AdminPluginWorkspaceFile {
  readonly version: 1;
  readonly settings: AdminPluginWorkspaceSettings;
  readonly plugins: readonly AdminPluginRegistration[];
  readonly operations?: Readonly<Record<string, AdminPluginOperationResult>>;
}

interface MountTarget {
  readonly kind: AdminPluginMountKind;
  readonly label: string;
  readonly hostRoot: string;
  readonly source: string;
  readonly target: string;
}

interface ManagedBlockParseResult {
  readonly base: string;
  readonly blocks: readonly (readonly string[])[];
}

const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MIGRATION_PATH_PATTERN = /^migrations\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.sql$/;
const PAH_BUSINESS_GROUP = "pah-group-business";

function windowsNamespacedPath(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

function comparablePath(value: string): string {
  const normalized = path.normalize(windowsNamespacedPath(path.resolve(value)));
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function linkTargetPath(linkPath: string, value: string): string {
  return path.resolve(path.dirname(linkPath), windowsNamespacedPath(value));
}

function samePath(left: string | undefined, right: string): boolean {
  return left !== undefined && comparablePath(left) === comparablePath(right);
}

function createDirectoryLink(source: string, target: string): void {
  symlinkSync(
    process.platform === "win32" ? path.resolve(source) : path.relative(path.dirname(target), source),
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function fail(code: string, message: string, statusCode = 400, details?: unknown): never {
  throw new DevHubError(code, message, statusCode, details);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_ADMIN_PLUGIN", `${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return fail("INVALID_ADMIN_PLUGIN", `${label} 必须是非空字符串`);
  }
  return value.trim();
}

function safeRelative(value: string, label: string): string {
  if (value.includes("\\") || path.isAbsolute(value) || value.split("/").includes("..")) {
    return fail("INVALID_ADMIN_PLUGIN", `${label} 必须是安全的相对路径`);
  }
  return value;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function regularFileContained(root: string, file: string, label: string): string {
  let resolved: string;
  try {
    const current = lstatSync(file);
    if (current.isSymbolicLink() || !current.isFile()) {
      return fail("INVALID_ADMIN_PLUGIN", `${label}必须是插件目录内的普通文件，不能是 symlink：${file}`);
    }
    resolved = realpathSync(file);
  } catch (error) {
    if (error instanceof DevHubError) throw error;
    return fail("ADMIN_PLUGIN_ARTIFACT_NOT_FOUND", `${label}不存在：${file}`);
  }
  if (!contained(root, resolved)) return fail("INVALID_ADMIN_PLUGIN", `${label}越出插件目录：${resolved}`);
  const absoluteFile = path.resolve(file);
  if (!contained(root, absoluteFile)) return fail("INVALID_ADMIN_PLUGIN", `${label}路径越出插件目录：${absoluteFile}`);
  const relativeParts = path.relative(root, absoluteFile).split(path.sep).filter(Boolean);
  let currentPath = root;
  for (const part of relativeParts) {
    currentPath = path.join(currentPath, part);
    if (lstatSync(currentPath).isSymbolicLink()) {
      return fail("INVALID_ADMIN_PLUGIN", `${label}路径不能包含 symlink：${currentPath}`);
    }
  }
  return resolved;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !expected.includes(key));
  if (extras.length > 0) return fail("INVALID_ADMIN_PLUGIN", `${label}包含未知字段：${extras.join("、")}`);
}

function validateArtifacts(file: string, nodeModulePath: string, manifest: AdminPluginManifestSummary): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return fail("INVALID_ADMIN_PLUGIN", `pah-plugin.artifacts.json 不是合法 JSON：${file}`);
  }
  const root = record(value, "pah-plugin.artifacts.json");
  exactKeys(root, ["formatVersion", "moduleId", "version", "runtimeArtifacts"], "pah-plugin.artifacts.json");
  if (root.formatVersion !== 1) return fail("INVALID_ADMIN_PLUGIN", "只支持 artifacts formatVersion=1");
  if (text(root.moduleId, "artifacts.moduleId") !== manifest.moduleId) {
    return fail("ADMIN_PLUGIN_ARTIFACTS_ID_MISMATCH", "artifacts.moduleId 与 manifest.moduleId 不一致");
  }
  if (text(root.version, "artifacts.version") !== manifest.version) {
    return fail("ADMIN_PLUGIN_ARTIFACTS_VERSION_MISMATCH", "artifacts.version 与 manifest.version 不一致");
  }
  if (root.runtimeArtifacts === undefined) return;
  if (!Array.isArray(root.runtimeArtifacts)) return fail("INVALID_ADMIN_PLUGIN", "artifacts.runtimeArtifacts 必须是数组");
  const ids = new Set<string>();
  for (const [index, item] of root.runtimeArtifacts.entries()) {
    const artifact = record(item, `artifacts.runtimeArtifacts[${index}]`);
    exactKeys(artifact, ["id", "runtime", "format", "path", "size", "sha256"], `runtimeArtifacts[${index}]`);
    const id = text(artifact.id, `runtimeArtifacts[${index}].id`);
    if (!MODULE_ID_PATTERN.test(id) || ids.has(id)) {
      return fail("INVALID_ADMIN_PLUGIN", `runtime artifact id 不合法或重复：${id}`);
    }
    ids.add(id);
    if (artifact.runtime !== "node" || artifact.format !== "commonjs") {
      return fail("INVALID_ADMIN_PLUGIN", `runtime artifact 仅支持 node/commonjs：${id}`);
    }
    const relative = safeRelative(text(artifact.path, `runtimeArtifacts[${index}].path`), "runtime artifact path");
    const runtimeFile = regularFileContained(nodeModulePath, path.join(nodeModulePath, relative), `runtime artifact ${id}`);
    if (!Number.isSafeInteger(artifact.size) || Number(artifact.size) < 0 || statSync(runtimeFile).size !== artifact.size) {
      return fail("ADMIN_PLUGIN_ARTIFACTS_INTEGRITY_FAILED", `runtime artifact size 不匹配：${id}`);
    }
    const checksum = text(artifact.sha256, `runtimeArtifacts[${index}].sha256`);
    if (!/^[a-f0-9]{64}$/.test(checksum) || sha256(runtimeFile) !== checksum) {
      return fail("ADMIN_PLUGIN_ARTIFACTS_INTEGRITY_FAILED", `runtime artifact SHA-256 不匹配：${id}`);
    }
  }
}

function realDirectory(value: string, label: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(path.resolve(value));
  } catch {
    return fail("DIRECTORY_NOT_FOUND", `${label}不存在：${value}`);
  }
  if (!statSync(resolved).isDirectory()) return fail("NOT_A_DIRECTORY", `${label}不是目录：${resolved}`);
  return resolved;
}

function gitOutput(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
  } catch {
    return fail("NOT_A_GIT_REPOSITORY", `目录不是可识别的 Git 仓库：${cwd}`);
  }
}

function exactGitRoot(directory: string, label: string): string {
  const root = realDirectory(gitOutput(directory, ["rev-parse", "--show-toplevel"]), `${label} Git 根目录`);
  if (root !== realDirectory(directory, label)) {
    return fail("HOST_ROOT_NOT_EXACT", `${label}必须指向仓库根目录；实际 Git 根为 ${root}`);
  }
  return root;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (/^[a-z]/.test(normalized) ? normalized : `plugin-${normalized || "admin"}`)
    .slice(0, 50)
    .replace(/-+$/g, "");
}

function uniqueId(base: string, used: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const id = `${base.slice(0, 64 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(id)) return id;
  }
}

function parseManifest(value: unknown): AdminPluginManifestSummary {
  const root = record(value, "Admin 插件 manifest");
  if (root.formatVersion !== 2) return fail("INVALID_ADMIN_PLUGIN", "只支持 Admin Plugin Manifest formatVersion=2");
  const moduleId = text(root.moduleId, "manifest.moduleId");
  if (!MODULE_ID_PATTERN.test(moduleId)) return fail("INVALID_ADMIN_PLUGIN", `moduleId 不合法：${moduleId}`);
  const entrypoints = record(root.entrypoints, "manifest.entrypoints");
  const web = safeRelative(text(entrypoints.web, "manifest.entrypoints.web"), "Web entrypoint");
  const node = safeRelative(text(entrypoints.node, "manifest.entrypoints.node"), "Node entrypoint");
  if (web !== `vue/${moduleId}/config.ts` || node !== `midway/${moduleId}/config.ts`) {
    return fail(
      "INVALID_ADMIN_PLUGIN",
      `entrypoints 必须归属 moduleId：vue/${moduleId}/config.ts 与 midway/${moduleId}/config.ts`,
    );
  }

  const navigation = record(root.navigation, "manifest.navigation");
  const preferredGroupId = text(navigation.preferredGroupId, "manifest.navigation.preferredGroupId");
  if (!Array.isArray(root.routes) || !Array.isArray(root.migrations)) {
    return fail("INVALID_ADMIN_PLUGIN", "manifest.routes 与 manifest.migrations 必须是数组");
  }
  const routes = root.routes.map((item, index) => {
    const route = record(item, `manifest.routes[${index}]`);
    const routePath = text(route.path, `manifest.routes[${index}].path`);
    if (!routePath.startsWith("/")) return fail("INVALID_ADMIN_PLUGIN", `插件路由必须以 / 开头：${routePath}`);
    return {
      id: text(route.id, `manifest.routes[${index}].id`),
      path: routePath,
      title: text(route.title, `manifest.routes[${index}].title`),
    };
  });
  const migrations = root.migrations.map((item, index) => {
    const migration = record(item, `manifest.migrations[${index}]`);
    const artifact = record(migration.artifact, `manifest.migrations[${index}].artifact`);
    const id = text(migration.id, `manifest.migrations[${index}].id`);
    const version = migration.version;
    const checksum = text(migration.checksum, `manifest.migrations[${index}].checksum`);
    const artifactPath = safeRelative(
      text(artifact.path, `manifest.migrations[${index}].artifact.path`),
      "DDL artifact",
    );
    if (!id.startsWith(`${moduleId}-`)) return fail("INVALID_ADMIN_PLUGIN", `DDL migration ID 越界：${id}`);
    if (!Number.isInteger(version) || Number(version) < 1) return fail("INVALID_ADMIN_PLUGIN", `DDL migration version 不合法：${id}`);
    if (!CHECKSUM_PATTERN.test(checksum)) return fail("INVALID_ADMIN_PLUGIN", `DDL migration checksum 不合法：${id}`);
    if (artifact.format !== "sql" || !MIGRATION_PATH_PATTERN.test(artifactPath)) {
      return fail("INVALID_ADMIN_PLUGIN", `DDL 仅支持安全的 migrations/*.sql 制品：${id}`);
    }
    return {
      id,
      version: Number(version),
      checksum,
      description: text(migration.description, `manifest.migrations[${index}].description`),
      artifact: { format: "sql" as const, path: artifactPath },
    };
  });
  if (new Set(migrations.map((item) => item.id)).size !== migrations.length) {
    return fail("INVALID_ADMIN_PLUGIN", "DDL migration ID 不能重复");
  }
  return {
    formatVersion: 2,
    moduleId,
    name: text(root.name, "manifest.name"),
    version: text(root.version, "manifest.version"),
    publisher: text(root.publisher, "manifest.publisher"),
    activationMode: text(root.activationMode, "manifest.activationMode"),
    routePrefix: text(root.routePrefix, "manifest.routePrefix"),
    entrypoints: { web, node },
    routes,
    preferredGroupId,
    migrations,
  };
}

function parseManagedBlocks(content: string, start: string, end: string): ManagedBlockParseResult {
  const kept: string[] = [];
  const blocks: string[][] = [];
  let block: string[] | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (line === start) {
      if (block) return fail("INVALID_GIT_EXCLUDE", "本机 Git exclude 中存在嵌套的插件 marker", 409);
      block = [];
    } else if (line === end) {
      if (!block) return fail("INVALID_GIT_EXCLUDE", "本机 Git exclude 中存在孤立的插件 marker", 409);
      blocks.push(block);
      block = undefined;
    } else if (block) block.push(line);
    else kept.push(line);
  }
  if (block) return fail("INVALID_GIT_EXCLUDE", "本机 Git exclude 中存在未闭合的插件 marker", 409);
  return { blocks, base: kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() };
}

function readOptionalFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function writeAtomic(file: string, content: string, mode = 0o600): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode });
  renameSync(temporary, file);
}

function assertRealParentContained(hostRoot: string, target: string): void {
  let candidate = path.dirname(target);
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return fail("ADMIN_PLUGIN_TARGET_ESCAPE", `无法定位 Host 目标父目录：${target}`, 409);
    candidate = parent;
  }
  const parent = realDirectory(candidate, "Host 目标现有父目录");
  const relative = path.relative(hostRoot, parent);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return fail("ADMIN_PLUGIN_TARGET_ESCAPE", `Host 目标父目录越出仓库：${parent}`, 409);
  }
}

/** Phoenix Admin 专用的本机插件开发编排；不把插件注册为可启动服务。 */
export class PdhAdminPluginWorkspace {
  readonly #projectRoot: string;
  readonly #configPath: string;
  #settings: AdminPluginWorkspaceSettings;
  #plugins: AdminPluginRegistration[];
  #operations: Record<string, AdminPluginOperationResult>;

  constructor(
    projectRoot: string,
    defaults?: Partial<AdminPluginWorkspaceSettings>,
  ) {
    this.#projectRoot = realDirectory(projectRoot, "Dev Hub 根目录");
    this.#configPath = path.join(this.#projectRoot, ".runtime/admin-plugins.json");
    const siblingRoot = path.dirname(this.#projectRoot);
    const fallback: AdminPluginWorkspaceSettings = {
      adminWebRoot: path.resolve(defaults?.adminWebRoot ?? siblingRoot, defaults?.adminWebRoot ? "" : "phoenix-admin-vue"),
      adminNodeRoot: path.resolve(defaults?.adminNodeRoot ?? siblingRoot, defaults?.adminNodeRoot ? "" : "phoenix-admin-node"),
      adminWebServiceId: defaults?.adminWebServiceId ?? "admin-web",
      adminApiServiceId: defaults?.adminApiServiceId ?? "admin-api",
      ...(defaults?.postgresEnvFile ? { postgresEnvFile: defaults.postgresEnvFile } : {}),
    };
    const loaded = this.#load(fallback);
    this.#settings = loaded.settings;
    this.#plugins = [...loaded.plugins];
    this.#operations = { ...(loaded.operations ?? {}) };
  }

  settings(): AdminPluginWorkspaceSettings {
    return this.#settings;
  }

  updateSettings(value: unknown): AdminPluginWorkspaceSettings {
    const input = record(value, "Admin 插件工作区设置");
    const adminWebRoot = exactGitRoot(text(input.adminWebRoot, "Admin Web 根目录"), "Admin Web 根目录");
    const adminNodeRoot = exactGitRoot(text(input.adminNodeRoot, "Admin Node 根目录"), "Admin Node 根目录");
    const adminWebServiceId = text(input.adminWebServiceId, "Admin Web 服务 ID");
    const adminApiServiceId = text(input.adminApiServiceId, "Admin API 服务 ID");
    if (!MODULE_ID_PATTERN.test(adminWebServiceId) || !MODULE_ID_PATTERN.test(adminApiServiceId)) {
      return fail("INVALID_ADMIN_PLUGIN_SETTINGS", "Admin Host 服务 ID 不合法");
    }
    const postgresEnvFile = typeof input.postgresEnvFile === "string" && input.postgresEnvFile.trim()
      ? path.resolve(input.postgresEnvFile.trim())
      : undefined;
    if (postgresEnvFile && !path.isAbsolute(postgresEnvFile)) {
      return fail("INVALID_ADMIN_PLUGIN_SETTINGS", "PostgreSQL env 文件必须是绝对路径");
    }
    const hostChanged = adminWebRoot !== this.#settings.adminWebRoot
      || adminNodeRoot !== this.#settings.adminNodeRoot
      || adminWebServiceId !== this.#settings.adminWebServiceId
      || adminApiServiceId !== this.#settings.adminApiServiceId;
    if (hostChanged) {
      const mounted = this.#plugins
        .map((plugin) => this.status(plugin.id))
        .filter((plugin) => plugin.mountState !== "unmounted" && plugin.mountState !== "unavailable");
      if (mounted.length) {
        return fail(
          "ADMIN_PLUGIN_HOST_RECONFIGURE_REQUIRES_UNMOUNT",
          "修改 Phoenix Admin 开发 Host 前，必须先对已挂载或冲突的插件执行开发卸载",
          409,
          mounted.map((plugin) => ({
            id: plugin.registration.id,
            moduleId: plugin.identity.moduleId,
            mountState: plugin.mountState,
          })),
        );
      }
    }
    this.#settings = {
      adminWebRoot,
      adminNodeRoot,
      adminWebServiceId,
      adminApiServiceId,
      ...(postgresEnvFile ? { postgresEnvFile } : {}),
    };
    this.#save();
    return this.#settings;
  }

  inspect(directoryInput: string): AdminPluginCandidate {
    const directory = realDirectory(directoryInput, "插件目录");
    const manifestCandidates = [
      path.join(directory, "manifest.json"),
      path.join(directory, "packages/admin-plugin/manifest.json"),
    ];
    const manifestFile = manifestCandidates.find(existsSync);
    if (!manifestFile) {
      return fail(
        "ADMIN_PLUGIN_MANIFEST_NOT_FOUND",
        "所选目录不是 Phoenix Admin 插件：未找到 manifest.json 或 packages/admin-plugin/manifest.json",
      );
    }
    const pluginRoot = realDirectory(path.dirname(manifestFile), "Admin 插件包目录");
    const productRoot = realDirectory(gitOutput(pluginRoot, ["rev-parse", "--show-toplevel"]), "插件产品 Git 根目录");
    let manifestValue: unknown;
    try {
      manifestValue = JSON.parse(readFileSync(manifestFile, "utf8")) as unknown;
    } catch {
      return fail("INVALID_ADMIN_PLUGIN", `Admin 插件 manifest 不是合法 JSON：${manifestFile}`);
    }
    const manifest = parseManifest(manifestValue);
    const webModulePath = realDirectory(path.join(pluginRoot, "vue", manifest.moduleId), "插件 Vue 模块目录");
    const nodeModulePath = realDirectory(path.join(pluginRoot, "midway", manifest.moduleId), "插件 Node 模块目录");
    if (!contained(pluginRoot, webModulePath) || !contained(pluginRoot, nodeModulePath)) {
      return fail("ADMIN_PLUGIN_SOURCE_ESCAPE", "插件 Vue/Node 模块目录不能通过 symlink 越出 admin-plugin 根目录");
    }
    for (const entrypoint of [manifest.entrypoints.web, manifest.entrypoints.node]) {
      regularFileContained(pluginRoot, path.join(pluginRoot, entrypoint), `插件入口 ${entrypoint}`);
    }
    for (const migration of manifest.migrations) {
      const artifactFile = regularFileContained(
        nodeModulePath,
        path.join(nodeModulePath, migration.artifact.path),
        `DDL artifact ${migration.id}`,
      );
      if (`sha256:${sha256(artifactFile)}` !== migration.checksum) {
        return fail("ADMIN_PLUGIN_DDL_CHECKSUM_MISMATCH", `DDL migration 原始字节 SHA-256 不匹配：${migration.id}`);
      }
    }
    const artifacts = path.join(nodeModulePath, "pah-plugin.artifacts.json");
    if (manifest.migrations.length > 0 && !existsSync(artifacts)) {
      return fail("ADMIN_PLUGIN_ARTIFACTS_NOT_FOUND", "包含 DDL 的插件缺少 pah-plugin.artifacts.json，不能进入 dry-run");
    }
    if (existsSync(artifacts)) {
      regularFileContained(nodeModulePath, artifacts, "pah-plugin.artifacts.json");
      validateArtifacts(artifacts, nodeModulePath, manifest);
    }
    const validationWarnings = manifest.preferredGroupId === PAH_BUSINESS_GROUP ? [] : [
      `业务分组当前为 ${manifest.preferredGroupId}；开发组合要求 ${PAH_BUSINESS_GROUP}，请先在产品 manifest 修正`,
    ];
    return {
      productRoot,
      pluginRoot,
      manifestPath: path.relative(productRoot, manifestFile).replaceAll("\\", "/"),
      webModulePath,
      nodeModulePath,
      ...(existsSync(artifacts) ? { artifactsPath: artifacts } : {}),
      sourceCommit: gitOutput(productRoot, ["rev-parse", "HEAD"]),
      configured: this.#plugins.some((plugin) => (
        plugin.productRoot === productRoot && plugin.manifestPath === path.relative(productRoot, manifestFile).replaceAll("\\", "/")
      )),
      mountAllowed: validationWarnings.length === 0,
      validationWarnings,
      manifest,
    };
  }

  add(directory: string): AdminPluginStatus {
    const candidate = this.inspect(directory);
    if (candidate.configured) return fail("ADMIN_PLUGIN_ALREADY_ADDED", "该 Admin 插件目录已经加入列表", 409);
    const id = uniqueId(
      slug(`${candidate.manifest.moduleId}-${candidate.manifest.version}`),
      new Set(this.#plugins.map((plugin) => plugin.id)),
    );
    const registration: AdminPluginRegistration = {
      id,
      productRoot: candidate.productRoot,
      manifestPath: candidate.manifestPath,
      createdAt: new Date().toISOString(),
      moduleId: candidate.manifest.moduleId,
      name: candidate.manifest.name,
      manifestVersion: candidate.manifest.version,
    };
    this.#plugins = [...this.#plugins, registration];
    this.#save();
    return this.status(id);
  }

  remove(id: string): AdminPluginRegistration {
    const current = this.status(id);
    if (current.mountState !== "unmounted") {
      return fail("ADMIN_PLUGIN_STILL_MOUNTED", "请先执行开发卸载，再从列表移除插件", 409, current.mounts);
    }
    this.#plugins = this.#plugins.filter((plugin) => plugin.id !== id);
    delete this.#operations[id];
    this.#save();
    return current.registration;
  }

  catalog(): AdminPluginCatalogResponse {
    return { settings: this.#settings, plugins: this.#plugins.map((plugin) => this.status(plugin.id)) };
  }

  status(id: string): AdminPluginStatus {
    const registration = this.#registration(id);
    let candidate: AdminPluginCandidate;
    try {
      candidate = this.#inspectRegistration(registration);
    } catch (error) {
      const sourceError = error instanceof DevHubError
        ? { code: error.code, message: error.message }
        : { code: "ADMIN_PLUGIN_SOURCE_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) };
      let mounts: readonly AdminPluginMountPath[] = [];
      if (registration.moduleId) {
        try {
          mounts = this.#registrationMountTargets(registration, registration.moduleId)
            .map((target) => this.#inspectMount(registration.moduleId!, target));
        } catch {
          // 旧源与 Host 状态同时不可读时保持空明细，sourceError 仍给出主要恢复入口。
        }
      }
      return {
        registration,
        identity: {
          moduleId: registration.moduleId,
          name: registration.name ?? registration.moduleId ?? registration.id,
          version: registration.manifestVersion,
        },
        sourceState: "unavailable",
        sourceError,
        mountState: mounts.length > 0 ? this.#mountState(mounts) : "unavailable",
        mounts,
        recentOperation: this.#operations[id],
      };
    }
    const mounts = this.#mountTargets(candidate).map((target) => this.#inspectMount(candidate.manifest.moduleId, target));
    return {
      registration,
      identity: {
        moduleId: candidate.manifest.moduleId,
        name: candidate.manifest.name,
        version: candidate.manifest.version,
      },
      sourceState: "available",
      candidate,
      mountState: this.#mountState(mounts),
      mounts,
      recentOperation: this.#operations[id],
    };
  }

  repoint(id: string, directory: string): AdminPluginStatus {
    const registration = this.#registration(id);
    let oldCandidate: AdminPluginCandidate | undefined;
    try { oldCandidate = this.#inspectRegistration(registration); } catch { /* stable snapshot may be sufficient */ }
    const candidate = this.inspect(directory);
    const registeredModuleId = registration.moduleId
      ?? oldCandidate?.manifest.moduleId
      ?? this.#recoverLegacyModuleId(registration, candidate.manifest.moduleId);
    if (!registeredModuleId) {
      return fail(
        "ADMIN_PLUGIN_IDENTITY_UNAVAILABLE",
        "旧登记没有 moduleId 身份快照，且现有 Host 链接不足以证明新目录属于同一模块；Hub 不会根据登记 ID 猜测模块身份",
        409,
      );
    }

    if (candidate.manifest.moduleId !== registeredModuleId) {
      return fail(
        "ADMIN_PLUGIN_MODULE_ID_MISMATCH",
        `拒绝重新指向其他模块：已登记 ${registeredModuleId}，新目录 ${candidate.manifest.moduleId}`,
        409,
      );
    }
    const duplicate = this.#plugins.find((plugin) => (
      plugin.id !== id
      && plugin.productRoot === candidate.productRoot
      && plugin.manifestPath === candidate.manifestPath
    ));
    if (duplicate) {
      return fail(
        "ADMIN_PLUGIN_REPOINT_REGISTRATION_CONFLICT",
        `新目录已由另一条登记 ${duplicate.id} 管理，拒绝形成重复登记`,
        409,
      );
    }
    if (!candidate.mountAllowed) {
      return fail(
        "ADMIN_PLUGIN_POLICY_BLOCKED",
        "新目录已识别，但不符合 Admin 开发组合策略，拒绝重新指向",
        409,
        candidate.validationWarnings,
      );
    }

    const oldTargets = oldCandidate
      ? this.#mountTargets(oldCandidate)
      : this.#registrationMountTargets(registration, registeredModuleId);
    const newTargets = this.#mountTargets(candidate);
    const originals = newTargets.map((target) => {
      const oldTarget = oldTargets.find((item) => item.kind === target.kind)!;
      const link = this.#rawLinkState(target.target);
      const actual = link.value === undefined ? undefined : linkTargetPath(target.target, link.value);
      const linkOwner = link.state === "missing"
        ? "missing"
        : link.state === "occupied"
          ? "occupied"
          : samePath(actual, target.source)
            ? "new"
            : samePath(actual, oldTarget.source)
              ? "old"
              : "foreign";
      const excludePath = this.#gitPath(target.hostRoot, "info/exclude");
      return { target, oldTarget, link, linkOwner, excludePath, excludeContent: readOptionalFile(excludePath) };
    });

    for (const entry of originals) {
      if (entry.linkOwner === "occupied" || entry.linkOwner === "foreign") {
        return fail(
          "ADMIN_PLUGIN_REPOINT_CONFLICT",
          entry.linkOwner === "occupied"
            ? `拒绝覆盖 Host 实体目录/文件：${entry.target.target}`
            : `现有链接既不指向旧目录也不指向本次新目录，拒绝认领：${entry.target.target}`,
          409,
          { currentLink: entry.link.value, oldSource: entry.oldTarget.source, newSource: entry.target.source },
        );
      }
      const parsed = this.#parseExclude(registeredModuleId, entry.excludeContent);
      const pattern = this.#excludePattern(entry.target);
      if (parsed.blocks.length > 1 || (
        parsed.blocks.length === 1
        && (parsed.blocks[0]?.length !== 1 || parsed.blocks[0]?.[0] !== pattern)
      )) {
        return fail("INVALID_GIT_EXCLUDE", `Host Git exclude 的插件 marker 不受控：${entry.excludePath}`, 409);
      }
    }

    const previousPlugins = this.#plugins;
    const previousOperation = this.#operations[id];
    const mutatedLinks = new Set<string>();
    const changes: AdminPluginOperationChange[] = [];
    try {
      for (const entry of originals) {
        const currentLink = this.#rawLinkState(entry.target.target);
        if (currentLink.state !== entry.link.state || currentLink.value !== entry.link.value) {
          return fail(
            "ADMIN_PLUGIN_REPOINT_RACE",
            `预检后 Host 链接发生变化，已停止且未覆盖：${entry.target.target}`,
            409,
          );
        }
        if (entry.linkOwner === "old" && entry.oldTarget.source !== entry.target.source) {
          mutatedLinks.add(entry.target.target);
          unlinkSync(entry.target.target);
          createDirectoryLink(entry.target.source, entry.target.target);
          changes.push({ kind: entry.target.kind, action: "replaced-link", path: entry.target.target, detail: `${entry.oldTarget.source} → ${entry.target.source}` });
        } else if (entry.linkOwner === "missing") {
          mkdirSync(path.dirname(entry.target.target), { recursive: true });
          mutatedLinks.add(entry.target.target);
          createDirectoryLink(entry.target.source, entry.target.target);
          changes.push({ kind: entry.target.kind, action: "created-link", path: entry.target.target, detail: `→ ${entry.target.source}` });
        } else {
          changes.push({ kind: entry.target.kind, action: "claimed-link", path: entry.target.target, detail: `已校验并认领现有链接 → ${entry.target.source}` });
        }
        const excludeChanged = this.#writeExclude(
          registeredModuleId,
          entry.target,
          entry.excludePath,
          entry.excludeContent,
          true,
        );
        changes.push({
          kind: entry.target.kind,
          action: excludeChanged ? "added-exclude" : "unchanged",
          path: entry.excludePath,
          detail: excludeChanged ? this.#excludePattern(entry.target) : "Git 本机排除已经受控",
        });
      }
      const updated: AdminPluginRegistration = {
        ...registration,
        productRoot: candidate.productRoot,
        manifestPath: candidate.manifestPath,
        moduleId: candidate.manifest.moduleId,
        name: candidate.manifest.name,
        manifestVersion: candidate.manifest.version,
        updatedAt: new Date().toISOString(),
      };
      this.#plugins = this.#plugins.map((plugin) => plugin.id === id ? updated : plugin);
      this.#operations[id] = { action: "repoint", completedAt: new Date().toISOString(), changes };
      this.#save();
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const entry of [...originals].reverse()) {
        try {
          if (mutatedLinks.has(entry.target.target)) {
            const current = this.#rawLinkState(entry.target.target);
            const currentActual = current.value === undefined ? undefined : linkTargetPath(entry.target.target, current.value);
            if (current.state === "occupied" || (current.state === "link" && !samePath(currentActual, entry.target.source))) {
              throw new Error(`目标已被并发改动：${entry.target.target}`);
            }
            if (current.state === "link") unlinkSync(entry.target.target);
            if (entry.link.state === "link" && entry.link.value !== undefined) {
              createDirectoryLink(linkTargetPath(entry.target.target, entry.link.value), entry.target.target);
            }
          }
          writeAtomic(entry.excludePath, entry.excludeContent);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
        }
      }
      this.#plugins = previousPlugins;
      if (previousOperation) this.#operations[id] = previousOperation;
      else delete this.#operations[id];
      try { this.#save(); } catch (rollbackError) {
        rollbackErrors.push(`登记恢复失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      if (rollbackErrors.length > 0) {
        return fail(
          "ADMIN_PLUGIN_REPOINT_ROLLBACK_FAILED",
          `重新指向失败，且自动回滚未完整完成；请停止 Admin Host，核对两端 src/modules/${registeredModuleId} 链接、.git/info/exclude 与 .runtime/admin-plugins.json（API details 含具体失败项）`,
          500,
          { originalError: error instanceof Error ? error.message : String(error), rollbackErrors },
        );
      }
      throw error;
    }
    return this.status(id);
  }

  /**
   * 早期登记没有保存 moduleId。只有 Host 中至少一个旧链接仍精确指向该登记的旧源码，
   * 且 Vue/Node 两端 Git exclude marker 都与候选 moduleId 完全一致时，才允许恢复身份。
   */
  #recoverLegacyModuleId(registration: AdminPluginRegistration, candidateModuleId: string): string | undefined {
    const targets = this.#registrationMountTargets(registration, candidateModuleId);
    let ownedLinkCount = 0;
    for (const target of targets) {
      const link = this.#rawLinkState(target.target);
      if (link.state === "occupied") return undefined;
      if (link.state === "link") {
        const actual = path.resolve(path.dirname(target.target), link.value!);
        if (actual !== target.source) return undefined;
        ownedLinkCount += 1;
      }
      const excludePath = this.#gitPath(target.hostRoot, "info/exclude");
      const parsed = this.#parseExclude(candidateModuleId, readOptionalFile(excludePath));
      if (
        parsed.blocks.length !== 1
        || parsed.blocks[0]?.length !== 1
        || parsed.blocks[0]?.[0] !== this.#excludePattern(target)
      ) return undefined;
    }
    return ownedLinkCount > 0 ? candidateModuleId : undefined;
  }

  mount(id: string): AdminPluginStatus {
    return this.#changeMount(id, "mount");
  }

  unmount(id: string): AdminPluginStatus {
    return this.#changeMount(id, "unmount");
  }

  #changeMount(id: string, action: "mount" | "unmount"): AdminPluginStatus {
    const before = this.status(id);
    if (!before.candidate) {
      return fail(
        "ADMIN_PLUGIN_SOURCE_UNAVAILABLE",
        `已登记插件目录不可用，不能执行开发${action === "mount" ? "挂载" : "卸载"}；请先重新指向有效 worktree`,
        409,
        before.sourceError,
      );
    }
    if (action === "mount" && !before.candidate.mountAllowed) {
      return fail(
        "ADMIN_PLUGIN_POLICY_BLOCKED",
        "插件已识别，但尚不符合 Admin 开发组合策略，拒绝挂载",
        409,
        before.candidate.validationWarnings,
      );
    }
    const targets = this.#mountTargets(before.candidate);
    const originals = targets.map((target) => ({
      target,
      link: this.#linkState(target),
      excludePath: this.#gitPath(target.hostRoot, "info/exclude"),
    })).map((entry) => ({ ...entry, excludeContent: readOptionalFile(entry.excludePath) }));

    for (const entry of originals) {
      const state = entry.link.state;
      if (state === "occupied" || state === "foreign-link") {
        return fail(
          "ADMIN_PLUGIN_MOUNT_CONFLICT",
          `${action === "mount" ? "拒绝覆盖" : "拒绝删除"}${state === "occupied" ? "实体目录/文件" : "外来链接"}：${entry.target.target}`,
          409,
          before.mounts,
        );
      }
      this.#parseExclude(before.candidate.manifest.moduleId, entry.excludeContent);
      if (action === "mount" && !existsSync(entry.target.source)) {
        return fail("ADMIN_PLUGIN_SOURCE_MISSING", `插件源目录不存在：${entry.target.source}`, 409);
      }
    }

    const changes: AdminPluginOperationChange[] = [];
    const created: string[] = [];
    const removed: MountTarget[] = [];
    try {
      for (const entry of originals) {
        if (action === "mount") {
          if (entry.link.state === "missing") {
            mkdirSync(path.dirname(entry.target.target), { recursive: true });
            createDirectoryLink(entry.target.source, entry.target.target);
            created.push(entry.target.target);
            changes.push({ kind: entry.target.kind, action: "created-link", path: entry.target.target, detail: `→ ${entry.target.source}` });
          } else {
            changes.push({ kind: entry.target.kind, action: "unchanged", path: entry.target.target, detail: "开发链接已经正确挂载" });
          }
          const changed = this.#writeExclude(before.candidate.manifest.moduleId, entry.target, entry.excludePath, entry.excludeContent, true);
          changes.push({
            kind: entry.target.kind,
            action: changed ? "added-exclude" : "unchanged",
            path: entry.excludePath,
            detail: changed ? this.#excludePattern(entry.target) : "Git 本机排除已经存在",
          });
        } else {
          if (entry.link.state === "mounted") {
            unlinkSync(entry.target.target);
            removed.push(entry.target);
            changes.push({ kind: entry.target.kind, action: "removed-link", path: entry.target.target, detail: `原来源 ${entry.target.source}` });
          } else {
            changes.push({ kind: entry.target.kind, action: "unchanged", path: entry.target.target, detail: "开发链接已经不存在" });
          }
          const changed = this.#writeExclude(before.candidate.manifest.moduleId, entry.target, entry.excludePath, entry.excludeContent, false);
          changes.push({
            kind: entry.target.kind,
            action: changed ? "removed-exclude" : "unchanged",
            path: entry.excludePath,
            detail: changed ? this.#excludePattern(entry.target) : "没有对应的 Git 本机排除",
          });
        }
      }
    } catch (error) {
      for (const target of created.reverse()) {
        try { if (lstatSync(target).isSymbolicLink()) unlinkSync(target); } catch { /* best effort rollback */ }
      }
      for (const target of removed.reverse()) {
        try {
          if (!existsSync(target.target)) {
            createDirectoryLink(target.source, target.target);
          }
        } catch { /* best effort rollback */ }
      }
      for (const entry of originals) {
        try { writeAtomic(entry.excludePath, entry.excludeContent); } catch { /* preserve original error */ }
      }
      throw error;
    }
    this.#operations[id] = { action, completedAt: new Date().toISOString(), changes };
    this.#save();
    return this.status(id);
  }

  #mountTargets(candidate: AdminPluginCandidate): readonly MountTarget[] {
    return this.#mountTargetsFor(candidate.manifest.moduleId, candidate.webModulePath, candidate.nodeModulePath);
  }

  #registrationMountTargets(registration: AdminPluginRegistration, moduleId: string): readonly MountTarget[] {
    const pluginRoot = path.dirname(path.join(registration.productRoot, registration.manifestPath));
    return this.#mountTargetsFor(
      moduleId,
      path.resolve(pluginRoot, "vue", moduleId),
      path.resolve(pluginRoot, "midway", moduleId),
    );
  }

  #mountTargetsFor(moduleId: string, webModulePath: string, nodeModulePath: string): readonly MountTarget[] {
    const webRoot = exactGitRoot(this.#settings.adminWebRoot, "Admin Web 根目录");
    const nodeRoot = exactGitRoot(this.#settings.adminNodeRoot, "Admin Node 根目录");
    if ([webModulePath, nodeModulePath].some((source) => contained(webRoot, source) || contained(nodeRoot, source))) {
      return fail("ADMIN_PLUGIN_HOST_SOURCE_CONFLICT", "插件源目录不能位于任一 Admin Host 仓库内", 409);
    }
    const targets: readonly MountTarget[] = [{
      kind: "web",
      label: "Admin Vue",
      hostRoot: webRoot,
      source: webModulePath,
      target: path.join(webRoot, "src/modules", moduleId),
    }, {
      kind: "node",
      label: "Admin Node",
      hostRoot: nodeRoot,
      source: nodeModulePath,
      target: path.join(nodeRoot, "src/modules", moduleId),
    }];
    for (const target of targets) assertRealParentContained(target.hostRoot, target.target);
    return targets;
  }

  #inspectMount(moduleId: string, target: MountTarget): AdminPluginMountPath {
    const link = this.#linkState(target);
    const excludePath = this.#gitPath(target.hostRoot, "info/exclude");
    const pattern = this.#excludePattern(target);
    let excludeState: AdminPluginMountPath["excludeState"] = "missing";
    let detail: string | undefined;
    try {
      const parsed = this.#parseExclude(moduleId, readOptionalFile(excludePath));
      excludeState = parsed.blocks.length === 0
        ? "missing"
        : parsed.blocks.length === 1 && parsed.blocks[0]?.length === 1 && parsed.blocks[0]?.[0] === pattern
          ? "managed"
          : "invalid";
      if (excludeState === "invalid") detail = "插件 marker 存在，但内容或数量不符合受控契约";
    } catch (error) {
      excludeState = "invalid";
      detail = error instanceof Error ? error.message : String(error);
    }
    return {
      kind: target.kind,
      label: target.label,
      source: target.source,
      target: target.target,
      excludePath,
      excludePattern: pattern,
      linkState: link.state,
      excludeState,
      linkValue: link.value,
      detail,
    };
  }

  #mountState(mounts: readonly AdminPluginMountPath[]): AdminPluginMountState {
    if (mounts.some((item) => ["occupied", "foreign-link", "invalid"].includes(item.linkState) || item.excludeState === "invalid")) {
      return "conflict";
    }
    if (mounts.every((item) => item.linkState === "mounted" && item.excludeState === "managed")) return "mounted";
    if (mounts.every((item) => item.linkState === "missing" && item.excludeState === "missing")) return "unmounted";
    return "partial";
  }

  #linkState(target: MountTarget): { state: AdminPluginMountPath["linkState"]; value?: string } {
    const current = this.#rawLinkState(target.target);
    if (current.state === "missing") return { state: "missing" };
    if (current.state === "occupied") return { state: "occupied" };
    const value = current.value!;
    const actual = linkTargetPath(target.target, value);
    return samePath(actual, target.source) ? { state: "mounted", value } : { state: "foreign-link", value };
  }

  #rawLinkState(target: string): { state: "missing" | "occupied" | "link"; value?: string } {
    let current;
    try {
      current = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
      throw error;
    }
    if (!current.isSymbolicLink()) return { state: "occupied" };
    return { state: "link", value: readlinkSync(target) };
  }

  #gitPath(hostRoot: string, name: string): string {
    exactGitRoot(hostRoot, "Admin Host 根目录");
    const value = gitOutput(hostRoot, ["rev-parse", "--git-path", name]);
    return path.isAbsolute(value) ? value : path.resolve(hostRoot, value);
  }

  #markers(moduleId: string): { start: string; end: string } {
    return {
      start: `# >>> ${moduleId} admin-plugin dev mount >>>`,
      end: `# <<< ${moduleId} admin-plugin dev mount <<<`,
    };
  }

  #parseExclude(moduleId: string, content: string): ManagedBlockParseResult {
    const marker = this.#markers(moduleId);
    return parseManagedBlocks(content, marker.start, marker.end);
  }

  #excludePattern(target: MountTarget): string {
    return `/${path.relative(target.hostRoot, target.target).replaceAll("\\", "/")}`;
  }

  #writeExclude(
    moduleId: string,
    target: MountTarget,
    excludePath: string,
    content: string,
    enabled: boolean,
  ): boolean {
    const marker = this.#markers(moduleId);
    const parsed = parseManagedBlocks(content, marker.start, marker.end);
    const pattern = this.#excludePattern(target);
    const already = parsed.blocks.length === 1 && parsed.blocks[0]?.length === 1 && parsed.blocks[0]?.[0] === pattern;
    if ((enabled && already) || (!enabled && parsed.blocks.length === 0)) return false;
    const block = `${marker.start}\n${pattern}\n${marker.end}`;
    const next = enabled
      ? `${parsed.base}${parsed.base ? "\n\n" : ""}${block}\n`
      : `${parsed.base}${parsed.base ? "\n" : ""}`;
    writeAtomic(excludePath, next);
    return true;
  }

  #registration(id: string): AdminPluginRegistration {
    const registration = this.#plugins.find((plugin) => plugin.id === id);
    if (!registration) return fail("ADMIN_PLUGIN_NOT_FOUND", `未知 Admin 插件：${id}`, 404);
    return registration;
  }

  #inspectRegistration(registration: AdminPluginRegistration): AdminPluginCandidate {
    const candidate = this.inspect(path.dirname(path.join(registration.productRoot, registration.manifestPath)));
    if (registration.moduleId && registration.moduleId !== candidate.manifest.moduleId) {
      return fail(
        "ADMIN_PLUGIN_REGISTERED_ID_MISMATCH",
        `登记目录的 moduleId 已改变：登记 ${registration.moduleId}，当前 ${candidate.manifest.moduleId}`,
        409,
      );
    }
    return candidate;
  }

  #load(fallback: AdminPluginWorkspaceSettings): AdminPluginWorkspaceFile {
    if (!existsSync(this.#configPath)) return { version: 1, settings: fallback, plugins: [] };
    let root: Record<string, unknown>;
    try {
      root = record(JSON.parse(readFileSync(this.#configPath, "utf8")) as unknown, "Admin 插件本机配置");
    } catch (error) {
      if (error instanceof DevHubError) throw error;
      return fail("INVALID_ADMIN_PLUGIN_CONFIG", "Admin 插件本机配置不是合法 JSON", 500);
    }
    if (root.version !== 1 || !Array.isArray(root.plugins)) {
      return fail("INVALID_ADMIN_PLUGIN_CONFIG", "Admin 插件本机配置必须使用 version=1", 500);
    }
    const settingsValue = record(root.settings, "Admin 插件工作区设置");
    const settings: AdminPluginWorkspaceSettings = {
      adminWebRoot: path.resolve(this.#projectRoot, text(settingsValue.adminWebRoot, "Admin Web 根目录")),
      adminNodeRoot: path.resolve(this.#projectRoot, text(settingsValue.adminNodeRoot, "Admin Node 根目录")),
      adminWebServiceId: text(settingsValue.adminWebServiceId, "Admin Web 服务 ID"),
      adminApiServiceId: text(settingsValue.adminApiServiceId, "Admin API 服务 ID"),
      ...(typeof settingsValue.postgresEnvFile === "string" && settingsValue.postgresEnvFile.trim()
        ? { postgresEnvFile: path.resolve(this.#projectRoot, settingsValue.postgresEnvFile.trim()) }
        : {}),
    };
    const plugins = root.plugins.map((item): AdminPluginRegistration => {
      const plugin = record(item, "Admin 插件登记");
      const id = text(plugin.id, "Admin 插件 id");
      if (!MODULE_ID_PATTERN.test(id)) return fail("INVALID_ADMIN_PLUGIN_CONFIG", `Admin 插件 id 不合法：${id}`, 500);
      if (plugin.moduleId !== undefined && (
        typeof plugin.moduleId !== "string" || !MODULE_ID_PATTERN.test(plugin.moduleId.trim())
      )) {
        return fail("INVALID_ADMIN_PLUGIN_CONFIG", `Admin 插件 moduleId 不合法：${String(plugin.moduleId)}`, 500);
      }
      return {
        id,
        productRoot: path.resolve(this.#projectRoot, text(plugin.productRoot, "Admin 插件 productRoot")),
        manifestPath: safeRelative(text(plugin.manifestPath, "Admin 插件 manifestPath"), "manifestPath"),
        createdAt: text(plugin.createdAt, "Admin 插件 createdAt"),
        ...(typeof plugin.moduleId === "string" && plugin.moduleId.trim()
          ? { moduleId: text(plugin.moduleId, "Admin 插件 moduleId") }
          : {}),
        ...(typeof plugin.name === "string" && plugin.name.trim()
          ? { name: text(plugin.name, "Admin 插件 name") }
          : {}),
        ...(typeof plugin.manifestVersion === "string" && plugin.manifestVersion.trim()
          ? { manifestVersion: text(plugin.manifestVersion, "Admin 插件 manifestVersion") }
          : {}),
        ...(typeof plugin.updatedAt === "string" && plugin.updatedAt.trim()
          ? { updatedAt: text(plugin.updatedAt, "Admin 插件 updatedAt") }
          : {}),
      };
    });
    if (new Set(plugins.map((plugin) => plugin.id)).size !== plugins.length) {
      return fail("INVALID_ADMIN_PLUGIN_CONFIG", "Admin 插件本机配置存在重复 ID", 500);
    }
    const operations = root.operations && typeof root.operations === "object" && !Array.isArray(root.operations)
      ? root.operations as Record<string, AdminPluginOperationResult>
      : {};
    return { version: 1, settings, plugins, operations };
  }

  #save(): void {
    const content: AdminPluginWorkspaceFile = {
      version: 1,
      settings: this.#settings,
      plugins: this.#plugins,
      operations: this.#operations,
    };
    writeAtomic(this.#configPath, `${JSON.stringify(content, null, 2)}\n`);
  }
}
