import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ServiceDefinition,
  ServiceProfileAssemblyPolicy,
  ServiceProfileEvidence,
  ServiceProfilePolicy,
  ServiceProfileRegistryPackage,
} from "../shared/contracts.js";
import { HubError } from "./errors.js";

interface PackageMetadata {
  readonly kind?: string;
  readonly moduleId?: string;
  readonly version?: string;
  readonly manifest?: string;
  readonly integrity?: string;
  readonly source?: { readonly commit?: string; readonly dirty?: boolean };
  readonly hostCompatibility?: { readonly peerDependencies?: Readonly<Record<string, string>> };
  readonly installerCompatibility?: { readonly pahBusinessModule?: boolean; readonly coolNativeHook?: boolean };
  readonly payloads?: readonly {
    readonly runtime?: string;
    readonly source?: string;
    readonly target?: string;
  }[];
}

interface AssemblyEvidenceDocument {
  readonly formatVersion: 2;
  readonly seriesId: string;
  readonly profileId: string;
  readonly environmentKind: ServiceProfilePolicy["environmentKind"];
  readonly databaseName: string;
  readonly moduleId: string;
  readonly version: string;
  readonly package: { readonly path: string; readonly sha256: string; readonly kind: string; readonly fileCount: number };
  readonly host: { readonly nodeCommit: string; readonly vueCommit: string };
  readonly registryPackages: readonly RegistryEvidence[];
  readonly hostPeers: readonly HostPeerEvidence[];
  readonly sourceCommit?: string;
  readonly assembledAt: string;
}

interface RegistryEvidence {
  readonly serviceRole: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly lockfile: string;
  readonly realpath: string;
}

interface HostPeerEvidence {
  readonly serviceRole: string;
  readonly name: string;
  readonly version: string;
  readonly range: string;
  readonly realpath: string;
}

interface VerifiedPackage {
  readonly extractedRoot: string;
  readonly metadata: PackageMetadata;
  readonly moduleId: string;
  readonly version: string;
  readonly fileCount: number;
}

const FORBIDDEN_PROTOCOL = /(?:^|[\s"'])(?:file|link|workspace):/iu;
const FORBIDDEN_ARCHIVE_PATH = /^(?:src\/index\.js|source\/index\.ts)$/u;
const EVIDENCE_FILE = "assembly-evidence.json";

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `JSON 证据无效：${filePath}`, 409);
  }
}

function safeRelative(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\\")) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `${label} 不是安全相对路径`, 409);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || path.posix.isAbsolute(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `${label} 不是安全相对路径：${value}`, 409);
  }
  return normalized;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function walkFiles(root: string, relative = ""): string[] {
  const current = relative ? path.join(root, relative) : root;
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(root, child);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", `装配输入包含符号链接：${absolute}`, 409);
    }
    if (stat.isDirectory()) files.push(...walkFiles(root, child));
    else if (stat.isFile()) files.push(child.replaceAll("\\", "/"));
    else throw new HubError("PROFILE_PREFLIGHT_FAILED", `装配输入包含特殊文件：${absolute}`, 409);
  }
  return files;
}

function run(command: string, args: readonly string[], cwd?: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim();
        reject(new HubError(
          "PROFILE_PREFLIGHT_FAILED",
          `${path.basename(command)} 执行失败${detail ? `：${detail}` : ""}`,
          409,
        ));
      } else resolve(String(stdout));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function validateGitInput(label: string, root: string, expectedCommit: string): Promise<string> {
  const [commit, dirty] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], root),
    run("git", ["status", "--porcelain", "--untracked-files=all"], root),
  ]);
  const actual = commit.trim();
  if (actual !== expectedCommit) {
    throw new HubError(
      "PROFILE_PREFLIGHT_FAILED",
      `${label} Host commit 不匹配：期望 ${expectedCommit}，实际 ${actual}`,
      409,
    );
  }
  if (dirty.trim()) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `${label} Host 不是 clean worktree：${root}`, 409);
  }
  return actual;
}

async function exportGitSnapshot(root: string, commit: string, output: string): Promise<void> {
  const temporary = mkdtempSync(path.join(tmpdir(), "pnh-host-snapshot-"));
  const archive = path.join(temporary, "host.tar");
  try {
    await run("git", ["archive", "--format=tar", "-o", archive, commit], root);
    mkdirSync(output, { recursive: true });
    await run("tar", ["-xf", archive, "-C", output]);
    walkFiles(output);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function extractAndVerifyPackage(assembly: ServiceProfileAssemblyPolicy): Promise<VerifiedPackage> {
  const actualSha = sha256File(assembly.packagePath);
  if (actualSha !== assembly.packageSha256) {
    throw new HubError(
      "PROFILE_PREFLIGHT_FAILED",
      `业务包 SHA-256 不匹配：期望 ${assembly.packageSha256}，实际 ${actualSha}`,
      409,
    );
  }
  const entries = (process.platform === "win32"
    ? await run("tar", ["-tf", assembly.packagePath])
    : await run("unzip", ["-Z1", assembly.packagePath]))
    .split(/\r?\n/u)
    .filter(Boolean);
  const unique = new Set<string>();
  for (const entry of entries) {
    if (entry.endsWith("/")) continue;
    const safe = safeRelative(entry, "压缩包条目");
    if (unique.has(safe)) throw new HubError("PROFILE_PREFLIGHT_FAILED", `压缩包条目重复：${safe}`, 409);
    unique.add(safe);
  }
  const extractedRoot = mkdtempSync(path.join(tmpdir(), "pnh-business-package-"));
  try {
    if (process.platform === "win32") {
      await run("tar", ["-xf", assembly.packagePath, "-C", extractedRoot]);
    } else {
      await run("unzip", ["-qq", assembly.packagePath, "-d", extractedRoot]);
    }
    const files = walkFiles(extractedRoot).sort();
    if (JSON.stringify(files) !== JSON.stringify([...unique].sort())) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", "压缩包清单与解包文件集合不一致", 409);
    }
    if (files.some((file) => FORBIDDEN_ARCHIVE_PATH.test(file))) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", "Pah 业务模块包不得包含 COOL Hook 入口", 409);
    }
    const metadata = readJson(path.join(extractedRoot, "plugin.json")) as PackageMetadata;
    if (
      metadata.kind !== assembly.packageKind
      || metadata.installerCompatibility?.pahBusinessModule !== true
      || metadata.installerCompatibility?.coolNativeHook !== false
    ) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", "业务包 kind/installerCompatibility 不允许由 Pah 声明式装配", 409);
    }
    if (metadata.source?.dirty !== false || !/^[a-f0-9]{40}$/.test(metadata.source?.commit ?? "")) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", "业务包必须来自 clean、精确 commit", 409);
    }
    const manifestPath = safeRelative(metadata.manifest, "manifest 路径");
    const integrityPath = safeRelative(metadata.integrity, "integrity 路径");
    const manifest = readJson(path.join(extractedRoot, manifestPath));
    if (
      typeof metadata.moduleId !== "string"
      || typeof metadata.version !== "string"
      || manifest.moduleId !== metadata.moduleId
      || manifest.version !== metadata.version
    ) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", "业务包 manifest/module/version 身份不一致", 409);
    }
    if (metadata.moduleId !== assembly.moduleId || metadata.version !== assembly.version) {
      throw new HubError(
        "PROFILE_PREFLIGHT_FAILED",
        `业务包身份与 Profile 冻结值不一致：期望 ${assembly.moduleId}@${assembly.version}，实际 ${metadata.moduleId}@${metadata.version}`,
        409,
      );
    }
    const integrity = readJson(path.join(extractedRoot, integrityPath));
    if (integrity.formatVersion !== 1 || integrity.algorithm !== "sha256" || !Array.isArray(integrity.files)) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", "业务包 integrity.json 格式不合法", 409);
    }
    const expectedFiles = files.filter((file) => file !== integrityPath);
    if (integrity.files.length !== expectedFiles.length) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", "业务包 integrity 文件数量不匹配", 409);
    }
    const declared = new Map<string, { size: number; sha256: string }>();
    for (const raw of integrity.files) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new HubError("PROFILE_PREFLIGHT_FAILED", "业务包 integrity 条目不合法", 409);
      }
      const item = raw as Record<string, unknown>;
      const relative = safeRelative(item.path, "integrity 路径");
      if (
        declared.has(relative)
        || !Number.isSafeInteger(item.size)
        || Number(item.size) < 0
        || typeof item.sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(item.sha256)
      ) {
        throw new HubError("PROFILE_PREFLIGHT_FAILED", `业务包 integrity 条目不合法：${relative}`, 409);
      }
      declared.set(relative, { size: Number(item.size), sha256: item.sha256 });
    }
    for (const relative of expectedFiles) {
      const absolute = path.join(extractedRoot, relative);
      const item = declared.get(relative);
      if (!item || statSync(absolute).size !== item.size || sha256File(absolute) !== item.sha256) {
        throw new HubError("PROFILE_PREFLIGHT_FAILED", `业务包文件完整性不匹配：${relative}`, 409);
      }
    }
    if (!Array.isArray(metadata.payloads) || metadata.payloads.length === 0) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", "业务包缺少 payloads", 409);
    }
    return {
      extractedRoot,
      metadata,
      moduleId: metadata.moduleId,
      version: metadata.version,
      fileCount: files.length,
    };
  } catch (error) {
    rmSync(extractedRoot, { recursive: true, force: true });
    throw error;
  }
}

function dependencySections(packageJson: Record<string, unknown>): Readonly<Record<string, unknown>>[] {
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "resolutions"]
    .map((key) => packageJson[key])
    .filter((value): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
}

function stringLeaves(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value).flatMap(stringLeaves);
}

function assertTrustedHostDependencyPolicy(packageJson: Record<string, unknown>, hostRoot: string): void {
  const pnpm = packageJson.pnpm;
  const pnpmRecord = pnpm && typeof pnpm === "object" && !Array.isArray(pnpm)
    ? pnpm as Record<string, unknown>
    : undefined;
  for (const specifier of [
    packageJson.overrides,
    packageJson.resolutions,
    pnpmRecord?.overrides,
  ].flatMap(stringLeaves)) {
    if (FORBIDDEN_PROTOCOL.test(specifier) || path.isAbsolute(specifier)) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", `Host override/resolution 包含本地路径：${hostRoot}`, 409);
    }
  }
  const patchedDependencies = pnpmRecord?.patchedDependencies;
  if (patchedDependencies === undefined) return;
  if (!patchedDependencies || typeof patchedDependencies !== "object" || Array.isArray(patchedDependencies)) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `Host patchedDependencies 格式无效：${hostRoot}`, 409);
  }
  for (const patchPath of Object.values(patchedDependencies)) {
    if (typeof patchPath !== "string") {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", `Host patch 路径格式无效：${hostRoot}`, 409);
    }
    const relative = safeRelative(patchPath, "Host patch 路径");
    const absolute = path.join(hostRoot, relative);
    if (!isInside(hostRoot, absolute) || !existsSync(absolute) || !lstatSync(absolute).isFile()) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", `Host patch 文件缺失或不是普通文件：${relative}`, 409);
    }
  }
}

function scanDependencyConfiguration(root: string, trustedHostRoots: readonly string[]): void {
  const trustedRoots = new Set(trustedHostRoots.map((item) => path.resolve(item)));
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"].includes(entry.name)) continue;
      const text = readFileSync(absolute, "utf8");
      if (FORBIDDEN_PROTOCOL.test(text)) {
        throw new HubError("PROFILE_PREFLIGHT_FAILED", `依赖配置包含本地协议：${absolute}`, 409);
      }
      if (entry.name === "package.json") {
        const packageJson = readJson(absolute);
        const pnpm = packageJson.pnpm;
        const isTrustedHostRoot = trustedRoots.has(path.resolve(directory));
        if (
          packageJson.overrides !== undefined
          || packageJson.resolutions !== undefined
          || (pnpm && typeof pnpm === "object" && !Array.isArray(pnpm) && (pnpm as Record<string, unknown>).overrides !== undefined)
        ) {
          if (!isTrustedHostRoot) {
            throw new HubError("PROFILE_PREFLIGHT_FAILED", `插件或嵌套依赖配置包含 override/resolution：${absolute}`, 409);
          }
          assertTrustedHostDependencyPolicy(packageJson, directory);
        } else if (isTrustedHostRoot) {
          assertTrustedHostDependencyPolicy(packageJson, directory);
        }
        for (const section of dependencySections(packageJson)) {
          for (const specifier of Object.values(section)) {
            if (typeof specifier === "string" && (FORBIDDEN_PROTOCOL.test(specifier) || path.isAbsolute(specifier))) {
              throw new HubError("PROFILE_PREFLIGHT_FAILED", `依赖配置包含本地路径：${absolute}`, 409);
            }
          }
        }
      } else if (/^\s*(?:overrides|patchedDependencies):/mu.test(text) && !trustedRoots.has(path.resolve(directory))) {
        throw new HubError("PROFILE_PREFLIGHT_FAILED", `插件或嵌套 pnpm 配置包含 override/patch：${absolute}`, 409);
      }
    }
  };
  visit(root);
}

function packagePath(root: string, name: string): string {
  return path.join(root, "node_modules", ...name.split("/"), "package.json");
}

function lockIntegrity(lockfile: string, item: ServiceProfileRegistryPackage): string {
  const text = readFileSync(lockfile, "utf8");
  const escapedName = item.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedVersion = item.version.replaceAll(".", "\\.");
  const match = text.match(new RegExp(
    `^  ['\"]?${escapedName}@${escapedVersion}['\"]?:\\r?\\n(?:    .*\\r?\\n){0,12}?    resolution: \\{integrity: ([^}]+)\\}`,
    "mu",
  ));
  if (!match) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `lockfile 缺少 ${item.name}@${item.version} integrity`, 409);
  }
  return match[1]!.trim();
}

function verifyRegistryPackage(
  assemblyRoot: string,
  roleRoot: string,
  item: ServiceProfileRegistryPackage,
): RegistryEvidence {
  const rootPackage = readJson(path.join(roleRoot, "package.json"));
  const declared = dependencySections(rootPackage)
    .map((section) => section[item.name])
    .find((value) => value !== undefined);
  if (declared !== item.version) {
    throw new HubError(
      "PROFILE_PREFLIGHT_FAILED",
      `${item.serviceRole} 必须精确声明 ${item.name}@${item.version}，实际 ${String(declared)}`,
      409,
    );
  }
  const lockfile = path.join(roleRoot, "pnpm-lock.yaml");
  if (!existsSync(lockfile)) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `${item.serviceRole} 缺少 pnpm-lock.yaml`, 409);
  }
  const actualIntegrity = lockIntegrity(lockfile, item);
  if (actualIntegrity !== item.integrity) {
    throw new HubError(
      "PROFILE_PREFLIGHT_FAILED",
      `${item.name}@${item.version} lock integrity 不匹配`,
      409,
    );
  }
  const manifestPath = packagePath(roleRoot, item.name);
  if (!existsSync(manifestPath)) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `${item.name}@${item.version} 未在 assembly node_modules 解析`, 409);
  }
  const resolvedManifest = realpathSync(manifestPath);
  if (!isInside(realpathSync(assemblyRoot), resolvedManifest)) {
    throw new HubError(
      "PROFILE_PREFLIGHT_FAILED",
      `${item.name} realpath 逃逸 assembly，疑似源码或相邻仓回退：${resolvedManifest}`,
      409,
    );
  }
  const installed = readJson(resolvedManifest);
  if (installed.name !== item.name || installed.version !== item.version) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `${item.name} 实际解析身份不匹配`, 409);
  }
  return {
    serviceRole: item.serviceRole,
    name: item.name,
    version: item.version,
    integrity: item.integrity,
    lockfile,
    realpath: path.dirname(resolvedManifest),
  };
}

function compareVersion(left: string, right: string): number {
  const parse = (value: string) => {
    const match = value.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u);
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] as const;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `无法校验非标准 semver：${left} / ${right}`, 409);
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index]! !== rightParts[index]!) return leftParts[index]! - rightParts[index]!;
  }
  return 0;
}

function satisfiesVersionRange(version: string, range: string): boolean {
  return range.split("||").some((alternative) => alternative.trim().split(/\s+/u).every((clause) => {
    const match = clause.match(/^(>=|<=|>|<|=|\^|~)?(\d+(?:\.\d+){0,2})$/u);
    if (!match) return false;
    const operator = match[1] ?? "=";
    const expected = match[2]!;
    if (["=", "^", "~"].includes(operator) && expected.split(".").length !== 3) return false;
    const compared = compareVersion(version, expected);
    if (operator === ">=") return compared >= 0;
    if (operator === "<=") return compared <= 0;
    if (operator === ">") return compared > 0;
    if (operator === "<") return compared < 0;
    if (operator === "=") return compared === 0;
    const [major, minor, patch] = expected.split(".").map(Number) as [number, number, number];
    if (compared < 0) return false;
    if (operator === "~") return compareVersion(version, `${major}.${minor + 1}.0`) < 0;
    const upper = major > 0
      ? `${major + 1}.0.0`
      : minor > 0
        ? `0.${minor + 1}.0`
        : `0.0.${patch + 1}`;
    return compareVersion(version, upper) < 0;
  }));
}

function verifyHostPeers(
  metadata: PackageMetadata,
  assembly: ServiceProfileAssemblyPolicy,
  assemblyRoot: string,
): readonly HostPeerEvidence[] {
  const peerDependencies = metadata.hostCompatibility?.peerDependencies ?? {};
  const evidence: HostPeerEvidence[] = [];
  for (const [dependency, range] of Object.entries(peerDependencies).sort(([left], [right]) => left.localeCompare(right))) {
    const declaredHosts = Object.entries(assembly.roleDirectories)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([serviceRole, directory]) => {
        const roleRoot = path.join(assemblyRoot, directory);
        const manifest = readJson(path.join(roleRoot, "package.json"));
        const declared = dependencySections(manifest).some((section) => section[dependency] !== undefined);
        return declared ? [{ serviceRole, roleRoot }] : [];
      });
    if (declaredHosts.length === 0) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", `clean Host 缺少业务包 peerDependency：${dependency}`, 409);
    }
    for (const { serviceRole, roleRoot } of declaredHosts) {
      const manifestPath = packagePath(roleRoot, dependency);
      if (!existsSync(manifestPath)) {
        throw new HubError(
          "PROFILE_PREFLIGHT_FAILED",
          `${serviceRole} 声明了业务包 peerDependency，但 assembly node_modules 未解析：${dependency}`,
          409,
        );
      }
      const resolvedManifest = realpathSync(manifestPath);
      if (!isInside(realpathSync(assemblyRoot), resolvedManifest)) {
        throw new HubError(
          "PROFILE_PREFLIGHT_FAILED",
          `${dependency} realpath 逃逸 assembly：${resolvedManifest}`,
          409,
        );
      }
      const installed = readJson(resolvedManifest);
      if (typeof installed.version !== "string" || !satisfiesVersionRange(installed.version, range)) {
        throw new HubError(
          "PROFILE_PREFLIGHT_FAILED",
          `${serviceRole} 实际解析 ${dependency}@${String(installed.version)}，不满足业务包 Host peer：${range}`,
          409,
        );
      }
      evidence.push({
        serviceRole,
        name: dependency,
        version: installed.version,
        range,
        realpath: path.dirname(resolvedManifest),
      });
    }
  }
  return evidence;
}

function verifyPersistedHostPeers(
  assembly: ServiceProfileAssemblyPolicy,
  assemblyRoot: string,
  expected: readonly HostPeerEvidence[],
): void {
  if (!Array.isArray(expected)) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", "assembly evidence 缺少 Host peer 实际版本证据", 409);
  }
  const actual = expected.map((item) => {
    if (
      !item
      || typeof item.serviceRole !== "string"
      || typeof item.name !== "string"
      || typeof item.version !== "string"
      || typeof item.range !== "string"
      || typeof item.realpath !== "string"
    ) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", "assembly Host peer evidence 结构无效", 409);
    }
    const directory = assembly.roleDirectories[item.serviceRole];
    if (!directory) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", `assembly Host peer 引用了未知角色：${item.serviceRole}`, 409);
    }
    const roleRoot = path.join(assemblyRoot, directory);
    const rootManifest = readJson(path.join(roleRoot, "package.json"));
    if (!dependencySections(rootManifest).some((section) => section[item.name] !== undefined)) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", `${item.serviceRole} 不再声明 Host peer：${item.name}`, 409);
    }
    const resolvedManifest = realpathSync(packagePath(roleRoot, item.name));
    if (!isInside(realpathSync(assemblyRoot), resolvedManifest)) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", `${item.name} realpath 逃逸 assembly：${resolvedManifest}`, 409);
    }
    const installed = readJson(resolvedManifest);
    if (
      installed.version !== item.version
      || !satisfiesVersionRange(item.version, item.range)
      || path.dirname(resolvedManifest) !== item.realpath
    ) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", `${item.name} Host peer evidence 已变化`, 409);
    }
    return item;
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", "assembly Host peer evidence 已变化", 409);
  }
}

function verifyDatabasePolicy(
  definitions: readonly ServiceDefinition[],
  policy: ServiceProfilePolicy,
): void {
  const databaseService = definitions.find((item) => item.serviceRole === policy.database.serviceRole);
  if (!databaseService) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `Profile 缺少数据库责任服务：${policy.database.serviceRole}`, 409);
  }
  const actualDatabase = databaseService.command.env?.[policy.database.envName];
  if (actualDatabase !== policy.database.name) {
    throw new HubError(
      "PROFILE_PREFLIGHT_FAILED",
      `数据库环境变量 ${policy.database.envName} 必须为隔离值 ${policy.database.name}，实际 ${String(actualDatabase)}`,
      409,
    );
  }
  if (policy.database.forbiddenNames?.includes(actualDatabase)) {
    throw new HubError("PROFILE_PREFLIGHT_FAILED", `数据库命中 Profile 禁止名单：${actualDatabase}`, 409);
  }
}

function publicEvidence(policy: ServiceProfilePolicy, document?: AssemblyEvidenceDocument): ServiceProfileEvidence {
  if (policy.deploymentMode === "source-mounted") {
    return {
      state: "source-mounted",
      environmentKind: policy.environmentKind,
      deploymentMode: policy.deploymentMode,
      message: "源码挂载 / DEV ONLY；不得作为发布包验收证据",
      databaseName: policy.database.name,
      wingSource: "source",
    };
  }
  if (!document) {
    return {
      state: "unprepared",
      environmentKind: policy.environmentKind,
      deploymentMode: policy.deploymentMode,
      message: "尚未生成或验证独立 package assembly",
      databaseName: policy.database.name,
      packageSha256: policy.assembly?.packageSha256,
      wingSource: "registry",
    };
  }
  const wing = document.registryPackages.find((item) => item.name === "phoenix-wing");
  return {
    state: "verified",
    environmentKind: policy.environmentKind,
    deploymentMode: policy.deploymentMode,
    message: "不可变业务包、clean Host、隔离数据库与 Registry 依赖证据已验证",
    databaseName: document.databaseName,
    packageSha256: document.package.sha256,
    nodeCommit: document.host.nodeCommit,
    vueCommit: document.host.vueCommit,
    wingSource: "registry",
    wingVersion: wing?.version,
    wingIntegrity: wing?.integrity,
    lockVerified: true,
    verifiedAt: document.assembledAt,
  };
}

/** 只负责离线文件装配与启动前证据；不调用 Pah 生命周期、DDL 或数据库工具。 */
export class PnhProfileAssembly {
  inspect(definition: ServiceDefinition): ServiceProfileEvidence | undefined {
    const policy = definition.profilePolicy;
    if (!policy) return undefined;
    if (policy.deploymentMode === "source-mounted") return publicEvidence(policy);
    const evidencePath = path.join(policy.assembly!.outputRoot, EVIDENCE_FILE);
    if (!existsSync(evidencePath)) return publicEvidence(policy);
    try {
      const document = readJson(evidencePath) as unknown as AssemblyEvidenceDocument;
      this.#assertEvidenceIdentity(definition, document);
      if (sha256File(policy.assembly!.packagePath) !== policy.assembly!.packageSha256) {
        throw new HubError("PROFILE_PREFLIGHT_FAILED", "业务包 SHA-256 与 Profile 冻结值不一致", 409);
      }
      const registry = policy.assembly!.registryPackages.map((item) => verifyRegistryPackage(
        policy.assembly!.outputRoot,
        path.join(policy.assembly!.outputRoot, policy.assembly!.roleDirectories[item.serviceRole]!),
        item,
      ));
      if (JSON.stringify(registry) !== JSON.stringify(document.registryPackages)) {
        throw new HubError("PROFILE_PREFLIGHT_FAILED", "assembly Registry 依赖证据已变化", 409);
      }
      verifyPersistedHostPeers(policy.assembly!, policy.assembly!.outputRoot, document.hostPeers);
      return publicEvidence(policy, document);
    } catch (error) {
      return {
        ...publicEvidence(policy),
        state: "invalid",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async prepare(
    definitions: readonly ServiceDefinition[],
    log: (message: string) => void = () => undefined,
  ): Promise<ServiceProfileEvidence | undefined> {
    const definition = definitions[0];
    if (!definition?.profilePolicy) return undefined;
    const policy = definition.profilePolicy;
    verifyDatabasePolicy(definitions, policy);
    if (policy.deploymentMode === "source-mounted") return publicEvidence(policy);
    const assembly = policy.assembly!;
    await Promise.all([
      validateGitInput("Node", assembly.nodeHost.root, assembly.nodeHost.commit),
      validateGitInput("Vue", assembly.vueHost.root, assembly.vueHost.commit),
    ]);
    if (sha256File(assembly.packagePath) !== assembly.packageSha256) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", "业务包 SHA-256 与 Profile 冻结值不一致", 409);
    }
    const evidencePath = path.join(assembly.outputRoot, EVIDENCE_FILE);
    if (existsSync(assembly.outputRoot)) {
      if (!existsSync(evidencePath)) {
        throw new HubError("PROFILE_PREFLIGHT_FAILED", `装配目录已存在但缺少 evidence，拒绝覆盖：${assembly.outputRoot}`, 409);
      }
      const document = readJson(evidencePath) as unknown as AssemblyEvidenceDocument;
      this.#assertEvidenceIdentity(definition, document);
      scanDependencyConfiguration(assembly.outputRoot, Object.values(assembly.roleDirectories).map(
        (directory) => path.join(assembly.outputRoot, directory),
      ));
      const registry = assembly.registryPackages.map((item) => verifyRegistryPackage(
        assembly.outputRoot,
        path.join(assembly.outputRoot, assembly.roleDirectories[item.serviceRole]!),
        item,
      ));
      if (JSON.stringify(registry) !== JSON.stringify(document.registryPackages)) {
        throw new HubError("PROFILE_PREFLIGHT_FAILED", "assembly Registry 依赖证据已变化", 409);
      }
      const verifiedPackage = await extractAndVerifyPackage(assembly);
      try {
        const hostPeers = verifyHostPeers(verifiedPackage.metadata, assembly, assembly.outputRoot);
        if (JSON.stringify(hostPeers) !== JSON.stringify(document.hostPeers)) {
          throw new HubError("PROFILE_PREFLIGHT_FAILED", "assembly Host peer evidence 已变化", 409);
        }
      } finally {
        rmSync(verifiedPackage.extractedRoot, { recursive: true, force: true });
      }
      return publicEvidence(policy, document);
    }

    log(`开始离线装配：${assembly.outputRoot}`);
    mkdirSync(path.dirname(assembly.outputRoot), { recursive: true, mode: 0o700 });
    mkdirSync(assembly.outputRoot, { mode: 0o700 });
    let verifiedPackage: VerifiedPackage | undefined;
    try {
      verifiedPackage = await extractAndVerifyPackage(assembly);
      await Promise.all([
        exportGitSnapshot(assembly.nodeHost.root, assembly.nodeHost.commit, path.join(assembly.outputRoot, "node")),
        exportGitSnapshot(assembly.vueHost.root, assembly.vueHost.commit, path.join(assembly.outputRoot, "vue")),
      ]);
      for (const payload of verifiedPackage.metadata.payloads!) {
        if (payload.runtime !== "node" && payload.runtime !== "vue") {
          throw new HubError("PROFILE_PREFLIGHT_FAILED", `业务包 payload runtime 不支持：${String(payload.runtime)}`, 409);
        }
        const source = path.join(verifiedPackage.extractedRoot, safeRelative(payload.source, "payload source"));
        const target = path.join(assembly.outputRoot, payload.runtime, safeRelative(payload.target, "payload target"));
        if (!isInside(verifiedPackage.extractedRoot, source) || !isInside(path.join(assembly.outputRoot, payload.runtime), target)) {
          throw new HubError("PROFILE_PREFLIGHT_FAILED", "业务包 payload 路径逃逸", 409);
        }
        if (!existsSync(source) || existsSync(target)) {
          throw new HubError("PROFILE_PREFLIGHT_FAILED", `业务包 payload 缺失或目标冲突：${target}`, 409);
        }
        walkFiles(source);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true, force: false });
      }
      scanDependencyConfiguration(assembly.outputRoot, Object.values(assembly.roleDirectories).map(
        (directory) => path.join(assembly.outputRoot, directory),
      ));
      if (assembly.installDependencies) {
        for (const directory of new Set(Object.values(assembly.roleDirectories))) {
          const cwd = path.join(assembly.outputRoot, directory);
          log(`离线物化依赖：${cwd}`);
          await run("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], cwd);
        }
      }
      const registryPackages = assembly.registryPackages.map((item) => verifyRegistryPackage(
        assembly.outputRoot,
        path.join(assembly.outputRoot, assembly.roleDirectories[item.serviceRole]!),
        item,
      ));
      const hostPeers = verifyHostPeers(verifiedPackage.metadata, assembly, assembly.outputRoot);
      const document: AssemblyEvidenceDocument = {
        formatVersion: 2,
        seriesId: definition.seriesId ?? definition.moduleId,
        profileId: definition.profileId ?? "default",
        environmentKind: policy.environmentKind,
        databaseName: policy.database.name,
        moduleId: verifiedPackage.moduleId,
        version: verifiedPackage.version,
        package: {
          path: assembly.packagePath,
          sha256: assembly.packageSha256,
          kind: assembly.packageKind,
          fileCount: verifiedPackage.fileCount,
        },
        host: { nodeCommit: assembly.nodeHost.commit, vueCommit: assembly.vueHost.commit },
        registryPackages,
        hostPeers,
        sourceCommit: verifiedPackage.metadata.source?.commit,
        assembledAt: new Date().toISOString(),
      };
      writeFileSync(evidencePath, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      log("离线装配与 Registry 依赖验证完成");
      return publicEvidence(policy, document);
    } catch (error) {
      rmSync(assembly.outputRoot, { recursive: true, force: true });
      throw error;
    } finally {
      if (verifiedPackage) rmSync(verifiedPackage.extractedRoot, { recursive: true, force: true });
    }
  }

  #assertEvidenceIdentity(definition: ServiceDefinition, document: AssemblyEvidenceDocument): void {
    const policy = definition.profilePolicy!;
    const assembly = policy.assembly!;
    if (
      document.formatVersion !== 2
      || document.seriesId !== (definition.seriesId ?? definition.moduleId)
      || document.profileId !== (definition.profileId ?? "default")
      || document.environmentKind !== policy.environmentKind
      || document.databaseName !== policy.database.name
      || document.package.path !== assembly.packagePath
      || document.package.sha256 !== assembly.packageSha256
      || document.package.kind !== assembly.packageKind
      || document.moduleId !== assembly.moduleId
      || document.version !== assembly.version
      || document.host.nodeCommit !== assembly.nodeHost.commit
      || document.host.vueCommit !== assembly.vueHost.commit
    ) {
      throw new HubError("PROFILE_PREFLIGHT_FAILED", "assembly evidence 与当前 Profile 冻结配置不一致", 409);
    }
  }
}
