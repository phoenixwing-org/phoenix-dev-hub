import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceDefinition } from "../shared/contracts.js";
import {
  createPdhControlledToolRuntimeEnvProvider,
  PDH_CONTROLLED_TOOL_PACKAGE_HASH_FORMAT,
  PDH_CONTROLLED_TOOL_PROFILE_ENV,
  PDH_CONTROLLED_TOOL_PROFILE_ID,
  PdhControlledToolProfileResolver,
  pdhControlledToolProfileLogMessage,
  serializePdhControlledToolProfile,
  type PdhAvailableControlledToolProfile,
} from "./PdhControlledToolProfileResolver.js";

const temporaryRoots: string[] = [];

interface HostFixtureOptions {
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly lockVersion?: string;
  readonly lockIntegrity?: string;
  readonly omitPackage?: boolean;
  readonly packageSymlinkTarget?: string;
  readonly entrypointSymlinkTarget?: string;
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function hostFixture(options: HostFixtureOptions = {}): string {
  const root = temporaryRoot("pdh-controlled-tool-");
  const lockVersion = options.lockVersion ?? "3.2.7";
  const integrity = options.lockIntegrity ?? "sha512-VGVzdEludGVncml0eUZpeHR1cmU=";
  writeFileSync(path.join(root, "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      vitest:",
    "        specifier: ^3.2.7",
    `        version: ${lockVersion}`,
    "",
    "packages:",
    "",
    `  vitest@${lockVersion}:`,
    `    resolution: {integrity: ${integrity}}`,
    "    hasBin: true",
    "",
  ].join("\n"));
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  const packageLink = path.join(root, "node_modules", "vitest");
  if (options.packageSymlinkTarget) {
    symlinkSync(
      options.packageSymlinkTarget,
      packageLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    return root;
  }
  if (options.omitPackage) return root;
  mkdirSync(path.join(packageLink, "dist"), { recursive: true });
  writeFileSync(path.join(packageLink, "package.json"), `${JSON.stringify({
    name: options.packageName ?? "vitest",
    version: options.packageVersion ?? "3.2.7",
    bin: { vitest: "./vitest.mjs" },
  }, null, 2)}\n`);
  if (options.entrypointSymlinkTarget) {
    symlinkSync(options.entrypointSymlinkTarget, path.join(packageLink, "vitest.mjs"), "file");
  } else {
    writeFileSync(path.join(packageLink, "vitest.mjs"), "#!/usr/bin/env node\nimport './dist/cli.js';\n");
  }
  writeFileSync(path.join(packageLink, "dist", "cli.js"), "export const fixture = true;\n");
  return root;
}

function definition(id: string): ServiceDefinition {
  return {
    id,
    name: id,
    moduleId: "controlled-tool-test",
    moduleName: "Controlled Tool Test",
    cwd: process.cwd(),
    command: { executable: process.execPath, args: ["fixture.mjs"] },
    endpoints: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PdhControlledToolProfileResolver", () => {
  it("只从 Host root 解析锁定 Vitest，并生成可复核的 lock 与双 SHA", () => {
    const root = hostFixture();
    const resolver = new PdhControlledToolProfileResolver();
    const profile = resolver.resolve(root);

    expect(profile).toMatchObject({
      schemaVersion: 1,
      profileId: PDH_CONTROLLED_TOOL_PROFILE_ID,
      toolId: "vitest",
      toolVersion: "3.2.7",
      availability: "available",
      packageHashFormat: PDH_CONTROLLED_TOOL_PACKAGE_HASH_FORMAT,
      lockSpecifier: "^3.2.7",
    });
    if (profile.availability !== "available") throw new Error("期望 available Profile");
    expect(profile.hostRootRealpath).toBe(realpathSync(root));
    expect(profile.packageRootRealpath.startsWith(`${realpathSync(root)}${path.sep}`)).toBe(true);
    expect(profile.entrypointRealpath.startsWith(`${profile.packageRootRealpath}${path.sep}`)).toBe(true);
    expect(profile.lockIntegrity).toMatch(/^sha512-/);
    expect(profile.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(profile.entrypointSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(profile.packageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(profile.packageFileCount).toBe(3);
    expect(JSON.parse(serializePdhControlledToolProfile(profile))).toEqual(profile);
    expect(pdhControlledToolProfileLogMessage(serializePdhControlledToolProfile(profile)))
      .toBe("受控测试工具 Profile 可用：vitest@3.2.7");
  });

  it("工具缺失时不搜索 PATH 或调用网络，只返回 unavailable", () => {
    const root = hostFixture({ omitPackage: true });
    const fakePath = temporaryRoot("pdh-fake-path-");
    writeFileSync(path.join(fakePath, "vitest"), "fake path executable\n");
    vi.stubEnv("PATH", fakePath);
    const fetchSpy = vi.fn(() => {
      throw new Error("不得访问网络");
    });
    vi.stubGlobal("fetch", fetchSpy);

    expect(new PdhControlledToolProfileResolver().resolve(root)).toMatchObject({
      availability: "unavailable",
      unavailableReason: { code: "PACKAGE_UNAVAILABLE" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("拒绝 package 与 entrypoint 的 realpath symlink escape", () => {
    const outsidePackage = temporaryRoot("pdh-outside-package-");
    writeFileSync(path.join(outsidePackage, "package.json"), `${JSON.stringify({
      name: "vitest",
      version: "3.2.7",
      bin: { vitest: "./vitest.mjs" },
    })}\n`);
    writeFileSync(path.join(outsidePackage, "vitest.mjs"), "outside\n");
    const packageEscape = hostFixture({ packageSymlinkTarget: outsidePackage });
    expect(new PdhControlledToolProfileResolver().resolve(packageEscape)).toMatchObject({
      availability: "unavailable",
      unavailableReason: { code: "PACKAGE_ESCAPE" },
    });

    // Windows 的文件 symlink 需要开发者模式或管理员权限；目录 junction 已覆盖 realpath 逃逸。
    if (process.platform !== "win32") {
      const outsideEntrypointRoot = temporaryRoot("pdh-outside-entrypoint-");
      const outsideEntrypoint = path.join(outsideEntrypointRoot, "outside.mjs");
      writeFileSync(outsideEntrypoint, "outside\n");
      const entrypointEscape = hostFixture({ entrypointSymlinkTarget: outsideEntrypoint });
      expect(new PdhControlledToolProfileResolver().resolve(entrypointEscape)).toMatchObject({
        availability: "unavailable",
        unavailableReason: { code: "ENTRYPOINT_ESCAPE" },
      });
    }
  });

  it("拒绝 lock identity/integrity 与 package identity/version 错误", () => {
    expect(new PdhControlledToolProfileResolver().resolve(hostFixture({ lockVersion: "3.2.6" })))
      .toMatchObject({ availability: "unavailable", unavailableReason: { code: "LOCK_IDENTITY_MISMATCH" } });
    expect(new PdhControlledToolProfileResolver().resolve(hostFixture({ lockIntegrity: "not-an-integrity" })))
      .toMatchObject({ availability: "unavailable", unavailableReason: { code: "LOCK_INTEGRITY_MISSING" } });
    expect(new PdhControlledToolProfileResolver().resolve(hostFixture({ packageVersion: "3.2.6" })))
      .toMatchObject({ availability: "unavailable", unavailableReason: { code: "PACKAGE_VERSION_MISMATCH" } });
    expect(new PdhControlledToolProfileResolver().resolve(hostFixture({ packageName: "not-vitest" })))
      .toMatchObject({ availability: "unavailable", unavailableReason: { code: "PACKAGE_IDENTITY_MISMATCH" } });
  });

  it("revalidate 对 entrypoint、package 与 lockfile SHA 错误 fail-closed", () => {
    const resolver = new PdhControlledToolProfileResolver();
    const profile = resolver.resolve(hostFixture());
    if (profile.availability !== "available") throw new Error("期望 available Profile");
    expect(resolver.revalidate({ ...profile, entrypointSha256: "0".repeat(64) }))
      .toMatchObject({ availability: "unavailable", unavailableReason: { code: "ENTRYPOINT_SHA_MISMATCH" } });
    expect(resolver.revalidate({ ...profile, packageSha256: "0".repeat(64) }))
      .toMatchObject({ availability: "unavailable", unavailableReason: { code: "PACKAGE_SHA_MISMATCH" } });
    expect(resolver.revalidate({ ...profile, lockfileSha256: "0".repeat(64) }))
      .toMatchObject({ availability: "unavailable", unavailableReason: { code: "LOCKFILE_SHA_MISMATCH" } });
    expect(resolver.revalidate({ ...profile, lockIntegrity: "sha512-V3JvbmdJbnRlZ3JpdHk=" }))
      .toMatchObject({ availability: "unavailable", unavailableReason: { code: "LOCK_IDENTITY_MISMATCH" } });
    expect(resolver.revalidate({ ...profile, packageRootRealpath: profile.hostRootRealpath }))
      .toMatchObject({ availability: "unavailable", unavailableReason: { code: "PACKAGE_IDENTITY_MISMATCH" } });
  });

  it("runtime provider 只对动态目标服务注入 Profile，不含产品映射", () => {
    let root = hostFixture();
    let serviceId = "admin-api-a";
    const provider = createPdhControlledToolRuntimeEnvProvider(() => ({ serviceId, hostRoot: root }));
    expect(provider(definition("other-service"))).toEqual({});
    const first = provider(definition("admin-api-a"));
    expect(JSON.parse(first[PDH_CONTROLLED_TOOL_PROFILE_ENV]!)).toMatchObject({ availability: "available" });
    serviceId = "admin-api-b";
    expect(provider(definition("admin-api-a"))).toEqual({});
    const firstTarget = JSON.parse(provider(definition("admin-api-b"))[PDH_CONTROLLED_TOOL_PROFILE_ENV]!) as PdhAvailableControlledToolProfile;
    root = hostFixture();
    const refreshedTarget = JSON.parse(provider(definition("admin-api-b"))[PDH_CONTROLLED_TOOL_PROFILE_ENV]!) as PdhAvailableControlledToolProfile;
    expect(firstTarget).toMatchObject({ availability: "available" });
    expect(refreshedTarget).toMatchObject({ availability: "available" });
    expect(refreshedTarget.hostRootRealpath).not.toBe(firstTarget.hostRootRealpath);
  });
});
