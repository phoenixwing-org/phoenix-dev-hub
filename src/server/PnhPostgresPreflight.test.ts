import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ServiceDefinition } from "../shared/contracts.js";
import { PnhPostgresPreflight, type PnhPostgresConnector } from "./PnhPostgresPreflight.js";

function releaseDefinition(): ServiceDefinition {
  return {
    id: "release-api",
    name: "Release API",
    moduleId: "release-site",
    moduleName: "Release Site",
    seriesId: "release-site",
    profileId: "release-validation",
    serviceRole: "api",
    cwd: process.cwd(),
    command: {
      executable: process.execPath,
      args: ["fixture.js"],
      env: {
        PAH_DB_DATABASE: "sample_release_validation_20260804",
        PAH_DB_USERNAME: "fixture_user",
        PAH_DB_PASSWORD: "fixture-secret-must-not-leak",
      },
    },
    endpoints: [],
    profilePolicy: {
      environmentKind: "release-validation",
      deploymentMode: "package-assembled",
      database: {
        serviceRole: "api",
        envName: "PAH_DB_DATABASE",
        name: "sample_release_validation_20260804",
        preflight: {
          provider: "postgresql",
          host: "127.0.0.1",
          port: 5432,
          maintenanceDatabase: "postgres",
          usernameEnv: "PAH_DB_USERNAME",
          passwordEnv: "PAH_DB_PASSWORD",
        },
      },
    },
  };
}

describe("PnhPostgresPreflight", () => {
  it("只读确认隔离数据库存在且不把凭据写入证据", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ serverVersion: "17.5", exists: true }],
    });
    const end = vi.fn().mockResolvedValue(undefined);
    const connector: PnhPostgresConnector = vi.fn().mockResolvedValue({ query, end });
    const definition = releaseDefinition();
    const preflight = new PnhPostgresPreflight(connector, {});

    const evidence = await preflight.inspect(definition, [definition], true);

    expect(connector).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 5432,
      database: "postgres",
      user: "fixture_user",
      password: "fixture-secret-must-not-leak",
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("pg_database"), [
      "sample_release_validation_20260804",
    ]);
    expect(evidence).toMatchObject({
      state: "ready",
      exists: true,
      databaseName: "sample_release_validation_20260804",
    });
    expect(JSON.stringify(evidence)).not.toContain("fixture-secret");
    expect(JSON.stringify(evidence)).not.toContain("fixture_user");
    expect(end).toHaveBeenCalledOnce();
  });

  it("数据库缺失时阻断 spawn，并使用稳定错误码而不泄露密码", async () => {
    const connector: PnhPostgresConnector = vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [{ serverVersion: "17.5", exists: false }] }),
      end: vi.fn().mockResolvedValue(undefined),
    });
    const definition = releaseDefinition();
    const preflight = new PnhPostgresPreflight(connector, {});

    await expect(preflight.assertReady(definition, [definition])).rejects.toMatchObject({
      code: "PROFILE_DATABASE_MISSING",
      statusCode: 409,
    });
    await expect(preflight.inspect(definition, [definition], true)).resolves.toMatchObject({
      state: "missing",
      exists: false,
    });
    try {
      await preflight.assertReady(definition, [definition]);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("fixture-secret");
    }
  });

  it("连接失败只暴露错误码，不暴露底层连接文本", async () => {
    const failure = Object.assign(new Error("password fixture-secret-must-not-leak"), { code: "28P01" });
    const connector: PnhPostgresConnector = vi.fn().mockRejectedValue(failure);
    const definition = releaseDefinition();
    const preflight = new PnhPostgresPreflight(connector, {});

    const evidence = await preflight.inspect(definition, [definition], true);

    expect(evidence).toMatchObject({
      state: "unavailable",
      exists: null,
      message: "PostgreSQL preflight 失败（28P01）",
    });
    expect(JSON.stringify(evidence)).not.toContain("fixture-secret");
  });

  it("数据库存在但缺 Host/Pah 基线关系时标记 uninitialized 并在 spawn 前阻断", async () => {
    const definition = releaseDefinition();
    const withRelations: ServiceDefinition = {
      ...definition,
      profilePolicy: {
        ...definition.profilePolicy!,
        database: {
          ...definition.profilePolicy!.database,
          preflight: {
            ...definition.profilePolicy!.database.preflight!,
            requiredRelations: ["task_info", "plugin_info", "pah_plugin_installation"],
            requiredRelationsStatus: "versioned-manifest",
          },
        },
      },
    };
    const maintenanceQuery = vi.fn().mockResolvedValue({
      rows: [{ serverVersion: "17.5", exists: true }],
    });
    const targetQuery = vi.fn().mockResolvedValue({
      rows: [{ relationName: "task_info" }],
    });
    const connector: PnhPostgresConnector = vi.fn()
      .mockResolvedValueOnce({ query: maintenanceQuery, end: vi.fn().mockResolvedValue(undefined) })
      .mockResolvedValueOnce({ query: targetQuery, end: vi.fn().mockResolvedValue(undefined) });
    const preflight = new PnhPostgresPreflight(connector, {});

    const evidence = await preflight.inspect(withRelations, [withRelations], true);

    expect(connector).toHaveBeenNthCalledWith(2, expect.objectContaining({
      database: "sample_release_validation_20260804",
    }));
    expect(targetQuery).toHaveBeenCalledWith(expect.stringContaining("pg_catalog.pg_class"), [[
      "task_info",
      "plugin_info",
      "pah_plugin_installation",
    ]]);
    expect(evidence).toMatchObject({
      state: "uninitialized",
      exists: true,
      missingRelations: ["plugin_info", "pah_plugin_installation"],
    });

    const blockingConnector: PnhPostgresConnector = vi.fn()
      .mockResolvedValueOnce({ query: maintenanceQuery, end: vi.fn().mockResolvedValue(undefined) })
      .mockResolvedValueOnce({ query: targetQuery, end: vi.fn().mockResolvedValue(undefined) });
    const blockingPreflight = new PnhPostgresPreflight(blockingConnector, {});
    await expect(blockingPreflight.assertReady(withRelations, [withRelations])).rejects.toMatchObject({
      code: "PROFILE_DATABASE_UNINITIALIZED",
      statusCode: 409,
      details: { missingRelations: ["plugin_info", "pah_plugin_installation"] },
    });
  });

  it("provisional 关系清单即使全部命中也保持 uninitialized", async () => {
    const definition = releaseDefinition();
    const provisional: ServiceDefinition = {
      ...definition,
      profilePolicy: {
        ...definition.profilePolicy!,
        database: {
          ...definition.profilePolicy!.database,
          preflight: {
            ...definition.profilePolicy!.database.preflight!,
            requiredRelations: ["task_info", "plugin_info"],
            requiredRelationsStatus: "provisional",
          },
        },
      },
    };
    const connector: PnhPostgresConnector = vi.fn()
      .mockResolvedValueOnce({
        query: vi.fn().mockResolvedValue({ rows: [{ serverVersion: "17.5", exists: true }] }),
        end: vi.fn().mockResolvedValue(undefined),
      })
      .mockResolvedValueOnce({
        query: vi.fn().mockResolvedValue({
          rows: [{ relationName: "task_info" }, { relationName: "plugin_info" }],
        }),
        end: vi.fn().mockResolvedValue(undefined),
      });
    const preflight = new PnhPostgresPreflight(connector, {});

    await expect(preflight.inspect(provisional, [provisional], true)).resolves.toMatchObject({
      state: "uninitialized",
      missingRelations: [],
      requiredRelationsStatus: "provisional",
      message: expect.stringContaining("版本化 Host 基线清单尚未交付"),
    });
  });

  it("缺少显式用户名变量时 fail-closed，不回退 USER 或 postgres", async () => {
    const connector: PnhPostgresConnector = vi.fn();
    const definition = releaseDefinition();
    const command = { ...definition.command, env: { PAH_DB_DATABASE: "sample_release_validation_20260804" } };
    const withoutUser = { ...definition, command };
    const preflight = new PnhPostgresPreflight(connector, { USER: "ambient-user" });

    await expect(preflight.inspect(withoutUser, [withoutUser], true)).resolves.toMatchObject({
      state: "unavailable",
      message: "PostgreSQL preflight 缺少用户名环境变量 PAH_DB_USERNAME",
    });
    const createWithoutUser: ServiceDefinition = {
      ...withoutUser,
      profilePolicy: {
        ...withoutUser.profilePolicy!,
        database: {
          ...withoutUser.profilePolicy!.database,
          preflight: {
            ...withoutUser.profilePolicy!.database.preflight!,
            creation: {
              allowedDatabaseNames: ["sample_release_validation_20260804"],
              cleanupResponsibility: "fixture cleanup",
            },
          },
        },
      },
    };
    try {
      await preflight.createIsolated(
        createWithoutUser,
        [createWithoutUser],
        "create-release-validation-database:sample_release_validation_20260804",
      );
      throw new Error("期望缺少用户名时拒绝显式建库");
    } catch (error) {
      expect(error).toMatchObject({ code: "PROFILE_DATABASE_PREFLIGHT_FAILED" });
      expect(JSON.stringify(error)).not.toContain("ambient-user");
    }
    expect(connector).not.toHaveBeenCalled();
  });

  it("仅通过显式确认创建 allowlist 中原先不存在的本机验收库并记录回收责任", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pnh-postgres-create-"));
    let exists = false;
    const connector: PnhPostgresConnector = vi.fn().mockImplementation(async () => ({
      query: vi.fn().mockImplementation(async (text: string) => {
        if (text.startsWith("CREATE DATABASE")) {
          expect(text).toBe('CREATE DATABASE "sample_release_validation_20260804"');
          exists = true;
          return { rows: [] };
        }
        return { rows: [{ serverVersion: "17.5", exists }] };
      }),
      end: vi.fn().mockResolvedValue(undefined),
    }));
    const base = releaseDefinition();
    const definition: ServiceDefinition = {
      ...base,
      profilePolicy: {
        ...base.profilePolicy!,
        database: {
          ...base.profilePolicy!.database,
          preflight: {
            ...base.profilePolicy!.database.preflight!,
            creation: {
              allowedDatabaseNames: ["sample_release_validation_20260804"],
              cleanupResponsibility: "验收结束后由本机操作者受控回收。",
            },
          },
        },
        assembly: {
          outputRoot: path.join(root, ".runtime/assemblies/release"),
          roleDirectories: { api: "node" },
          packagePath: path.join(root, "fixture.pah.cool"),
          packageSha256: "a".repeat(64),
          packageKind: "pah-business-module",
          moduleId: "fixture-module",
          version: "1.0.0",
          nodeHost: { root, commit: "b".repeat(40) },
          vueHost: { root, commit: "c".repeat(40) },
          registryPackages: [],
        },
      },
    };
    const preflight = new PnhPostgresPreflight(connector, {});
    try {
      await expect(preflight.createIsolated(
        definition,
        [definition],
        "create-release-validation-database:sample_release_validation_20260804",
      )).resolves.toMatchObject({
        state: "ready",
        exists: true,
        existingBefore: false,
        cleanupResponsibility: "验收结束后由本机操作者受控回收。",
        evidenceFile: "database-evidence/release-site--release-validation.json",
      });
      const evidence = readFileSync(
        path.join(root, ".runtime/database-evidence/release-site--release-validation.json"),
        "utf8",
      );
      const evidenceStat = statSync(path.join(
        root,
        ".runtime/database-evidence/release-site--release-validation.json",
      ));
      expect(evidenceStat.isFile()).toBe(true);
      if (process.platform !== "win32") {
        expect(evidenceStat.mode & 0o777).toBe(0o600);
      }
      expect(evidence).toContain('"actionState": "created"');
      expect(evidence).toContain('"existingBefore": false');
      expect(evidence).not.toContain("fixture-secret");
      expect(connector).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("显式建库拒绝错误确认、非 allowlist 和已存在目标", async () => {
    const base = releaseDefinition();
    const withCreation: ServiceDefinition = {
      ...base,
      profilePolicy: {
        ...base.profilePolicy!,
        database: {
          ...base.profilePolicy!.database,
          preflight: {
            ...base.profilePolicy!.database.preflight!,
            creation: {
              allowedDatabaseNames: ["sample_release_validation_20260804"],
              cleanupResponsibility: "fixture cleanup",
            },
          },
        },
      },
    };
    const connector: PnhPostgresConnector = vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [{ serverVersion: "17.5", exists: true }] }),
      end: vi.fn().mockResolvedValue(undefined),
    });
    const preflight = new PnhPostgresPreflight(connector, {});

    await expect(preflight.createIsolated(withCreation, [withCreation], "wrong-confirmation"))
      .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    const outsideAllowlist = {
      ...withCreation,
      profilePolicy: {
        ...withCreation.profilePolicy!,
        database: { ...withCreation.profilePolicy!.database, name: "other_release_validation_20260804" },
      },
    };
    await expect(preflight.createIsolated(
      outsideAllowlist,
      [outsideAllowlist],
      "create-release-validation-database:other_release_validation_20260804",
    )).rejects.toMatchObject({ code: "PROFILE_DATABASE_CREATE_DENIED" });
    await expect(preflight.createIsolated(
      withCreation,
      [withCreation],
      "create-release-validation-database:sample_release_validation_20260804",
    )).rejects.toMatchObject({ code: "PROFILE_DATABASE_ALREADY_EXISTS" });
    expect(connector).toHaveBeenCalledOnce();
  });
});
