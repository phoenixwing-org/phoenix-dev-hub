import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import type {
  ServiceDefinition,
  ServiceProfileDatabaseCreationEvidence,
  ServiceProfileDatabaseEvidence,
  ServiceProfileDatabasePolicy,
} from "../shared/contracts.js";
import { DevHubError } from "./errors.js";

interface PdhPostgresConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
}

interface PdhPostgresSession {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export type PdhPostgresConnector = (
  options: PdhPostgresConnectionOptions,
) => Promise<PdhPostgresSession>;

export interface PdhProfileDatabasePreflight {
  inspect(
    definition: ServiceDefinition,
    definitions: readonly ServiceDefinition[],
    refresh?: boolean,
  ): Promise<ServiceProfileDatabaseEvidence | undefined>;
  assertReady(
    definition: ServiceDefinition,
    definitions: readonly ServiceDefinition[],
  ): Promise<ServiceProfileDatabaseEvidence | undefined>;
  createIsolated?(
    definition: ServiceDefinition,
    definitions: readonly ServiceDefinition[],
    confirmation: string,
  ): Promise<ServiceProfileDatabaseCreationEvidence>;
}

interface CachedEvidence {
  readonly expiresAt: number;
  readonly value: Promise<ServiceProfileDatabaseEvidence>;
}

const CACHE_MS = 1_000;

const defaultConnector: PdhPostgresConnector = async (options) => {
  const client = new Client({
    ...options,
    application_name: "phoenix-dev-hub-release-preflight",
    connectionTimeoutMillis: 2_000,
    statement_timeout: 2_000,
  });
  await client.connect();
  return {
    query: async (text, values) => client.query(text, values ? [...values] : undefined),
    end: async () => client.end(),
  };
};

function profileKey(definition: ServiceDefinition): string {
  return `${definition.seriesId ?? definition.moduleId}/${definition.profileId ?? "default"}`;
}

function profileDefinitions(
  definition: ServiceDefinition,
  definitions: readonly ServiceDefinition[],
): readonly ServiceDefinition[] {
  const key = profileKey(definition);
  return definitions.filter((candidate) => profileKey(candidate) === key);
}

function safeFailureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "UNKNOWN";
}

/**
 * release-validation 的 PostgreSQL 只读 spawn 前门禁。
 * 只查询系统目录；不建表、不恢复、不执行产品 DDL，也不把凭据写入状态或日志。
 */
export class PdhPostgresPreflight implements PdhProfileDatabasePreflight {
  readonly #connector: PdhPostgresConnector;
  readonly #processEnv: NodeJS.ProcessEnv;
  readonly #cache = new Map<string, CachedEvidence>();
  readonly #creating = new Set<string>();

  constructor(
    connector: PdhPostgresConnector = defaultConnector,
    processEnv: NodeJS.ProcessEnv = process.env,
  ) {
    this.#connector = connector;
    this.#processEnv = processEnv;
  }

  async inspect(
    definition: ServiceDefinition,
    definitions: readonly ServiceDefinition[],
    refresh = false,
  ): Promise<ServiceProfileDatabaseEvidence | undefined> {
    const policy = definition.profilePolicy;
    const preflight = policy?.database.preflight;
    if (!policy || !preflight) return undefined;
    const key = profileKey(definition);
    const cached = this.#cache.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.#inspect(
      policy.database,
      profileDefinitions(definition, definitions),
    );
    this.#cache.set(key, { expiresAt: Date.now() + CACHE_MS, value });
    return value;
  }

  async assertReady(
    definition: ServiceDefinition,
    definitions: readonly ServiceDefinition[],
  ): Promise<ServiceProfileDatabaseEvidence | undefined> {
    const evidence = await this.inspect(definition, definitions, true);
    if (!evidence || evidence.state === "ready") return evidence;
    if (evidence.state === "missing") {
      throw new DevHubError(
        "PROFILE_DATABASE_MISSING",
        `发布验收数据库 ${evidence.databaseName} 不存在；已在 spawn 前阻断，未启动 keepalive 进程`,
        409,
        evidence,
      );
    }
    if (evidence.state === "uninitialized") {
      throw new DevHubError(
        "PROFILE_DATABASE_UNINITIALIZED",
        `发布验收数据库 ${evidence.databaseName} 缺少 Host/Pah 基线关系：${evidence.missingRelations?.join("、") ?? "未知"}；已在 spawn 前阻断，未启动 keepalive 进程`,
        409,
        evidence,
      );
    }
    throw new DevHubError(
      "PROFILE_DATABASE_PREFLIGHT_FAILED",
      `${evidence.message}；已在 spawn 前阻断`,
      503,
      evidence,
    );
  }

  async createIsolated(
    definition: ServiceDefinition,
    definitions: readonly ServiceDefinition[],
    confirmation: string,
  ): Promise<ServiceProfileDatabaseCreationEvidence> {
    const policy = definition.profilePolicy;
    const database = policy?.database;
    const preflight = database?.preflight;
    const creation = preflight?.creation;
    if (policy?.environmentKind !== "release-validation" || !database || !preflight || !creation) {
      throw new DevHubError(
        "PROFILE_DATABASE_CREATE_DENIED",
        "只有显式授权的 release-validation Profile 可以创建隔离数据库",
        403,
      );
    }
    if (preflight.host !== "127.0.0.1" && preflight.host !== "::1" && preflight.host !== "localhost") {
      throw new DevHubError("PROFILE_DATABASE_CREATE_DENIED", "只允许在本机 PostgreSQL 创建验收数据库", 403);
    }
    if (database.name === preflight.maintenanceDatabase || !creation.allowedDatabaseNames.includes(database.name)) {
      throw new DevHubError("PROFILE_DATABASE_CREATE_DENIED", "目标数据库未进入精确验收 allowlist", 403);
    }
    const expectedConfirmation = `create-release-validation-database:${database.name}`;
    if (confirmation !== expectedConfirmation) {
      throw new DevHubError("CONFIRMATION_REQUIRED", `确认文本必须为 ${expectedConfirmation}`, 409);
    }
    const key = profileKey(definition);
    if (this.#creating.has(key)) {
      throw new DevHubError("PROFILE_DATABASE_CREATE_BUSY", "该 Profile 正在创建隔离数据库", 409);
    }
    this.#creating.add(key);
    try {
      const before = await this.inspect(definition, definitions, true);
      if (!before || before.state === "unavailable" || before.state === "not-configured") {
        throw new DevHubError("PROFILE_DATABASE_PREFLIGHT_FAILED", before?.message ?? "数据库 preflight 不可用", 503);
      }
      if (before.exists !== false || before.state !== "missing") {
        throw new DevHubError("PROFILE_DATABASE_ALREADY_EXISTS", "目标验收数据库已存在，拒绝重复创建", 409, before);
      }
      const requestedAt = new Date().toISOString();
      const plannedEvidenceFile = this.#writeCreationEvidence(definition, {
        actionState: "planned",
        databaseName: database.name,
        server: before.server,
        existingBefore: false,
        requestedAt,
        cleanupResponsibility: creation.cleanupResponsibility,
      });
      const databaseService = profileDefinitions(definition, definitions)
        .find((candidate) => candidate.serviceRole === database.serviceRole);
      if (!databaseService) {
        throw new DevHubError("PROFILE_DATABASE_PREFLIGHT_FAILED", "找不到数据库角色服务定义", 503);
      }
      const environment = { ...this.#processEnv, ...databaseService.command.env };
      const user = environment[preflight.usernameEnv];
      if (!user) {
        throw new DevHubError(
          "PROFILE_DATABASE_PREFLIGHT_FAILED",
          `PostgreSQL preflight 缺少用户名环境变量 ${preflight.usernameEnv}`,
          503,
        );
      }
      const password = environment[preflight.passwordEnv];
      let session: PdhPostgresSession | undefined;
      try {
        session = await this.#connector({
          host: preflight.host,
          port: preflight.port,
          database: preflight.maintenanceDatabase,
          user,
          ...(password ? { password } : {}),
        });
        await session.query(`CREATE DATABASE "${database.name}"`);
      } catch (error) {
        throw new DevHubError(
          "PROFILE_DATABASE_CREATE_FAILED",
          `创建发布验收隔离数据库失败（${safeFailureCode(error)}）`,
          409,
        );
      } finally {
        await session?.end().catch(() => undefined);
      }
      this.#cache.delete(key);
      const after = await this.inspect(definition, definitions, true);
      if (!after) {
        throw new DevHubError("PROFILE_DATABASE_CREATE_UNVERIFIED", "CREATE DATABASE 已返回，但复核未取得数据库证据", 500);
      }
      if (after.exists !== true || (after.state !== "ready" && after.state !== "uninitialized")) {
        throw new DevHubError("PROFILE_DATABASE_CREATE_UNVERIFIED", "CREATE DATABASE 已返回，但复核未确认目标数据库存在", 500);
      }
      const createdAt = new Date().toISOString();
      const evidenceFile = this.#writeCreationEvidence(definition, {
        actionState: "created",
        databaseName: database.name,
        server: after.server,
        existingBefore: false,
        exists: true,
        createdAt,
        cleanupResponsibility: creation.cleanupResponsibility,
        priorEvidenceFile: plannedEvidenceFile,
      });
      return {
        ...after,
        state: after.state as "ready" | "uninitialized",
        exists: true,
        existingBefore: false,
        createdAt,
        cleanupResponsibility: creation.cleanupResponsibility,
        evidenceFile,
      };
    } finally {
      this.#creating.delete(key);
    }
  }

  #writeCreationEvidence(
    definition: ServiceDefinition,
    evidence: Readonly<Record<string, unknown>>,
  ): string {
    const outputRoot = definition.profilePolicy?.assembly?.outputRoot;
    if (!outputRoot) {
      throw new DevHubError("PROFILE_DATABASE_EVIDENCE_FAILED", "发布验收装配目录缺失，无法记录建库责任", 500);
    }
    let runtimeRoot = path.resolve(outputRoot);
    while (path.basename(runtimeRoot) !== ".runtime") {
      const parent = path.dirname(runtimeRoot);
      if (parent === runtimeRoot) {
        throw new DevHubError("PROFILE_DATABASE_EVIDENCE_FAILED", "装配目录不在 Hub .runtime 边界内", 500);
      }
      runtimeRoot = parent;
    }
    const relativeFile = path.join(
      "database-evidence",
      `${(definition.seriesId ?? definition.moduleId).replaceAll(/[^a-z0-9-]/g, "-")}--${(definition.profileId ?? "default").replaceAll(/[^a-z0-9-]/g, "-")}.json`,
    );
    const target = path.join(runtimeRoot, relativeFile);
    const temporary = `${target}.tmp`;
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    return relativeFile.replaceAll(path.sep, "/");
  }

  async #inspect(
    database: ServiceProfileDatabasePolicy,
    definitions: readonly ServiceDefinition[],
  ): Promise<ServiceProfileDatabaseEvidence> {
    const preflight = database.preflight!;
    const server = `${preflight.host}:${preflight.port}/${preflight.maintenanceDatabase}`;
    const checkedAt = new Date().toISOString();
    const databaseService = definitions.find((candidate) => candidate.serviceRole === database.serviceRole);
    if (!databaseService) {
      return {
        state: "unavailable",
        databaseName: database.name,
        server,
        exists: null,
        message: `找不到数据库角色 ${database.serviceRole} 的服务定义`,
        checkedAt,
      };
    }
    const environment = { ...this.#processEnv, ...databaseService.command.env };
    const user = environment[preflight.usernameEnv];
    const password = environment[preflight.passwordEnv];
    if (!user) {
      return {
        state: "unavailable",
        databaseName: database.name,
        server,
        exists: null,
        message: `PostgreSQL preflight 缺少用户名环境变量 ${preflight.usernameEnv}`,
        checkedAt,
      };
    }
    let session: PdhPostgresSession | undefined;
    try {
      session = await this.#connector({
        host: preflight.host,
        port: preflight.port,
        database: preflight.maintenanceDatabase,
        user,
        ...(password ? { password } : {}),
      });
      const result = await session.query(
        "SELECT current_setting('server_version') AS \"serverVersion\", EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS \"exists\"",
        [database.name],
      );
      const row = result.rows[0];
      const exists = row?.exists === true;
      const serverVersion = typeof row?.serverVersion === "string" ? row.serverVersion : "unknown";
      await session.end();
      session = undefined;
      if (!exists) {
        return {
          state: "missing",
          databaseName: database.name,
          server,
          exists: false,
          message: `PostgreSQL ${serverVersion} 可达，但隔离数据库不存在`,
          checkedAt,
        };
      }
      const requiredRelations = preflight.requiredRelations ?? [];
      if (requiredRelations.length > 0) {
        session = await this.#connector({
          host: preflight.host,
          port: preflight.port,
          database: database.name,
          user,
          ...(password ? { password } : {}),
        });
        const relations = await session.query(
          "SELECT c.relname AS \"relationName\" FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])",
          [requiredRelations],
        );
        const present = new Set(relations.rows.flatMap((item) => (
          typeof item.relationName === "string" ? [item.relationName] : []
        )));
        const missingRelations = requiredRelations.filter((relation) => !present.has(relation));
        if (missingRelations.length > 0) {
          return {
            state: "uninitialized",
            databaseName: database.name,
            server,
            exists: true,
            missingRelations,
            requiredRelationsStatus: preflight.requiredRelationsStatus,
            message: `PostgreSQL ${serverVersion} 隔离数据库存在，但缺少 ${missingRelations.length} 个 Host/Pah 基线关系`,
            checkedAt,
          };
        }
      }
      if (preflight.requiredRelationsStatus === "provisional") {
        return {
          state: "uninitialized",
          databaseName: database.name,
          server,
          exists: true,
          missingRelations: [],
          requiredRelationsStatus: "provisional",
          message: `PostgreSQL ${serverVersion} 已通过 ${requiredRelations.length} 项临时关系检查，但版本化 Host 基线清单尚未交付`,
          checkedAt,
        };
      }
      return {
        state: "ready",
        databaseName: database.name,
        server,
        exists: true,
        requiredRelationsStatus: preflight.requiredRelationsStatus,
        message: `PostgreSQL ${serverVersion} 已确认隔离数据库及 ${requiredRelations.length} 个 Host/Pah 基线关系`,
        checkedAt,
      };
    } catch (error) {
      return {
        state: "unavailable",
        databaseName: database.name,
        server,
        exists: null,
        message: `PostgreSQL preflight 失败（${safeFailureCode(error)}）`,
        checkedAt,
      };
    } finally {
      await session?.end().catch(() => undefined);
    }
  }
}
