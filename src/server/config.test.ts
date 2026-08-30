import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadServiceConfiguration,
  parseServiceConfigurationDocument,
  resolveServiceConfigurationPath,
} from "./config.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testConfigPath = path.join(projectRoot, "src/server/fixtures/services.test.json");

function loadTestConfiguration() {
  return loadServiceConfiguration(projectRoot, testConfigPath);
}

describe("services.json", () => {
  it("Windows 与 Linux 示例保留当前服务拓扑和开发插件登记", () => {
    for (const platform of ["windows", "linux"]) {
      const serviceSample = JSON.parse(readFileSync(
        path.join(projectRoot, "config", "sample", `services.${platform}.sample.json`),
        "utf8",
      ));
      expect(serviceSample.version).toBe(2);
      expect(serviceSample.series.map((series: { id: string }) => series.id)).toEqual([
        "phoenix-admin",
        "cool-admin-midway4",
        "open-issue",
      ]);
      expect(serviceSample.series[0].profiles.map((profile: { id: string }) => profile.id)).toEqual([
        "development",
        "clean-validation",
      ]);
      expect(serviceSample.series[0].profiles[1].services.web.id).toBe("admin-clean-validation-web");
      expect(serviceSample.series[0].profiles[1].services.api.id).toBe("admin-clean-validation-api");

      const pluginSample = JSON.parse(readFileSync(
        path.join(projectRoot, "config", "sample", `admin-plugins.${platform}.sample.json`),
        "utf8",
      ));
      expect(pluginSample.version).toBe(1);
      expect(pluginSample.plugins.map((plugin: { moduleId: string }) => plugin.moduleId)).toEqual([
        "phoenix-open-issue",
        "phoenix-branding",
      ]);
      expect(pluginSample.operations).toEqual({});
    }
  });

  it("配置文件整体损坏时返回可展示错误而不抛出 HubError", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pnh-config-invalid-json-"));
    const configPath = path.join(root, "services.user.json");
    try {
      writeFileSync(configPath, "{ invalid json\n");
      expect(loadServiceConfiguration(root, configPath)).toEqual({
        source: { version: 2, series: [] },
        definitions: [],
        configurationErrors: [expect.any(String)],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("启动加载保留路径失效的服务并返回可见配置错误，严格编辑校验仍拒绝", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pnh-config-missing-path-"));
    const configPath = path.join(root, "services.user.json");
    const document = {
      version: 2,
      series: [{
        id: "missing-site",
        name: "Missing Site",
        template: {
          services: {
            web: {
              name: "Missing Web",
              cwd: "./deleted-worktree",
              command: { executable: "pnpm", args: ["dev"] },
              endpoints: [{ id: "web", label: "Web", port: 45_101 }],
            },
          },
        },
        profiles: [{
          id: "default",
          name: "默认实例",
          services: { web: { id: "missing-web" } },
        }],
      }],
    };
    try {
      writeFileSync(configPath, `${JSON.stringify(document)}\n`);
      const loaded = loadServiceConfiguration(root, configPath);
      expect(loaded.definitions).toHaveLength(1);
      expect(loaded.definitions[0]).toMatchObject({
        id: "missing-web",
        configurationErrors: [expect.stringContaining("工作目录不存在")],
      });
      expect(() => parseServiceConfigurationDocument(document, root)).toThrow("工作目录不存在");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("用户配置优先于旧配置且不会自动执行 sample", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pnh-config-path-"));
    const configRoot = path.join(root, "config");
    mkdirSync(configRoot);
    try {
      const sampleRoot = path.join(configRoot, "sample");
      mkdirSync(sampleRoot);
      writeFileSync(path.join(sampleRoot, "services.sample.json"), "{}\n");
      expect(() => resolveServiceConfigurationPath(root)).toThrow("用户服务配置");

      writeFileSync(path.join(configRoot, "services.json"), "{}\n");
      expect(resolveServiceConfigurationPath(root)).toBe(path.join(configRoot, "services.json"));

      writeFileSync(path.join(configRoot, "services.user.json"), "{}\n");
      expect(resolveServiceConfigurationPath(root)).toBe(path.join(configRoot, "services.user.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("加载受控服务且不暴露 shell 命令", () => {
    const configuration = loadTestConfiguration();
    expect(configuration.source.version).toBe(2);
    expect(configuration.source.series.find((series) => series.id === "phoenix-admin")?.profiles)
      .toHaveLength(2);
    const services = configuration.definitions;
    expect(services.map((service) => service.id)).toEqual([
      "admin-web",
      "admin-api",
      "admin-release-web",
      "admin-release-api",
      "cool-admin-midway4-web",
      "cool-admin-midway4-api",
      "open-issue",
    ]);
    expect(services.every((service) => path.isAbsolute(service.cwd))).toBe(true);
    expect(services.every((service) => service.command.executable === "pnpm")).toBe(true);
    expect(services.find((service) => service.id === "open-issue")?.command.args)
      .toEqual(["dev"]);
    expect(services.find((service) => service.id === "admin-api")?.endpoints[0]?.port)
      .toBe(8101);
    expect(services.find((service) => service.id === "admin-api")?.endpoints[0]?.healthUrl)
      .toBe("http://127.0.0.1:8101/index.html");
    expect(services.find((service) => service.id === "admin-api")?.command)
      .toEqual({ executable: "pnpm", args: ["dev"] });
    expect(services.filter((service) => service.moduleId === "phoenix-admin")).toHaveLength(4);
    expect(services.filter((service) => service.seriesId === "phoenix-admin")).toHaveLength(4);
    expect(services.find((service) => service.id === "admin-web")).toMatchObject({
      profileId: "development",
      profileName: "Admin 开发联调",
      serviceRole: "web",
      runtimeSlot: "phoenix-admin-development",
      startOrder: 20,
      command: { executable: "pnpm", args: ["dev:local"] },
      profilePolicy: undefined,
    });
    expect(services.find((service) => service.id === "admin-release-web")).toMatchObject({
      profileId: "release-validation",
      profileName: "Admin 发布验收环境（非正式）",
      runtimeSlot: "phoenix-admin-release-validation",
      cwd: path.join(projectRoot, ".runtime/assemblies/admin-release-validation/vue"),
      command: { env: { PAH_API_TARGET: "http://127.0.0.1:8201" } },
      endpoints: [{ port: 9100 }],
      profilePolicy: {
        environmentKind: "release-validation",
        deploymentMode: "package-assembled",
        database: {
          name: "phoenix_admin_release_validation",
          preflight: {
            provider: "postgresql",
            host: "127.0.0.1",
            port: 5432,
            maintenanceDatabase: "postgres",
            usernameEnv: "PGUSER",
            passwordEnv: "PGPASSWORD",
            requiredRelations: ["base_sys_user", "plugin_info", "pah_plugin_installation"],
            requiredRelationsStatus: "provisional",
            creation: {
              allowedDatabaseNames: ["phoenix_admin_release_validation"],
              cleanupResponsibility: expect.stringContaining("受控流程"),
            },
          },
        },
        assembly: {
          packageSha256: "0000000000000000000000000000000000000000000000000000000000000000",
          vueHost: { commit: "0000000000000000000000000000000000000000" },
          registryPackages: [{ name: "phoenix-wing", version: "0.0.0" }],
        },
      },
    });
    const releaseWebArgs = services.find((service) => service.id === "admin-release-web")?.command.args;
    expect(releaseWebArgs).toEqual([
      "dev",
      "--host",
      "127.0.0.1",
      "--strictPort",
      "--port",
      "9100",
    ]);
    expect(releaseWebArgs).not.toContain("--");
    expect(releaseWebArgs?.filter((argument) => argument === "--host")).toHaveLength(1);
    expect(releaseWebArgs?.filter((argument) => argument === "--port")).toHaveLength(1);
    expect(services.find((service) => service.id === "admin-release-api")).toMatchObject({
      command: { env: {
        PAH_SERVER_PORT: "8201",
        PAH_DB_DATABASE: "phoenix_admin_release_validation",
        PAH_DB_SYNCHRONIZE: "false",
        PAH_DB_INITIALIZE: "false",
      } },
      endpoints: [{ port: 8201 }],
    });
    expect(services.find((service) => service.id === "cool-admin-midway4-web")).toMatchObject({
      profileId: "integration",
      runtimeSlot: "cool-admin-midway4-integration",
      command: {
        args: ["dev", "--host", "127.0.0.1", "--strictPort", "--port", "9200"],
      },
      endpoints: [{ port: 9200 }],
      profileMetadata: {
        sourceBaseline: "Node e545ef6 → Midway 4；Vue a2d4ee9",
        testGuide: expect.stringContaining("登录"),
      },
    });
    expect(services.find((service) => service.id === "cool-admin-midway4-api")).toMatchObject({
      command: {
        args: ["dev:midway4"],
        env: {
          MIDWAY4_DB_HOST: "127.0.0.1",
          MIDWAY4_DB_PORT: "5432",
          MIDWAY4_DB_USERNAME: "postgres",
          MIDWAY4_DB_DATABASE: "cool_admin_midway4_validation",
        },
      },
      endpoints: [{ port: 8001 }],
      profilePolicy: {
        environmentKind: "development",
        deploymentMode: "source-mounted",
        database: {
          serviceRole: "api",
          envName: "MIDWAY4_DB_DATABASE",
          name: "cool_admin_midway4_validation",
        },
      },
    });
    expect(new Set(services.map((service) => service.moduleId)).size).toBe(3);
    expect(services.flatMap((service) => service.endpoints).every(
      (endpoint) => endpoint.port > 0 && endpoint.port <= 65_535,
    )).toBe(true);
    expect(services.flatMap((service) => service.endpoints).every(
      (endpoint) => endpoint.required === true,
    )).toBe(true);
  });

  it("发布验收必须配置本机 PostgreSQL spawn 前 preflight", () => {
    const missing = structuredClone(loadTestConfiguration().source) as any;
    delete missing.series[0].profiles[1].policy.database.preflight;
    expect(() => parseServiceConfigurationDocument(missing, projectRoot)).toThrow(
      /release-validation 必须配置本机 PostgreSQL spawn 前 preflight/,
    );

    const remote = structuredClone(loadTestConfiguration().source) as any;
    remote.series[0].profiles[1].policy.database.preflight.host = "db.example.com";
    expect(() => parseServiceConfigurationDocument(remote, projectRoot)).toThrow(
      /只允许本机 PostgreSQL/,
    );

    const outsideAllowlist = structuredClone(loadTestConfiguration().source) as any;
    outsideAllowlist.series[0].profiles[1].policy.database.preflight.creation.allowedDatabaseNames = [
      "another_release_validation_20260804",
    ];
    expect(() => parseServiceConfigurationDocument(outsideAllowlist, projectRoot)).toThrow(
      /精确 allowlist 授权当前验收数据库名/,
    );

    const unsafeRelation = structuredClone(loadTestConfiguration().source) as any;
    unsafeRelation.series[0].profiles[1].policy.database.preflight.requiredRelations = [
      "task_info; DROP DATABASE postgres",
    ];
    expect(() => parseServiceConfigurationDocument(unsafeRelation, projectRoot)).toThrow(
      /安全 SQL 标识符白名单/,
    );

    const unknownStatus = structuredClone(loadTestConfiguration().source) as any;
    unknownStatus.series[0].profiles[1].policy.database.preflight.requiredRelationsStatus = "guessed";
    expect(() => parseServiceConfigurationDocument(unknownStatus, projectRoot)).toThrow(
      /provisional 或 versioned-manifest/,
    );
  });

  it("合并公共模板与多版本覆盖，并以数组整体替换", () => {
    const loaded = parseServiceConfigurationDocument({
      version: 2,
      series: [{
        id: "sample-site",
        name: "Sample Site",
        template: {
          runtimeSlot: "sample-site",
          services: {
            web: {
              name: "Sample Web",
              cwd: ".",
              command: { executable: "node", args: ["stable.js"] },
              endpoints: [{ id: "web", label: "Web", port: 45101 }],
            },
          },
        },
        profiles: [{
          id: "stable",
          name: "稳定版",
          services: { web: { id: "sample-stable-web" } },
        }, {
          id: "develop",
          name: "开发版",
          metadata: { wingVersion: "0.6.2" },
          services: {
            web: {
              id: "sample-develop-web",
              command: { args: ["develop.js", "--watch"] },
            },
          },
        }],
      }],
    }, projectRoot);

    expect(loaded.definitions).toHaveLength(2);
    expect(loaded.definitions[0]?.command.args).toEqual(["stable.js"]);
    expect(loaded.definitions[1]).toMatchObject({
      id: "sample-develop-web",
      seriesId: "sample-site",
      profileId: "develop",
      runtimeSlot: "sample-site",
      profileMetadata: { wingVersion: "0.6.2" },
    });
    expect(loaded.definitions[1]?.command.args).toEqual(["develop.js", "--watch"]);
  });

  it("兼容 version 1 平铺清单并转换为隐式默认 Profile", () => {
    const loaded = parseServiceConfigurationDocument({
      version: 1,
      services: [{
        id: "legacy-web",
        name: "Legacy Web",
        moduleId: "legacy-site",
        moduleName: "Legacy Site",
        cwd: ".",
        command: { executable: "node", args: ["legacy.js"] },
        endpoints: [{ id: "web", label: "Web", port: 45102 }],
      }],
    }, projectRoot);
    expect(loaded.source).toMatchObject({ version: 2 });
    expect(loaded.definitions[0]).toMatchObject({
      id: "legacy-web",
      seriesId: "legacy-site",
      profileId: "default",
    });
  });

  it("并行 Profile 对端口、数据库与工作目录冲突 fail-closed", () => {
    const profile = (id: string, slot: string, port: number, cwd: string, database: string) => ({
      id,
      name: id,
      runtimeSlot: slot,
      policy: {
        environmentKind: "development",
        deploymentMode: "source-mounted",
        database: { serviceRole: "app", envName: "TEST_DB_NAME", name: database },
      },
      services: {
        app: {
          id: `${id}-app`,
          cwd,
          command: { env: { TEST_DB_NAME: database } },
          endpoints: [{ id: "web", label: "Web", port }],
        },
      },
    });
    const document = (profiles: readonly unknown[]) => ({
      version: 2,
      series: [{
        id: "parallel-site",
        name: "Parallel Site",
        template: {
          services: {
            app: { name: "App", command: { executable: "node", args: [] } },
          },
        },
        profiles,
      }],
    });
    expect(() => parseServiceConfigurationDocument(document([
      profile("first", "first-slot", 45_110, "src", "first_db"),
      profile("second", "second-slot", 45_110, "test", "second_db"),
    ]), projectRoot)).toThrow("并行端口冲突");
    expect(() => parseServiceConfigurationDocument(document([
      profile("first", "first-slot", 45_110, "src", "shared_db"),
      profile("second", "second-slot", 45_111, "test", "shared_db"),
    ]), projectRoot)).toThrow("数据库冲突");
    expect(() => parseServiceConfigurationDocument(document([
      profile("first", "first-slot", 45_110, "src", "first_db"),
      profile("second", "second-slot", 45_111, "src", "second_db"),
    ]), projectRoot)).toThrow("并行工作目录冲突");
  });

  it("production Profile 默认只读，并拒绝源码挂载", () => {
    const source = {
      version: 2,
      series: [{
        id: "production-site",
        name: "Production Site",
        template: {
          services: {
            app: {
              name: "Production App",
              command: { executable: "node", args: [] },
              endpoints: [{ id: "web", label: "Web", port: 45_120 }],
            },
          },
        },
        profiles: [{
          id: "production",
          name: "Production",
          runtimeSlot: "production-slot",
          policy: {
            environmentKind: "production",
            deploymentMode: "package-assembled",
            database: { serviceRole: "app", envName: "TEST_DB_NAME", name: "production_db" },
            assembly: {
              outputRoot: ".runtime/test-production",
              roleDirectories: { app: "node" },
              packagePath: "README.md",
              packageSha256: "0".repeat(64),
              packageKind: "pah-business-module",
              moduleId: "production-module",
              version: "1.0.0",
              nodeHost: { root: ".", commit: "0".repeat(40) },
              vueHost: { root: ".", commit: "0".repeat(40) },
              registryPackages: [{
                serviceRole: "app",
                name: "phoenix-wing",
                version: "0.6.2",
                integrity: "sha512-YWJjZA==",
              }],
            },
          },
          services: { app: { id: "production-app", command: { env: {
            TEST_DB_NAME: "production_db",
            PAH_DB_SYNCHRONIZE: "false",
            PAH_DB_INITIALIZE: "false",
          } } } },
        }],
      }],
    };
    expect(parseServiceConfigurationDocument(source, projectRoot).definitions[0]?.profilePolicy)
      .toMatchObject({ environmentKind: "production", lifecycleControl: false });
    const sourceMounted = structuredClone(source);
    sourceMounted.series[0]!.profiles[0]!.policy.deploymentMode = "source-mounted";
    delete (sourceMounted.series[0]!.profiles[0]!.policy as { assembly?: unknown }).assembly;
    expect(() => parseServiceConfigurationDocument(sourceMounted, projectRoot)).toThrow("禁止源码挂载");
  });
});
