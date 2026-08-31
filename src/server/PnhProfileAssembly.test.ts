import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceDefinition, ServiceProfilePolicy } from "../shared/contracts.js";
import { PnhProfileAssembly } from "./PnhProfileAssembly.js";

const roots: string[] = [];
const wingIntegrity = "sha512-YWJjZA==";

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();
}

function createHost(
  root: string,
  runtime: "node" | "vue",
  localDependency = false,
  trustedHostPolicy = false,
): string {
  mkdirSync(root, { recursive: true });
  const dependencies = runtime === "vue"
    ? { "phoenix-wing": "0.6.2", ...(localDependency ? { local: "file:../local" } : {}) }
    : {};
  const packageJson: Record<string, unknown> = { name: `${runtime}-host`, private: true, dependencies };
  if (trustedHostPolicy) {
    packageJson.pnpm = {
      overrides: { "host-dependency>transitive": "1.2.3" },
      patchedDependencies: { "host-dependency@1.2.3": "patches/host-dependency.patch" },
    };
    mkdirSync(path.join(root, "patches"));
    writeFileSync(path.join(root, "patches/host-dependency.patch"), "tracked host patch\n");
  }
  writeJson(path.join(root, "package.json"), packageJson);
  writeFileSync(path.join(root, "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'",
    ...(trustedHostPolicy ? [
      "overrides:",
      "  host-dependency>transitive: 1.2.3",
      "patchedDependencies:",
      "  host-dependency@1.2.3:",
      "    path: patches/host-dependency.patch",
    ] : []),
    "importers:",
    "  .:",
    "    dependencies:",
    ...(runtime === "vue" ? [
      "      phoenix-wing:",
      "        specifier: 0.6.2",
      "        version: 0.6.2",
    ] : []),
    "packages:",
    ...(runtime === "vue" ? [
      "  phoenix-wing@0.6.2:",
      `    resolution: {integrity: ${wingIntegrity}}`,
    ] : []),
    "",
  ].join("\n"));
  if (runtime === "vue") {
    writeJson(path.join(root, "node_modules/phoenix-wing/package.json"), {
      name: "phoenix-wing",
      version: "0.6.2",
    });
  }
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "-f", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}

function createPackage(
  root: string,
  wingPeer = ">=0.6.2 <0.7.0",
  payloadOverride = false,
): string {
  const stage = path.join(root, "package-stage");
  mkdirSync(stage, { recursive: true });
  const plugin = {
    formatVersion: 1,
    kind: "pah-business-module",
    moduleId: "sample-plugin",
    version: "1.2.3",
    manifest: "manifest.json",
    integrity: "integrity.json",
    source: { commit: "a".repeat(40), dirty: false },
    hostCompatibility: { peerDependencies: { "phoenix-wing": wingPeer } },
    installerCompatibility: { pahBusinessModule: true, coolNativeHook: false },
    payloads: [
      { runtime: "node", source: "payload/node/sample-plugin", target: "src/modules/sample-plugin" },
      { runtime: "vue", source: "payload/vue/sample-plugin", target: "src/modules/sample-plugin" },
    ],
  };
  writeJson(path.join(stage, "plugin.json"), plugin);
  writeJson(path.join(stage, "manifest.json"), { moduleId: "sample-plugin", version: "1.2.3" });
  mkdirSync(path.join(stage, "payload/node/sample-plugin"), { recursive: true });
  mkdirSync(path.join(stage, "payload/vue/sample-plugin"), { recursive: true });
  writeFileSync(path.join(stage, "payload/node/sample-plugin/config.ts"), "export default {}\n", { flag: "wx" });
  writeFileSync(path.join(stage, "payload/vue/sample-plugin/config.ts"), "export default {}\n", { flag: "wx" });
  if (payloadOverride) {
    writeJson(path.join(stage, "payload/node/sample-plugin/package.json"), {
      name: "sample-plugin-payload",
      pnpm: { overrides: { transitive: "1.2.3" } },
    });
  }
  const files = [
    "manifest.json",
    "payload/node/sample-plugin/config.ts",
    ...(payloadOverride ? ["payload/node/sample-plugin/package.json"] : []),
    "payload/vue/sample-plugin/config.ts",
    "plugin.json",
  ];
  writeJson(path.join(stage, "integrity.json"), {
    formatVersion: 1,
    algorithm: "sha256",
    files: files.map((relative) => ({
      path: relative,
      size: readFileSync(path.join(stage, relative)).length,
      sha256: sha256(path.join(stage, relative)),
    })),
  });
  const archive = path.join(root, "sample-plugin.pah.cool");
  const archiveFiles = [...files, "integrity.json"].sort();
  if (process.platform === "win32") {
    const zipArchive = path.join(root, "sample-plugin.zip");
    execFileSync("tar", ["-a", "-cf", zipArchive, ...archiveFiles], { cwd: stage });
    renameSync(zipArchive, archive);
  } else {
    execFileSync("zip", ["-X", "-q", "-D", archive, "-@"], {
      cwd: stage,
      input: `${archiveFiles.join("\n")}\n`,
    });
  }
  return archive;
}

function fixture(
  localDependency = false,
  wingPeer?: string,
  trustedHostPolicy = false,
  payloadOverride = false,
) {
  const root = mkdtempSync(path.join(tmpdir(), "pnh-profile-assembly-"));
  roots.push(root);
  const nodeHost = path.join(root, "node-host");
  const vueHost = path.join(root, "vue-host");
  const nodeCommit = createHost(nodeHost, "node", false, trustedHostPolicy);
  const vueCommit = createHost(vueHost, "vue", localDependency);
  const archive = createPackage(root, wingPeer, payloadOverride);
  const outputRoot = path.join(root, "runtime/assembly");
  const policy: ServiceProfilePolicy = {
    environmentKind: "release-validation",
    deploymentMode: "package-assembled",
    lifecycleControl: true,
    database: { serviceRole: "api", envName: "TEST_DB", name: "release_validation_db" },
    assembly: {
      outputRoot,
      roleDirectories: { api: "node", web: "vue" },
      packagePath: archive,
      packageSha256: sha256(archive),
      packageKind: "pah-business-module",
      moduleId: "sample-plugin",
      version: "1.2.3",
      nodeHost: { root: nodeHost, commit: nodeCommit },
      vueHost: { root: vueHost, commit: vueCommit },
      registryPackages: [{
        serviceRole: "web",
        name: "phoenix-wing",
        version: "0.6.2",
        integrity: wingIntegrity,
      }],
      installDependencies: false,
    },
  };
  const definition = (role: "api" | "web"): ServiceDefinition => ({
    id: `release-${role}`,
    name: `Release ${role}`,
    moduleId: "sample-admin",
    moduleName: "Sample Admin",
    seriesId: "sample-admin",
    seriesName: "Sample Admin",
    profileId: "release-validation",
    profileName: "Release Validation",
    runtimeSlot: "sample-admin-release",
    serviceRole: role,
    profilePolicy: policy,
    cwd: path.join(outputRoot, role === "api" ? "node" : "vue"),
    command: { executable: process.execPath, args: [], env: role === "api" ? { TEST_DB: "release_validation_db" } : {} },
    endpoints: [{ id: role, label: role, port: role === "api" ? 45_201 : 45_202 }],
  });
  return { root, nodeHost, vueHost, archive, outputRoot, policy, definitions: [definition("api"), definition("web")] };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PnhProfileAssembly", () => {
  it("从不可变业务包与 clean Host no-replace 装配，并复核 Registry realpath/evidence", async () => {
    const value = fixture();
    const assembly = new PnhProfileAssembly();
    const evidence = await assembly.prepare(value.definitions);
    expect(evidence).toMatchObject({
      state: "verified",
      databaseName: "release_validation_db",
      wingSource: "registry",
      wingVersion: "0.6.2",
      wingIntegrity,
      lockVerified: true,
    });
    expect(readFileSync(path.join(value.outputRoot, "node/src/modules/sample-plugin/config.ts"), "utf8"))
      .toContain("export default");
    expect(readFileSync(path.join(value.outputRoot, "vue/src/modules/sample-plugin/config.ts"), "utf8"))
      .toContain("export default");
    expect(git(value.nodeHost, ["status", "--short"])).toBe("");
    expect(git(value.vueHost, ["status", "--short"])).toBe("");
    expect(await assembly.prepare(value.definitions)).toMatchObject({ state: "verified" });
    expect(assembly.inspect(value.definitions[0]!)).toMatchObject({ state: "verified" });
  });

  it("允许冻结 Host 根目录已归档的 override/patch，但拒绝插件 payload 注入", async () => {
    const trusted = fixture(false, undefined, true);
    await expect(new PnhProfileAssembly().prepare(trusted.definitions)).resolves.toMatchObject({
      state: "verified",
    });

    const injected = fixture(false, undefined, false, true);
    await expect(new PnhProfileAssembly().prepare(injected.definitions)).rejects.toMatchObject({
      code: "PROFILE_PREFLIGHT_FAILED",
      message: expect.stringContaining("插件或嵌套依赖配置包含 override/resolution"),
    });
    expect(() => readFileSync(path.join(injected.outputRoot, "assembly-evidence.json"))).toThrow();
  });

  it("拒绝本地依赖协议并清理未完成 assembly", async () => {
    const value = fixture(true);
    await expect(new PnhProfileAssembly().prepare(value.definitions)).rejects.toMatchObject({
      code: "PROFILE_PREFLIGHT_FAILED",
      message: expect.stringContaining("本地协议"),
    });
    expect(() => readFileSync(path.join(value.outputRoot, "assembly-evidence.json"))).toThrow();
  });

  it("包 SHA 或既有无证据目录变化时 fail-closed", async () => {
    const value = fixture();
    const mismatchedPolicy: ServiceProfilePolicy = {
      ...value.policy,
      assembly: { ...value.policy.assembly!, packageSha256: "0".repeat(64) },
    };
    const definitions = value.definitions.map((definition) => ({ ...definition, profilePolicy: mismatchedPolicy }));
    await expect(new PnhProfileAssembly().prepare(definitions)).rejects.toMatchObject({
      code: "PROFILE_PREFLIGHT_FAILED",
      message: expect.stringContaining("SHA-256"),
    });
    mkdirSync(value.outputRoot, { recursive: true });
    await expect(new PnhProfileAssembly().prepare(value.definitions)).rejects.toMatchObject({
      code: "PROFILE_PREFLIGHT_FAILED",
      message: expect.stringContaining("缺少 evidence"),
    });
  });

  it("拒绝串库和不满足业务包 Host peer 的 Registry 精确版本", async () => {
    const databaseValue = fixture();
    const crossedDatabase = databaseValue.definitions.map((definition) => definition.serviceRole === "api"
      ? { ...definition, command: { ...definition.command, env: { TEST_DB: "development_db" } } }
      : definition);
    await expect(new PnhProfileAssembly().prepare(crossedDatabase)).rejects.toMatchObject({
      code: "PROFILE_PREFLIGHT_FAILED",
      message: expect.stringContaining("数据库环境变量"),
    });

    const peerValue = fixture(false, ">=0.7.0 <0.8.0");
    await expect(new PnhProfileAssembly().prepare(peerValue.definitions)).rejects.toMatchObject({
      code: "PROFILE_PREFLIGHT_FAILED",
      message: expect.stringContaining("不满足业务包 Host peer"),
    });
  });
});
