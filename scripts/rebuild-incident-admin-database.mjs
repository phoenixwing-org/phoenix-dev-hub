import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(projectRoot, ".runtime");
const incidentRoot = path.join(runtimeRoot, "incidents");
const backupRoot = path.join(runtimeRoot, "backups", "environment-owner");
const evidenceRoot = path.join(runtimeRoot, "evidence", "environment-owner");
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const databasePattern = /^[a-z][a-z0-9_]{2,62}$/u;
const incidentPattern = /^[a-z0-9][a-z0-9-]{2,127}$/u;

function fail(message) {
  throw new Error(message);
}

function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if ((fs.statSync(directory).mode & 0o777) !== 0o700) {
    fail(`目录权限不是 0700：${directory}`);
  }
}

function privateFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) fail(`不是普通文件：${file}`);
  fs.chmodSync(file, 0o600);
  if ((fs.statSync(file).mode & 0o777) !== 0o600) {
    fail(`文件权限不是 0600：${file}`);
  }
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    const digest = createHash("sha256")
      .update(`${result.stderr ?? ""}${result.stdout ?? ""}`)
      .digest("hex")
      .slice(0, 12);
    fail(`${options.label ?? executable}_FAILED_${digest}`);
  }
  return result.stdout ?? "";
}

function parseJsonOutput(output, label) {
  const start = output.indexOf("{");
  if (start < 0) fail(`${label}_OUTPUT_INVALID`);
  return JSON.parse(output.slice(start));
}

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--" && index === 0) continue;
    if (key === "--help" || key === "-h") return { help: true };
    if (!["--incident", "--database", "--node-root", "--confirmation"].includes(key)) {
      fail(`不支持参数：${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} 缺少值`);
    const name = {
      "--incident": "incidentId",
      "--database": "databaseName",
      "--node-root": "nodeRoot",
      "--confirmation": "confirmation",
    }[key];
    if (result[name]) fail(`${key} 不能重复`);
    result[name] = value;
    index += 1;
  }
  if (!incidentPattern.test(result.incidentId ?? "")) fail("必须提供合法的 --incident");
  if (!databasePattern.test(result.databaseName ?? "")) fail("必须提供合法的 --database");
  const expected = `rebuild-incident-database:${result.incidentId}:${result.databaseName}`;
  if (result.confirmation !== expected) fail(`确认文本必须为 ${expected}`);
  return result;
}

export function assertIncidentScope(incident, options) {
  if (incident.incidentId !== options.incidentId) fail("incidentId 与文件内容不一致");
  if (incident.status !== "contained-pending-environment-owner-audit") {
    fail("incident 当前状态不允许重建");
  }
  const actualDatabase =
    incident.actual?.database?.name ??
    incident.actual?.databaseName ??
    incident.environmentAudit?.applicationDefaultsObservedInFrozenAssembly?.database;
  if (actualDatabase !== options.databaseName) fail("incident 实际数据库与目标不一致");
  if (options.databaseName !== "phoenix_admin") {
    fail("本工具只允许重建 incident 明确涉及的 phoenix_admin");
  }
}

export function assertProtectedDatabases(target) {
  const protectedNames = new Set([
    "phoenix_admin_development",
    "phoenix_admin_bom_install_validation",
    "phoenix_admin_bom_restore_validation",
    "phoenix_admin_clean_validation_20260805",
    "phoenix_admin_preproduction",
    "phoenix_admin_production",
    "postgres",
    "template0",
    "template1",
  ]);
  if (protectedNames.has(target)) fail(`受保护数据库禁止重建：${target}`);
}

export function assertServiceStatuses(statuses, targetDatabase) {
  const consumers = statuses.filter(status =>
    status.definition?.command?.env?.PAH_DB_DATABASE === targetDatabase
  );
  if (consumers.length === 0) fail("Hub 中找不到目标数据库消费者，拒绝脱离服务所有权重建");
  for (const status of consumers) {
    if (
      status.lifecycle !== "stopped" ||
      status.ownership !== "none" ||
      status.managed !== false
    ) {
      fail(`目标数据库消费者 ${status.definition.id} 尚未由 Hub 完全停止`);
    }
  }
  return consumers.map(status => status.definition.id).sort();
}

function resolveIncidentFile(incidentId) {
  const exact = path.join(incidentRoot, `${incidentId}.json`);
  if (fs.existsSync(exact)) return exact;
  const matches = fs
    .readdirSync(incidentRoot)
    .filter(name => name.endsWith(".json"))
    .map(name => path.join(incidentRoot, name))
    .filter(file => JSON.parse(fs.readFileSync(file, "utf8")).incidentId === incidentId);
  if (matches.length !== 1) fail(`无法唯一定位 incident：${incidentId}`);
  return matches[0];
}

function resolveNodeRoot(requested) {
  const candidate = fs.realpathSync(path.resolve(projectRoot, requested ?? "../phoenix-admin-node"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
  if (packageJson.name !== "phoenix-admin-node" || !packageJson.scripts?.["host:baseline"]) {
    fail("Admin Node root 不具备 Host baseline 工具");
  }
  const dirty = run("git", ["status", "--porcelain"], { cwd: candidate, label: "NODE_STATUS" });
  if (dirty.trim()) fail("Admin Node 必须是 clean Git 工作树");
  return candidate;
}

async function readHubServices() {
  const hubUrl = new URL(process.env.PHOENIX_HUB_URL ?? "http://127.0.0.1:42100");
  if (!loopbackHosts.has(hubUrl.hostname) || !["http:", "https:"].includes(hubUrl.protocol)) {
    fail("Hub URL 必须是本机 HTTP(S)");
  }
  const response = await fetch(new URL("/api/services", hubUrl), {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) fail(`Hub 服务状态读取失败：HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.services)) fail("Hub 服务状态格式不合法");
  return body.services;
}

function postgresArgs(databaseName) {
  const host = process.env.PAH_DB_HOST ?? "127.0.0.1";
  const port = process.env.PAH_DB_PORT ?? "5432";
  const username = process.env.PAH_DB_USERNAME ?? process.env.USER;
  if (!loopbackHosts.has(host) || !/^\d{1,5}$/u.test(port) || !username) {
    fail("PostgreSQL 必须是本机、固定端口且具备显式用户名");
  }
  return ["--host", host, "--port", port, "--username", username, "--dbname", databaseName];
}

function psqlScalar(databaseName, sql) {
  return run("psql", [...postgresArgs(databaseName), "--no-psqlrc", "--tuples-only", "--no-align", "--command", sql], {
    label: "PSQL",
  }).trim();
}

function assertDatabaseIdentity(databaseName) {
  const identity = psqlScalar(
    databaseName,
    "SELECT current_database() || '|' || current_setting('server_version_num') || '|' || host(inet_server_addr());",
  ).split("|");
  if (identity[0] !== databaseName || !identity[1]?.startsWith("16") || !loopbackHosts.has(identity[2])) {
    fail("数据库身份不是精确本机 PostgreSQL 16 目标");
  }
  return { databaseName: identity[0], serverVersionNum: Number(identity[1]), serverAddress: identity[2] };
}

function assertNoForeignSessions(databaseName) {
  const count = Number(psqlScalar(
    "postgres",
    `SELECT count(*) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid();`,
  ));
  if (count !== 0) fail(`目标数据库仍有 ${count} 个外部会话`);
}

function dump(databaseName, file, args) {
  run("pg_dump", [...postgresArgs(databaseName), ...args, "--file", file], { label: "PG_DUMP" });
  privateFile(file);
  return { path: file, size: fs.statSync(file).size, sha256: sha256File(file), mode: "0600" };
}

export function normalizePgDumpSchema(content) {
  return content
    .replace(/^\\restrict [A-Za-z0-9]+$/gmu, "\\restrict <normalized>")
    .replace(/^\\unrestrict [A-Za-z0-9]+$/gmu, "\\unrestrict <normalized>");
}

function fingerprints(databaseName, directory, prefix) {
  const schema = dump(databaseName, path.join(directory, `${prefix}.schema.sql`), [
    "--schema-only", "--no-owner", "--no-privileges",
  ]);
  const normalizedSchema = normalizePgDumpSchema(fs.readFileSync(schema.path, "utf8"));
  fs.unlinkSync(schema.path);
  const tables = JSON.parse(
    psqlScalar(
      databaseName,
      "SELECT COALESCE(json_agg(json_build_array(schemaname, tablename) ORDER BY schemaname, tablename), '[]'::json)::text FROM pg_tables WHERE schemaname = 'public';",
    ) || "[]",
  );
  const tableFingerprints = tables.map(([schemaName, tableName]) => {
    if (
      typeof schemaName !== "string" ||
      typeof tableName !== "string" ||
      schemaName.length === 0 ||
      tableName.length === 0 ||
      schemaName.includes("\0") ||
      tableName.includes("\0")
    ) {
      fail("数据库包含无法安全引用的 public relation");
    }
    const quoteIdentifier = value => `"${value.replaceAll('"', '""')}"`;
    const qualified = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
    const rows = run("psql", [
      ...postgresArgs(databaseName),
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--command",
      `COPY (SELECT row_to_json(source_row)::text FROM ${qualified} AS source_row ORDER BY row_to_json(source_row)::text) TO STDOUT;`,
    ], { label: "PSQL_DATA_FINGERPRINT" });
    return {
      relation: `${schemaName}.${tableName}`,
      rows: Number(psqlScalar(databaseName, `SELECT count(*) FROM ${qualified};`)),
      sha256: createHash("sha256").update(rows).digest("hex"),
    };
  });
  const sequenceState = psqlScalar(
    databaseName,
    "SELECT COALESCE(json_agg(row_to_json(sequence_row) ORDER BY schemaname, sequencename), '[]'::json)::text FROM (SELECT schemaname, sequencename, last_value, start_value, increment_by, min_value, max_value, cache_size, cycle FROM pg_sequences WHERE schemaname = 'public') AS sequence_row;",
  ) || "[]";
  const dataDocument = JSON.stringify({ tables: tableFingerprints, sequences: JSON.parse(sequenceState) });
  return {
    schema: {
      size: Buffer.byteLength(normalizedSchema),
      sha256: createHash("sha256").update(normalizedSchema).digest("hex"),
    },
    data: {
      tables: tableFingerprints.length,
      rows: tableFingerprints.reduce((total, table) => total + table.rows, 0),
      sequences: JSON.parse(sequenceState).length,
      sha256: createHash("sha256").update(dataDocument).digest("hex"),
    },
  };
}

function restoreArchive(databaseName, archive, directory, serverVersionNum) {
  const sqlFile = path.join(directory, "restore-rehearsal.sql");
  try {
    run("pg_restore", [
      "--no-owner",
      "--no-privileges",
      "--file",
      sqlFile,
      archive,
    ], { label: "PG_RESTORE_RENDER" });
    privateFile(sqlFile);
    if (Math.floor(serverVersionNum / 10_000) < 17) {
      const unsupported = "SET transaction_timeout = 0;";
      const content = fs.readFileSync(sqlFile, "utf8");
      const occurrences = content.split(unsupported).length - 1;
      if (occurrences !== 1) {
        fail("PG17_TO_PG16_TRANSACTION_TIMEOUT_GUARD_FAILED");
      }
      fs.writeFileSync(sqlFile, content.replace(`${unsupported}\n`, ""), {
        encoding: "utf8",
        mode: 0o600,
      });
      privateFile(sqlFile);
    }
    run("psql", [
      ...postgresArgs(databaseName),
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--single-transaction",
      "--file",
      sqlFile,
    ], { label: "PSQL_RESTORE_REHEARSAL" });
  } finally {
    if (fs.existsSync(sqlFile)) fs.unlinkSync(sqlFile);
  }
}

function createDatabase(databaseName) {
  run("createdb", postgresArgs("postgres").slice(0, -2).concat(databaseName), { label: "CREATEDB" });
}

function dropDatabase(databaseName) {
  run("dropdb", postgresArgs("postgres").slice(0, -2).concat(databaseName), { label: "DROPDB" });
}

function runBaseline(nodeRoot, command, databaseName, confirmation) {
  const env = {
    ...process.env,
    PAH_HOST_BASELINE_ENVIRONMENT: "release-validation",
    PAH_HOST_BASELINE_DB_HOST: process.env.PAH_DB_HOST ?? "127.0.0.1",
    PAH_HOST_BASELINE_DB_PORT: process.env.PAH_DB_PORT ?? "5432",
    PAH_HOST_BASELINE_DB_USERNAME: process.env.PAH_DB_USERNAME ?? process.env.USER,
    PAH_HOST_BASELINE_DB_DATABASE: databaseName,
    PAH_HOST_BASELINE_ALLOWED_DATABASE: databaseName,
    PAH_HOST_BASELINE_SOURCE_REPOSITORY: nodeRoot,
  };
  if (confirmation) env.PAH_HOST_BASELINE_CONFIRMATION = confirmation;
  const output = run("pnpm", ["run", "host:baseline", "--", command], {
    cwd: nodeRoot,
    env,
    label: `HOST_BASELINE_${command.toUpperCase()}`,
  });
  return parseJsonOutput(output, command.toUpperCase());
}

function writeJson0600(file, value) {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  privateFile(file);
}

function usage() {
  process.stdout.write(
    "用法：pnpm admin:incident:rebuild -- --incident <id> --database phoenix_admin --confirmation rebuild-incident-database:<id>:phoenix_admin [--node-root <path>]\n",
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return usage();
  assertProtectedDatabases(options.databaseName);
  const incidentFile = resolveIncidentFile(options.incidentId);
  const incident = JSON.parse(fs.readFileSync(incidentFile, "utf8"));
  assertIncidentScope(incident, options);
  const nodeRoot = resolveNodeRoot(options.nodeRoot);
  const nodeCommit = run("git", ["rev-parse", "HEAD"], { cwd: nodeRoot, label: "NODE_HEAD" }).trim();
  const hubCommit = run("git", ["rev-parse", "HEAD"], { cwd: projectRoot, label: "HUB_HEAD" }).trim();
  const serviceIds = assertServiceStatuses(await readHubServices(), options.databaseName);
  const identityBefore = assertDatabaseIdentity(options.databaseName);
  assertNoForeignSessions(options.databaseName);

  const runId = `${options.incidentId}-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const backupDirectory = path.join(backupRoot, runId);
  const evidenceDirectory = path.join(evidenceRoot, runId);
  ensurePrivateDirectory(backupDirectory);
  ensurePrivateDirectory(evidenceDirectory);
  const backup = dump(options.databaseName, path.join(backupDirectory, `${options.databaseName}.dump`), [
    "--format", "custom", "--no-owner", "--no-privileges",
  ]);
  const before = fingerprints(options.databaseName, evidenceDirectory, "before");

  const rehearsalDatabase = `phoenix_admin_incident_rehearsal_${randomBytes(5).toString("hex")}`;
  if (psqlScalar("postgres", `SELECT count(*) FROM pg_database WHERE datname = '${rehearsalDatabase}';`) !== "0") {
    fail("恢复演练数据库已存在");
  }
  try {
    createDatabase(rehearsalDatabase);
    restoreArchive(
      rehearsalDatabase,
      backup.path,
      evidenceDirectory,
      identityBefore.serverVersionNum,
    );
    const rehearsal = fingerprints(rehearsalDatabase, evidenceDirectory, "rehearsal");
    if (rehearsal.schema.sha256 !== before.schema.sha256 || rehearsal.data.sha256 !== before.data.sha256) {
      fail(
        `恢复演练指纹不一致：schema=${rehearsal.schema.sha256 === before.schema.sha256} data=${rehearsal.data.sha256 === before.data.sha256}`,
      );
    }
  } finally {
    if (psqlScalar("postgres", `SELECT count(*) FROM pg_database WHERE datname = '${rehearsalDatabase}';`) === "1") {
      assertNoForeignSessions(rehearsalDatabase);
      dropDatabase(rehearsalDatabase);
    }
  }

  assertNoForeignSessions(options.databaseName);
  dropDatabase(options.databaseName);
  createDatabase(options.databaseName);
  const plan = runBaseline(nodeRoot, "plan", options.databaseName);
  if (plan.action !== "apply" || plan.databaseState !== "empty" || !plan.confirmation) {
    fail("重建空库未取得 Host baseline apply 计划");
  }
  runBaseline(nodeRoot, "apply", options.databaseName, plan.confirmation);
  const verified = runBaseline(nodeRoot, "verify", options.databaseName);
  if (verified.action !== "noop" || verified.databaseState !== "baseline-ready") {
    fail("Host baseline 重建后验证失败");
  }
  const after = fingerprints(options.databaseName, evidenceDirectory, "after");
  const completedAt = new Date().toISOString();
  const evidenceFile = path.join(evidenceDirectory, "rebuild-evidence.json");
  writeJson0600(evidenceFile, {
    formatVersion: 1,
    action: "environment-owner-controlled-rebuild",
    incidentId: options.incidentId,
    status: "rebuilt-and-verified",
    database: identityBefore,
    protectedDatabasesUntouched: [
      "phoenix_admin_development",
      "phoenix_admin_bom_install_validation",
      "phoenix_admin_bom_restore_validation",
    ],
    stoppedConsumers: serviceIds,
    nodeCommit,
    hubCommit,
    backup,
    before,
    restoreRehearsal: { passed: true, databaseReclaimed: true },
    hostBaseline: {
      version: verified.baselineVersion,
      sourceCommit: verified.sourceCommit,
      requiredRelations: verified.requiredRelations,
      expectedSchema: verified.expectedSchema,
    },
    after,
    completedAt,
  });
  incident.status = "rebuilt-and-verified";
  incident.environmentOwnerResolution = {
    action: "controlled-backup-restore-rehearsal-rebuild",
    completedAt,
    databaseName: options.databaseName,
    nodeCommit,
    hubCommit,
    evidenceFile,
    evidenceSha256: sha256File(evidenceFile),
    backupFile: backup.path,
    backupSha256: backup.sha256,
    restoreRehearsal: "passed",
    hostBaselineVersion: verified.baselineVersion,
    hostBaselineSchemaSha256: verified.expectedSchema.sha256,
  };
  writeJson0600(incidentFile, incident);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      incidentId: options.incidentId,
      status: incident.status,
      databaseName: options.databaseName,
      backup: { path: backup.path, size: backup.size, sha256: backup.sha256, mode: backup.mode },
      restoreRehearsal: "passed",
      hostBaselineVersion: verified.baselineVersion,
      relations: verified.requiredRelations.length,
      evidenceFile,
      evidenceMode: "0600",
    }, null, 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`重建失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
