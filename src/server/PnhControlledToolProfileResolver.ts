import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import type { ServiceDefinition } from "../shared/contracts.js";

export const PNH_CONTROLLED_TOOL_PROFILE_ENV = "PHOENIX_HUB_CONTROLLED_TOOL_PROFILE";
export const PNH_CONTROLLED_TOOL_PROFILE_SCHEMA_VERSION = 1;
export const PNH_CONTROLLED_TOOL_PROFILE_ID = "pnh.controlled.vitest";
export const PNH_CONTROLLED_TOOL_ID = "vitest";
export const PNH_CONTROLLED_TOOL_VERSION = "3.2.7";
export const PNH_CONTROLLED_TOOL_PACKAGE_HASH_FORMAT = "pnh-package-sha256-v1";
export const PNH_CONTROLLED_TOOL_PROFILE_MAX_BYTES = 16_384;

export type PnhControlledToolUnavailableCode =
  | "HOST_ROOT_UNAVAILABLE"
  | "LOCKFILE_UNAVAILABLE"
  | "LOCKFILE_ESCAPE"
  | "LOCK_IDENTITY_MISMATCH"
  | "LOCK_INTEGRITY_MISSING"
  | "LOCKFILE_SHA_MISMATCH"
  | "PACKAGE_UNAVAILABLE"
  | "PACKAGE_ESCAPE"
  | "PACKAGE_IDENTITY_MISMATCH"
  | "PACKAGE_VERSION_MISMATCH"
  | "ENTRYPOINT_INVALID"
  | "ENTRYPOINT_UNAVAILABLE"
  | "ENTRYPOINT_ESCAPE"
  | "ENTRYPOINT_SHA_MISMATCH"
  | "PACKAGE_CONTENT_INVALID"
  | "PACKAGE_SHA_MISMATCH"
  | "PROFILE_TOO_LARGE"
  | "UNEXPECTED_IO_ERROR";

interface PnhControlledToolProfileBase {
  readonly schemaVersion: typeof PNH_CONTROLLED_TOOL_PROFILE_SCHEMA_VERSION;
  readonly profileId: typeof PNH_CONTROLLED_TOOL_PROFILE_ID;
  readonly toolId: typeof PNH_CONTROLLED_TOOL_ID;
  readonly toolVersion: typeof PNH_CONTROLLED_TOOL_VERSION;
}

export interface PnhAvailableControlledToolProfile extends PnhControlledToolProfileBase {
  readonly availability: "available";
  readonly hostRootRealpath: string;
  readonly packageRootRealpath: string;
  readonly entrypointRealpath: string;
  readonly lockfileRealpath: string;
  readonly lockSpecifier: string;
  readonly lockIntegrity: string;
  readonly lockfileSha256: string;
  readonly entrypointSha256: string;
  readonly packageSha256: string;
  readonly packageHashFormat: typeof PNH_CONTROLLED_TOOL_PACKAGE_HASH_FORMAT;
  readonly packageFileCount: number;
}

export interface PnhUnavailableControlledToolProfile extends PnhControlledToolProfileBase {
  readonly availability: "unavailable";
  readonly unavailableReason: {
    readonly code: PnhControlledToolUnavailableCode;
    readonly message: string;
  };
}

export type PnhControlledToolProfile =
  | PnhAvailableControlledToolProfile
  | PnhUnavailableControlledToolProfile;

interface PnhLockEvidence {
  readonly specifier: string;
  readonly integrity: string;
}

interface PnhPackageHash {
  readonly sha256: string;
  readonly fileCount: number;
}

interface PnhProfileTarget {
  readonly serviceId: string;
  readonly hostRoot: string;
}

class PnhProfileResolutionError extends Error {
  constructor(
    readonly code: PnhControlledToolUnavailableCode,
    message: string,
  ) {
    super(message);
  }
}

function unavailable(
  code: PnhControlledToolUnavailableCode,
  message: string,
): PnhUnavailableControlledToolProfile {
  return {
    schemaVersion: PNH_CONTROLLED_TOOL_PROFILE_SCHEMA_VERSION,
    profileId: PNH_CONTROLLED_TOOL_PROFILE_ID,
    toolId: PNH_CONTROLLED_TOOL_ID,
    toolVersion: PNH_CONTROLLED_TOOL_VERSION,
    availability: "unavailable",
    unavailableReason: { code, message },
  };
}

function fail(code: PnhControlledToolUnavailableCode, message: string): never {
  throw new PnhProfileResolutionError(code, message);
}

function realDirectory(candidate: string, code: PnhControlledToolUnavailableCode, message: string): string {
  try {
    const resolved = realpathSync(candidate);
    if (!lstatSync(resolved).isDirectory()) return fail(code, message);
    return resolved;
  } catch {
    return fail(code, message);
  }
}

function realRegularFile(candidate: string, code: PnhControlledToolUnavailableCode, message: string): string {
  try {
    const resolved = realpathSync(candidate);
    if (!lstatSync(resolved).isFile()) return fail(code, message);
    return resolved;
  } catch {
    return fail(code, message);
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertContained(
  root: string,
  candidate: string,
  code: PnhControlledToolUnavailableCode,
  message: string,
): void {
  if (!contained(root, candidate)) fail(code, message);
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function childBlock(lines: readonly string[], startIndex: number, parentIndent: number): readonly string[] {
  const result: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() && indentation(line) <= parentIndent) break;
    result.push(line);
  }
  return result;
}

function findLine(lines: readonly string[], exactTrimmed: string, indent: number): number {
  return lines.findIndex((line) => indentation(line) === indent && line.trim() === exactTrimmed);
}

function lockEvidence(lockfile: string): PnhLockEvidence {
  const lines = lockfile.split(/\r?\n/);
  const importersIndex = findLine(lines, "importers:", 0);
  if (importersIndex < 0) return fail("LOCK_IDENTITY_MISMATCH", "pnpm lockfile 缺少 importers");
  const importers = childBlock(lines, importersIndex, 0);
  const rootImporterIndex = findLine(importers, ".:", 2);
  if (rootImporterIndex < 0) return fail("LOCK_IDENTITY_MISMATCH", "pnpm lockfile 缺少根 importer");
  const rootImporter = childBlock(importers, rootImporterIndex, 2);
  const toolIndex = findLine(rootImporter, `${PNH_CONTROLLED_TOOL_ID}:`, 6);
  if (toolIndex < 0) return fail("LOCK_IDENTITY_MISMATCH", "根 importer 未锁定受控工具");
  const toolBlock = childBlock(rootImporter, toolIndex, 6);
  const specifierLine = toolBlock.find((line) => indentation(line) === 8 && line.trimStart().startsWith("specifier:"));
  const versionLine = toolBlock.find((line) => indentation(line) === 8 && line.trimStart().startsWith("version:"));
  const specifier = specifierLine?.slice(specifierLine.indexOf(":") + 1).trim();
  const lockedVersion = versionLine?.slice(versionLine.indexOf(":") + 1).trim();
  if (!specifier || !lockedVersion || !(
    lockedVersion === PNH_CONTROLLED_TOOL_VERSION
    || lockedVersion.startsWith(`${PNH_CONTROLLED_TOOL_VERSION}(`)
  )) {
    return fail("LOCK_IDENTITY_MISMATCH", "根 importer 的受控工具版本不匹配");
  }

  const packagesIndex = findLine(lines, "packages:", 0);
  if (packagesIndex < 0) return fail("LOCK_IDENTITY_MISMATCH", "pnpm lockfile 缺少 packages");
  const packages = childBlock(lines, packagesIndex, 0);
  const packageHeader = `${PNH_CONTROLLED_TOOL_ID}@${PNH_CONTROLLED_TOOL_VERSION}:`;
  const packageIndex = packages.findIndex((line) => {
    if (indentation(line) !== 2) return false;
    const trimmed = line.trim();
    if (!trimmed.endsWith(":")) return false;
    const key = trimmed.slice(0, -1).replace(/^['"]|['"]$/g, "");
    return `${key}:` === packageHeader;
  });
  if (packageIndex < 0) return fail("LOCK_IDENTITY_MISMATCH", "pnpm lockfile 缺少受控工具 package 记录");
  const packageBlock = childBlock(packages, packageIndex, 2);
  const resolution = packageBlock.find((line) => indentation(line) === 4 && line.trimStart().startsWith("resolution:"));
  const integrity = resolution?.match(/integrity:\s*([^,}\s]+)/)?.[1];
  if (!integrity || !/^sha512-[A-Za-z0-9+/=]+$/.test(integrity)) {
    return fail("LOCK_INTEGRITY_MISSING", "受控工具缺少有效的 sha512 lock integrity");
  }
  return { specifier, integrity };
}

function packageHash(packageRoot: string): PnhPackageHash {
  const files: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        return fail("PACKAGE_CONTENT_INVALID", "受控工具 package 内含不允许的 symlink");
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else return fail("PACKAGE_CONTENT_INVALID", "受控工具 package 内含非普通文件");
    }
  };
  visit(packageRoot);
  const hash = createHash("sha256");
  for (const file of files) {
    const relative = path.relative(packageRoot, file).split(path.sep).join("/");
    const content = readFileSync(file);
    hash.update(Buffer.from(relative, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(content);
    hash.update(Buffer.from([0]));
  }
  return { sha256: hash.digest("hex"), fileCount: files.length };
}

function manifestAt(packageRoot: string): { readonly name: unknown; readonly version: unknown; readonly bin: unknown } {
  try {
    return JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      readonly name: unknown;
      readonly version: unknown;
      readonly bin: unknown;
    };
  } catch {
    return fail("PACKAGE_IDENTITY_MISMATCH", "受控工具 package.json 无法读取");
  }
}

function entrypointRelative(manifest: ReturnType<typeof manifestAt>): string {
  const entry = typeof manifest.bin === "string"
    ? manifest.bin
    : manifest.bin && typeof manifest.bin === "object" && !Array.isArray(manifest.bin)
      ? (manifest.bin as Record<string, unknown>)[PNH_CONTROLLED_TOOL_ID]
      : undefined;
  if (
    typeof entry !== "string"
    || !entry.trim()
    || path.isAbsolute(entry)
    || entry.split(/[\\/]/).includes("..")
  ) {
    return fail("ENTRYPOINT_INVALID", "受控工具未声明安全的相对 CLI entrypoint");
  }
  return entry;
}

function profileFailure(error: unknown): PnhUnavailableControlledToolProfile {
  if (error instanceof PnhProfileResolutionError) return unavailable(error.code, error.message);
  return unavailable("UNEXPECTED_IO_ERROR", "读取受控工具时发生未预期的本机 I/O 错误");
}

/** 只从明确的 Host root 读取 lock 与已安装 package；不搜索 PATH，不执行命令，不访问网络。 */
export class PnhControlledToolProfileResolver {
  resolve(hostRootInput: string): PnhControlledToolProfile {
    try {
      const hostRootRealpath = realDirectory(
        hostRootInput,
        "HOST_ROOT_UNAVAILABLE",
        "Admin Web root 不存在或不是目录",
      );
      const lockfileRealpath = realRegularFile(
        path.join(hostRootRealpath, "pnpm-lock.yaml"),
        "LOCKFILE_UNAVAILABLE",
        "Admin Web root 缺少可读 pnpm-lock.yaml",
      );
      assertContained(hostRootRealpath, lockfileRealpath, "LOCKFILE_ESCAPE", "pnpm lockfile 越出 Admin Web root");
      const lockfileBytes = readFileSync(lockfileRealpath);
      const lockfile = lockfileBytes.toString("utf8");
      const lock = lockEvidence(lockfile);
      const packageRootRealpath = realDirectory(
        path.join(hostRootRealpath, "node_modules", PNH_CONTROLLED_TOOL_ID),
        "PACKAGE_UNAVAILABLE",
        "Admin Web root 未安装受控工具 package",
      );
      assertContained(hostRootRealpath, packageRootRealpath, "PACKAGE_ESCAPE", "受控工具 package 越出 Admin Web root");
      const manifest = manifestAt(packageRootRealpath);
      if (manifest.name !== PNH_CONTROLLED_TOOL_ID) {
        return fail("PACKAGE_IDENTITY_MISMATCH", "受控工具 package identity 不匹配");
      }
      if (manifest.version !== PNH_CONTROLLED_TOOL_VERSION) {
        return fail("PACKAGE_VERSION_MISMATCH", "受控工具 package 版本不是锁定版本");
      }
      const entrypointRealpath = realRegularFile(
        path.resolve(packageRootRealpath, entrypointRelative(manifest)),
        "ENTRYPOINT_UNAVAILABLE",
        "受控工具 CLI entrypoint 不存在或不是文件",
      );
      assertContained(
        packageRootRealpath,
        entrypointRealpath,
        "ENTRYPOINT_ESCAPE",
        "受控工具 CLI entrypoint 越出 package root",
      );
      const contentHash = packageHash(packageRootRealpath);
      const profile: PnhAvailableControlledToolProfile = {
        schemaVersion: PNH_CONTROLLED_TOOL_PROFILE_SCHEMA_VERSION,
        profileId: PNH_CONTROLLED_TOOL_PROFILE_ID,
        toolId: PNH_CONTROLLED_TOOL_ID,
        toolVersion: PNH_CONTROLLED_TOOL_VERSION,
        availability: "available",
        hostRootRealpath,
        packageRootRealpath,
        entrypointRealpath,
        lockfileRealpath,
        lockSpecifier: lock.specifier,
        lockIntegrity: lock.integrity,
        lockfileSha256: sha256(lockfileBytes),
        entrypointSha256: sha256(readFileSync(entrypointRealpath)),
        packageSha256: contentHash.sha256,
        packageHashFormat: PNH_CONTROLLED_TOOL_PACKAGE_HASH_FORMAT,
        packageFileCount: contentHash.fileCount,
      };
      return this.revalidate(profile);
    } catch (error) {
      return profileFailure(error);
    }
  }

  revalidate(profile: PnhAvailableControlledToolProfile): PnhControlledToolProfile {
    try {
      const hostRootRealpath = realDirectory(
        profile.hostRootRealpath,
        "HOST_ROOT_UNAVAILABLE",
        "Admin Web root 不存在或不是目录",
      );
      if (hostRootRealpath !== profile.hostRootRealpath) {
        return fail("HOST_ROOT_UNAVAILABLE", "Admin Web root realpath 已变化");
      }
      const lockfileRealpath = realRegularFile(
        path.join(hostRootRealpath, "pnpm-lock.yaml"),
        "LOCKFILE_UNAVAILABLE",
        "pnpm lockfile 不存在或不是文件",
      );
      assertContained(hostRootRealpath, lockfileRealpath, "LOCKFILE_ESCAPE", "pnpm lockfile 越出 Admin Web root");
      if (lockfileRealpath !== profile.lockfileRealpath) {
        return fail("LOCK_IDENTITY_MISMATCH", "Profile lockfile 不是 Admin Web root 的锁文件");
      }
      const lockfileBytes = readFileSync(lockfileRealpath);
      const lockfile = lockfileBytes.toString("utf8");
      const lock = lockEvidence(lockfile);
      if (lock.specifier !== profile.lockSpecifier || lock.integrity !== profile.lockIntegrity) {
        return fail("LOCK_IDENTITY_MISMATCH", "受控工具 lock 证据已变化");
      }
      if (sha256(lockfileBytes) !== profile.lockfileSha256) {
        return fail("LOCKFILE_SHA_MISMATCH", "pnpm lockfile SHA-256 与 Profile 不一致");
      }
      const packageRootRealpath = realDirectory(
        path.join(hostRootRealpath, "node_modules", PNH_CONTROLLED_TOOL_ID),
        "PACKAGE_UNAVAILABLE",
        "受控工具 package 不存在或不是目录",
      );
      assertContained(hostRootRealpath, packageRootRealpath, "PACKAGE_ESCAPE", "受控工具 package 越出 Admin Web root");
      if (packageRootRealpath !== profile.packageRootRealpath) {
        return fail("PACKAGE_IDENTITY_MISMATCH", "Profile package 不是 Admin Web root 的锁定工具");
      }
      const manifest = manifestAt(packageRootRealpath);
      if (manifest.name !== PNH_CONTROLLED_TOOL_ID) {
        return fail("PACKAGE_IDENTITY_MISMATCH", "受控工具 package identity 不匹配");
      }
      if (manifest.version !== PNH_CONTROLLED_TOOL_VERSION) {
        return fail("PACKAGE_VERSION_MISMATCH", "受控工具 package 版本不是锁定版本");
      }
      const entrypointRealpath = realRegularFile(
        path.resolve(packageRootRealpath, entrypointRelative(manifest)),
        "ENTRYPOINT_UNAVAILABLE",
        "受控工具 CLI entrypoint 不存在或不是文件",
      );
      assertContained(packageRootRealpath, entrypointRealpath, "ENTRYPOINT_ESCAPE", "受控工具 CLI entrypoint 越出 package root");
      if (entrypointRealpath !== profile.entrypointRealpath) {
        return fail("ENTRYPOINT_INVALID", "Profile entrypoint 与 package.json bin 不一致");
      }
      if (sha256(readFileSync(entrypointRealpath)) !== profile.entrypointSha256) {
        return fail("ENTRYPOINT_SHA_MISMATCH", "受控工具 entrypoint SHA-256 与 Profile 不一致");
      }
      const contentHash = packageHash(packageRootRealpath);
      if (contentHash.fileCount !== profile.packageFileCount || contentHash.sha256 !== profile.packageSha256) {
        return fail("PACKAGE_SHA_MISMATCH", "受控工具 package SHA-256 与 Profile 不一致");
      }
      return profile;
    } catch (error) {
      return profileFailure(error);
    }
  }
}

export function serializePnhControlledToolProfile(profile: PnhControlledToolProfile): string {
  const serialized = JSON.stringify(profile);
  if (Buffer.byteLength(serialized, "utf8") <= PNH_CONTROLLED_TOOL_PROFILE_MAX_BYTES) return serialized;
  return JSON.stringify(unavailable("PROFILE_TOO_LARGE", "受控工具 Profile 超过允许的环境变量大小"));
}

/** 只生成不含路径、哈希或环境内容的运行日志摘要。 */
export function pnhControlledToolProfileLogMessage(serialized: string | undefined): string | undefined {
  if (!serialized) return undefined;
  try {
    const profile = JSON.parse(serialized) as Partial<PnhControlledToolProfile>;
    if (
      profile.schemaVersion !== PNH_CONTROLLED_TOOL_PROFILE_SCHEMA_VERSION
      || profile.profileId !== PNH_CONTROLLED_TOOL_PROFILE_ID
      || profile.toolId !== PNH_CONTROLLED_TOOL_ID
      || profile.toolVersion !== PNH_CONTROLLED_TOOL_VERSION
    ) {
      return "受控测试工具 Profile 格式或身份不可识别";
    }
    if (profile.availability === "available") {
      return `受控测试工具 Profile 可用：${profile.toolId}@${profile.toolVersion}`;
    }
    if (profile.availability === "unavailable" && profile.unavailableReason) {
      return `受控测试工具 Profile 不可用：${profile.unavailableReason.code} · ${profile.unavailableReason.message}`;
    }
    return "受控测试工具 Profile 格式或状态不可识别";
  } catch {
    return "受控测试工具 Profile 不是合法 JSON";
  }
}

/** 将通用工具解析绑定到一个动态服务目标；目标由 Admin 工作区设置提供，不含产品映射。 */
export function createPnhControlledToolRuntimeEnvProvider(
  targetProvider: () => PnhProfileTarget,
  resolver = new PnhControlledToolProfileResolver(),
): (definition: ServiceDefinition) => Readonly<Record<string, string>> {
  return (definition) => {
    const target = targetProvider();
    if (definition.id !== target.serviceId) return {} as Readonly<Record<string, string>>;
    return {
      [PNH_CONTROLLED_TOOL_PROFILE_ENV]: serializePnhControlledToolProfile(
        resolver.resolve(target.hostRoot),
      ),
    };
  };
}
