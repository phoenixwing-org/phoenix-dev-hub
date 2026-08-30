import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceDefinition } from "../shared/contracts.js";
import { configurationFromDefinitions, loadServiceConfiguration, resolveServiceConfiguration } from "./config.js";
import { PdhBuiltinServiceConfigStore } from "./PdhBuiltinServiceConfig.js";

const roots: string[] = [];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testConfigPath = path.join(projectRoot, "src/server/fixtures/services.test.json");

function releaseBaseline(root: string) {
  const loaded = loadServiceConfiguration(projectRoot, testConfigPath);
  const source = structuredClone(loaded.source);
  for (const series of source.series) {
    for (const profile of series.profiles) {
      for (const service of Object.values(profile.services)) {
        if (service && typeof service.cwd === "string" && !path.isAbsolute(service.cwd)) {
          service.cwd = path.resolve(projectRoot, service.cwd);
        }
      }
    }
  }
  const release = source.series.find((series) => series.id === "phoenix-admin")!.profiles
    .find((profile) => profile.id === "release-validation")!;
  release.policy = {
    ...release.policy!,
    assembly: {
      ...release.policy!.assembly!,
      outputRoot: path.join(root, ".runtime/assemblies/release-validation"),
    },
  };
  return { source, definitions: resolveServiceConfiguration(source, root) };
}

function fixture(): { root: string; baseline: ServiceDefinition } {
  const root = mkdtempSync(path.join(os.tmpdir(), "pdh-builtin-config-"));
  roots.push(root);
  const serviceRoot = path.join(root, "service");
  mkdirSync(serviceRoot);
  return {
    root,
    baseline: {
      id: "default-web",
      name: "Default Web",
      moduleId: "default-site",
      moduleName: "Default Site",
      description: "baseline",
      cwd: serviceRoot,
      command: { executable: "node", args: ["server.js"] },
      endpoints: [{ id: "web", label: "Web", port: 64_531, required: true }],
      externalStop: "deny",
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PdhBuiltinServiceConfigStore", () => {
  it("本机覆盖的工作目录失效时保留条目和配置错误，不阻断 Store/Hub 加载", () => {
    const { root, baseline } = fixture();
    const source = configurationFromDefinitions([baseline]);
    const series = structuredClone(source.series[0]!);
    const missingRoot = path.join(root, "removed-worktree", "web");
    for (const service of Object.values(series.template.services)) {
      if (service) service.cwd = missingRoot;
    }
    for (const profile of series.profiles) {
      for (const service of Object.values(profile.services)) {
        if (service) service.cwd = missingRoot;
      }
    }
    const runtimeFile = path.join(root, ".runtime/services.json");
    mkdirSync(path.dirname(runtimeFile));
    const original = JSON.stringify({
      version: 3,
      seriesOverrides: [series],
      baselineProfileIds: { [series.id]: series.profiles.map((profile) => profile.id) },
      removed: [],
    });
    writeFileSync(runtimeFile, original);

    const store = new PdhBuiltinServiceConfigStore(root, {
      source,
      definitions: resolveServiceConfiguration(source, root),
    });

    expect(store.effectiveDefinitions()).toEqual([
      expect.objectContaining({
        id: baseline.id,
        cwd: missingRoot,
        configurationErrors: [expect.stringContaining("工作目录不存在")],
      }),
    ]);
    expect(store.catalog().services[0]?.definition).toMatchObject({
      configurationErrors: [expect.stringContaining(missingRoot)],
    });
    expect(readFileSync(runtimeFile, "utf8")).toBe(original);
  });

  it("区分仓库基线、本机覆盖和移除，并可重置恢复", () => {
    const { root, baseline } = fixture();
    const store = new PdhBuiltinServiceConfigStore(root, [baseline]);

    expect(store.effectiveDefinitions()[0]).toMatchObject({
      name: "Default Web",
      configurationSource: "builtin",
      configurationOverridden: false,
    });

    store.update(baseline.id, { ...baseline, name: "Local Default Web" });
    expect(store.catalog().services[0]).toMatchObject({ overridden: true, removed: false });
    expect(store.effectiveDefinitions()[0].name).toBe("Local Default Web");

    const configPath = path.join(root, ".runtime/services.json");
    expect(existsSync(configPath)).toBe(true);
    const configStat = statSync(configPath);
    expect(configStat.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(configStat.mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      version: 3,
      removed: [],
      seriesOverrides: expect.any(Array),
      baselineProfileIds: expect.any(Object),
    });

    store.remove(baseline.id);
    expect(store.effectiveDefinitions()).toHaveLength(0);
    expect(store.catalog().services[0]).toMatchObject({ removed: true, overridden: false });

    const reloaded = new PdhBuiltinServiceConfigStore(root, [baseline]);
    expect(reloaded.catalog().services[0].removed).toBe(true);
    expect(reloaded.restore(baseline.id)).toMatchObject({
      name: "Default Web",
      configurationSource: "builtin",
      configurationOverridden: false,
    });
    expect(reloaded.catalog().services[0].removed).toBe(false);
    reloaded.remove(baseline.id);
    reloaded.reset();
    expect(reloaded.effectiveDefinitions()[0]).toMatchObject({
      name: "Default Web",
      configurationOverridden: false,
    });
  });

  it("导入只接受基线内稳定 ID，且相同基线会清除覆盖", () => {
    const { root, baseline } = fixture();
    const store = new PdhBuiltinServiceConfigStore(root, [baseline]);
    store.update(baseline.id, { ...baseline, name: "Local Default Web" });

    const plan = store.prepareImport([baseline]);
    const imported = store.commitImport(plan);
    expect(imported[0]).toMatchObject({
      name: "Default Web",
      configurationSource: "builtin",
      configurationOverridden: false,
    });
    expect(() => store.prepareImport([{ ...baseline, id: "unknown-service" }])).toThrow(
      "导入配置包含未知内置服务",
    );
  });

  it("允许编辑 Series 并增加第二个 Profile", () => {
    const { root, baseline } = fixture();
    const store = new PdhBuiltinServiceConfigStore(root, [baseline]);
    const series = store.catalog().series[0]!;
    const profile = series.definition.profiles[0]!;
    store.updateSeries(series.id, {
      ...series.definition,
      profiles: [profile, {
        ...profile,
        id: "develop",
        name: "开发版",
        services: {
          ...profile.services,
          [baseline.id]: {
            ...profile.services[baseline.id],
            id: "develop-web",
          },
        },
      }],
    });

    expect(store.catalog().series[0]).toMatchObject({ overridden: true });
    expect(store.allDefinitions().map((definition) => definition.id)).toEqual([
      "default-web",
      "develop-web",
    ]);
    expect(store.allDefinitions()[1]).toMatchObject({ profileId: "develop", runtimeSlot: "default-site" });
  });

  it("旧 version 2 Series 覆盖保留用户字段并合并后来新增的基线 Profile", () => {
    const { root, baseline } = fixture();
    const releaseRoot = path.join(root, "release-service");
    mkdirSync(releaseRoot);
    const initial = configurationFromDefinitions([baseline]);
    const originalSeries = initial.series[0]!;
    const originalProfile = originalSeries.profiles[0]!;
    const nextSource = {
      version: 2 as const,
      series: [{
        ...originalSeries,
        profiles: [originalProfile, {
          ...originalProfile,
          id: "release-validation",
          name: "发布包验收",
          runtimeSlot: "release-validation-slot",
          services: {
            ...originalProfile.services,
            [baseline.id]: {
              ...originalProfile.services[baseline.id],
              id: "release-web",
              cwd: releaseRoot,
              endpoints: [{ id: "web", label: "Web", port: 64_532 }],
            },
          },
        }],
      }],
    };
    const legacyOverride = {
      ...originalSeries,
      profiles: [{ ...originalProfile, name: "用户保留名称" }],
    };
    mkdirSync(path.join(root, ".runtime"));
    writeFileSync(path.join(root, ".runtime/services.json"), JSON.stringify({
      version: 2,
      seriesOverrides: [legacyOverride],
      removed: [],
    }));

    const store = new PdhBuiltinServiceConfigStore(root, {
      source: nextSource,
      definitions: resolveServiceConfiguration(nextSource, root),
    });
    expect(store.allDefinitions().map((definition) => definition.id)).toEqual([
      "default-web",
      "release-web",
    ]);
    expect(store.sourceDocument().series[0]?.profiles.map((profile) => profile.name)).toEqual([
      "用户保留名称",
      "发布包验收",
    ]);

    store.updateSeries(originalSeries.id, store.sourceDocument().series[0]);
    expect(JSON.parse(readFileSync(path.join(root, ".runtime/services.json"), "utf8"))).toMatchObject({
      version: 3,
      baselineProfileIds: { [originalSeries.id]: ["default", "release-validation"] },
    });
  });

  it("旧覆盖缺少 preflight 时以内存安全锚点迁入当前 release-validation baseline", () => {
    const { root } = fixture();
    const baseline = releaseBaseline(root);
    const legacySeries = structuredClone(
      baseline.source.series.find((series) => series.id === "phoenix-admin")!,
    );
    const legacyRelease = legacySeries.profiles.find((profile) => profile.id === "release-validation")!;
    legacyRelease.name = "用户保留的发布验收名称";
    delete (legacyRelease.policy!.database as { preflight?: unknown }).preflight;
    const runtimeFile = path.join(root, ".runtime/services.json");
    mkdirSync(path.dirname(runtimeFile));
    writeFileSync(runtimeFile, JSON.stringify({
      version: 3,
      seriesOverrides: [legacySeries],
      baselineProfileIds: { "phoenix-admin": ["default", "release-validation"] },
      removed: [],
    }));

    const store = new PdhBuiltinServiceConfigStore(root, baseline);
    const effectiveRelease = store.sourceDocument().series
      .find((series) => series.id === "phoenix-admin")!.profiles
      .find((profile) => profile.id === "release-validation")!;
    expect(effectiveRelease.name).toBe("用户保留的发布验收名称");
    expect(effectiveRelease.policy?.database.preflight).toEqual(
      baseline.source.series.find((series) => series.id === "phoenix-admin")!.profiles
        .find((profile) => profile.id === "release-validation")!.policy!.database.preflight,
    );
    expect(readFileSync(runtimeFile, "utf8")).not.toContain('"preflight"');
  });

  it("旧覆盖不能覆盖发布验收数据库、装配 SHA、Host commit 或 Registry 完整性", () => {
    const { root } = fixture();
    const baseline = releaseBaseline(root);
    const baselineSeries = baseline.source.series.find((series) => series.id === "phoenix-admin")!;
    const baselineRelease = baselineSeries.profiles.find((profile) => profile.id === "release-validation")!;
    const staleSeries = structuredClone(baselineSeries);
    const staleRelease = staleSeries.profiles.find((profile) => profile.id === "release-validation")!;
    staleRelease.policy = {
      ...staleRelease.policy!,
      database: {
        ...staleRelease.policy!.database,
        name: "stale_release_validation_20260804",
        preflight: {
          ...staleRelease.policy!.database.preflight!,
          host: "db.example.com",
          creation: {
            allowedDatabaseNames: ["stale_release_validation_20260804", "production"],
            cleanupResponsibility: "stale",
          },
        },
      },
      assembly: {
        ...staleRelease.policy!.assembly!,
        packagePath: "/tmp/stale-package.pah.cool",
        packageSha256: "d".repeat(64),
        version: "0.0.0",
        nodeHost: { ...staleRelease.policy!.assembly!.nodeHost, commit: "e".repeat(40) },
        vueHost: { ...staleRelease.policy!.assembly!.vueHost, commit: "f".repeat(40) },
        registryPackages: staleRelease.policy!.assembly!.registryPackages.map((item) => ({
          ...item,
          version: "0.0.0",
          integrity: "sha512-c3RhbGU=",
        })),
      },
    };
    const staleWeb = staleRelease.services.web;
    if (!staleWeb) throw new Error("缺少 release web fixture");
    staleRelease.services = {
      ...staleRelease.services,
      web: {
        ...staleWeb,
        command: {
          ...staleWeb.command,
          args: ["dev", "--", "--host", "127.0.0.1", "--port", "9999"],
          env: { STALE_RELEASE_ENV: "true" },
        },
        endpoints: [{ id: "web", label: "Web", port: 9999 }],
      },
    };
    const runtimeFile = path.join(root, ".runtime/services.json");
    mkdirSync(path.dirname(runtimeFile));
    writeFileSync(runtimeFile, JSON.stringify({
      version: 3,
      seriesOverrides: [staleSeries],
      baselineProfileIds: { "phoenix-admin": ["default", "release-validation"] },
      removed: [],
    }));

    const store = new PdhBuiltinServiceConfigStore(root, baseline);
    const effective = store.sourceDocument().series
      .find((series) => series.id === "phoenix-admin")!.profiles
      .find((profile) => profile.id === "release-validation")!;
    expect(effective.policy).toEqual(baselineRelease.policy);
    expect(effective.services).toEqual(baselineRelease.services);
    const original = readFileSync(runtimeFile, "utf8");
    expect(original).toContain("db.example.com");
    expect(original).toContain('"packageSha256":"dddd');
  });
});
