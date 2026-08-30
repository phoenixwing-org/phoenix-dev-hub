import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(projectRoot, ".runtime");
const configCandidates = [
  "config/services.user.json",
  "config/services.json",
];
const defaultHubUrl = "http://127.0.0.1:42100";
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const idPattern = /^[a-z][a-z0-9-]{1,63}$/;
const usernamePattern = /^[A-Za-z0-9._@-]{1,20}$/u;

function fail(message) {
  throw new Error(message);
}

export function resolveConfigPath(root, exists = fs.existsSync) {
  const candidate = configCandidates
    .map(relativePath => path.join(root, relativePath))
    .find(exists);
  if (!candidate) {
    fail("未找到用户服务配置：请先从 config/sample/services.sample.json 创建 config/services.user.json");
  }
  return candidate;
}

export function parseArgs(argv) {
  const result = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    if (!["--profile", "--username", "--node-root", "--secret"].includes(argument)) {
      fail(`不支持参数：${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} 缺少值`);
    const key = {
      "--profile": "profileId",
      "--username": "username",
      "--node-root": "nodeRoot",
      "--secret": "secretPath",
    }[argument];
    if (result[key] !== undefined) fail(`${argument} 不能重复`);
    result[key] = value;
    index += 1;
  }
  if (result.help) return result;
  if (!result.profileId || !idPattern.test(result.profileId)) {
    fail("必须提供合法的 --profile");
  }
  if (!result.username || !usernamePattern.test(result.username)) {
    fail("必须提供 1～20 位安全字符组成的 --username");
  }
  return result;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} 必须是对象`);
  }
}

export function selectReleaseProfile(document, profileId) {
  assertObject(document, "服务配置");
  if (document.version !== 2 || !Array.isArray(document.series)) {
    fail("服务配置必须是 version 2 Series/Profile 格式");
  }
  const matches = [];
  for (const series of document.series) {
    if (!Array.isArray(series.profiles)) continue;
    for (const profile of series.profiles) {
      if (profile.id === profileId) matches.push({ series, profile });
    }
  }
  if (matches.length !== 1) fail(`Profile ${profileId} 必须全局唯一`);
  const { series, profile } = matches[0];
  const policy = profile.policy;
  const database = policy?.database;
  const preflight = database?.preflight;
  const creation = preflight?.creation;
  if (
    policy?.environmentKind !== "release-validation" ||
    policy.deploymentMode !== "package-assembled"
  ) {
    fail("只允许 package-assembled 的 release-validation Profile");
  }
  if (
    !database?.name ||
    !preflight ||
    !loopbackHosts.has(preflight.host) ||
    !Number.isInteger(preflight.port) ||
    !creation?.allowedDatabaseNames?.includes(database.name) ||
    database.forbiddenNames?.includes(database.name)
  ) {
    fail("Profile 缺少精确的本机隔离数据库安全锚点");
  }
  const services = [];
  for (const [role, override] of Object.entries(profile.services ?? {})) {
    if (override === false) continue;
    assertObject(override, `Profile ${profileId} 服务 ${role}`);
    const baseline = series.template?.services?.[role] ?? {};
    const service = { ...baseline, ...override };
    if (!service.id || !idPattern.test(service.id)) fail(`服务 ${role} 缺少稳定 id`);
    const endpoints = override.endpoints ?? baseline.endpoints;
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      fail(`服务 ${service.id} 缺少固定端点`);
    }
    services.push({ id: service.id, ports: endpoints.map(endpoint => endpoint.port) });
  }
  if (services.length === 0) fail(`Profile ${profileId} 没有服务`);
  return { seriesId: series.id, profileId, profile, database, preflight, services };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveSecretPath(profileId, requestedPath) {
  const candidate = path.resolve(
    projectRoot,
    requestedPath ?? path.join(".runtime", `admin-${profileId}-login.secret.env`),
  );
  const realRuntime = fs.realpathSync(runtimeRoot);
  const realParent = fs.realpathSync(path.dirname(candidate));
  if (!isWithin(realRuntime, realParent)) fail("secret 只能位于 Hub .runtime 目录");
  return candidate;
}

function resolveNodeRoot(requestedPath) {
  const candidate = path.resolve(projectRoot, requestedPath ?? "../phoenix-admin-node");
  const realRoot = fs.realpathSync(candidate);
  if (!fs.statSync(realRoot).isDirectory()) fail("Admin Node root 不是目录");
  const packageDocument = JSON.parse(fs.readFileSync(path.join(realRoot, "package.json"), "utf8"));
  if (
    packageDocument.name !== "phoenix-admin-node" ||
    typeof packageDocument.scripts?.["host:baseline"] !== "string" ||
    !fs.existsSync(path.join(realRoot, "scripts/pah-host-baseline.cjs"))
  ) {
    fail("Admin Node root 不具备 Host baseline 工具");
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: realRoot, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: realRoot, encoding: "utf8" });
  if (head.status !== 0 || dirty.status !== 0 || dirty.stdout.trim()) {
    fail("Admin Node 必须是可识别的 clean Git 工作树");
  }
  return realRoot;
}

export function readSecret(content) {
  const result = new Map();
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) fail("secret 格式不合法");
    const key = line.slice(0, separator);
    if (result.has(key)) fail(`secret 字段重复：${key}`);
    result.set(key, line.slice(separator + 1));
  }
  return result;
}

export function updateSecretContent(original, username, password, now = new Date()) {
  const replacements = new Map([
    ["PAH_HOST_BASELINE_ADMIN_USERNAME", username],
    ["PAH_HOST_BASELINE_ADMIN_PASSWORD", password],
    ["PAH_HOST_BASELINE_SECRET_CREATED_AT", now.toISOString()],
  ]);
  const seen = new Set();
  const updated = original
    .split(/(\r?\n)/)
    .map(part => {
      const separator = part.indexOf("=");
      if (separator <= 0) return part;
      const key = part.slice(0, separator);
      if (!replacements.has(key)) return part;
      seen.add(key);
      return `${key}=${replacements.get(key)}`;
    })
    .join("");
  if (seen.size !== replacements.size) fail("secret 缺少用户名、密码或创建时间字段");
  return updated;
}

function readPassword() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    fail("请在交互式终端中运行");
  }
  process.stdout.write("请输入新的管理员密码（12～20 位，不回显）：");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let password = "";
    const finish = error => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(password);
    };
    const onData = input => {
      for (const character of input) {
        if (character === "\u0003") return finish(new Error("已取消"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") password = password.slice(0, -1);
        else password += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

export function assertServicesStopped(statuses, serviceIds) {
  const byId = new Map(statuses.map(status => [status.definition?.id, status]));
  for (const id of serviceIds) {
    const status = byId.get(id);
    if (
      !status ||
      status.lifecycle !== "stopped" ||
      status.ownership !== "none" ||
      status.managed !== false
    ) {
      fail(`服务 ${id} 必须先通过 Hub 完全停止`);
    }
  }
}

async function readHubServices(profile) {
  const hubUrl = new URL(process.env.PHOENIX_HUB_URL ?? defaultHubUrl);
  if (!loopbackHosts.has(hubUrl.hostname) || !["http:", "https:"].includes(hubUrl.protocol)) {
    fail("Hub URL 必须是本机 HTTP(S) 地址");
  }
  const response = await fetch(new URL("/api/services", hubUrl), {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) fail(`Hub 服务状态读取失败：HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.services)) fail("Hub 服务状态格式不合法");
  assertServicesStopped(body.services, profile.services.map(service => service.id));
}

function portIsListening(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = value => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function assertPortsStopped(profile) {
  const ports = [...new Set(profile.services.flatMap(service => service.ports))];
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) fail("Profile 端口不合法");
    if (await portIsListening(port)) fail(`端口 ${port} 仍在监听，拒绝重置管理员`);
  }
}

function runBaseline(nodeRoot, command, env) {
  const result = spawnSync("pnpm", ["run", "host:baseline", "--", command], {
    cwd: nodeRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const digest = createHash("sha256").update(result.stderr || "").digest("hex").slice(0, 12);
    fail(`${command.toUpperCase()}_FAILED_${digest}`);
  }
  const start = result.stdout.indexOf("{");
  if (start < 0) fail(`${command.toUpperCase()}_OUTPUT_INVALID`);
  return JSON.parse(result.stdout.slice(start));
}

function allOne(value) {
  return value && Object.values(value).every(count => count === 1);
}

function allZero(value) {
  return value && Object.values(value).every(count => count === 0);
}

function updateSecret(secretPath, original, username, password) {
  const updated = updateSecretContent(original, username, password);
  const tempPath = path.join(
    path.dirname(secretPath),
    `.${path.basename(secretPath)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    fs.writeFileSync(tempPath, updated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(tempPath, 0o600);
    if ((fs.statSync(tempPath).mode & 0o777) !== 0o600) fail("临时 secret 权限不是 0600");
    fs.renameSync(tempPath, secretPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function usage() {
  process.stdout.write(
    "用法：pnpm admin:release:reset -- --profile <id> --username <name> [--node-root <path>] [--secret <.runtime/path>]\n",
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return usage();
  const configPath = resolveConfigPath(projectRoot);
  const document = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const profile = selectReleaseProfile(document, options.profileId);
  const secretPath = resolveSecretPath(profile.profileId, options.secretPath);
  const nodeRoot = resolveNodeRoot(options.nodeRoot);

  await readHubServices(profile);
  await assertPortsStopped(profile);

  const secretStat = fs.statSync(secretPath);
  if (!secretStat.isFile() || (secretStat.mode & 0o777) !== 0o600) {
    fail("secret 必须是 mode 0600 普通文件");
  }
  const original = fs.readFileSync(secretPath, "utf8");
  const values = readSecret(original);
  const currentUsername = values.get("PAH_HOST_BASELINE_ADMIN_USERNAME");
  if (!currentUsername) fail("secret 中缺少管理员用户名");

  const password = await readPassword();
  if (password.length < 12 || password.length > 20) fail("密码长度必须为 12～20 位");

  const databaseUsername = process.env[profile.preflight.usernameEnv];
  if (!databaseUsername) fail(`缺少数据库用户名环境变量 ${profile.preflight.usernameEnv}`);
  const env = {
    ...process.env,
    PAH_HOST_BASELINE_ENVIRONMENT: "release-validation",
    PAH_HOST_BASELINE_DB_HOST: profile.preflight.host,
    PAH_HOST_BASELINE_DB_PORT: String(profile.preflight.port),
    PAH_HOST_BASELINE_DB_USERNAME: databaseUsername,
    PAH_HOST_BASELINE_DB_DATABASE: profile.database.name,
    PAH_HOST_BASELINE_ALLOWED_DATABASE: profile.database.name,
    PAH_HOST_BASELINE_SOURCE_REPOSITORY: nodeRoot,
    PAH_HOST_BASELINE_ADMIN_CURRENT_USERNAME: currentUsername,
    PAH_HOST_BASELINE_ADMIN_NEW_USERNAME: options.username,
    PAH_HOST_BASELINE_ADMIN_NEW_PASSWORD: password,
  };
  const passwordEnv = profile.preflight.passwordEnv;
  if (passwordEnv && process.env[passwordEnv]) {
    env.PAH_HOST_BASELINE_DB_PASSWORD = process.env[passwordEnv];
  }
  delete env.PAH_HOST_BASELINE_CONFIRMATION;

  const plan = runBaseline(nodeRoot, "reset-admin-plan", env);
  if (
    plan.action !== "reset-admin" ||
    plan.databaseState !== "baseline-ready" ||
    !plan.adminRelationsReady ||
    !plan.currentUsernameMatches ||
    !plan.targetUsernameAvailable ||
    !allOne(plan.adminRelations) ||
    !allZero(plan.pluginLedger) ||
    !plan.confirmation
  ) {
    fail("安全检查未通过，未修改管理员");
  }

  const applied = runBaseline(nodeRoot, "reset-admin", {
    ...env,
    PAH_HOST_BASELINE_CONFIRMATION: plan.confirmation,
  });
  if (
    applied.userId !== 1 ||
    applied.updated !== true ||
    !Number.isInteger(applied.passwordVersion) ||
    !allOne(applied.adminRelations) ||
    !allZero(applied.pluginLedger)
  ) {
    fail("数据库重置结果校验失败");
  }

  updateSecret(secretPath, original, options.username, password);
  process.stdout.write(
    `管理员已受控重置，passwordVersion=${applied.passwordVersion}，secret 保持 0600。\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`重置失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
