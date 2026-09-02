import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectManifest = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const baseline = JSON.parse(
  readFileSync(path.join(projectRoot, "config/wing-registry-baseline.json"), "utf8"),
);
const expectedVersion = projectManifest.dependencies?.["phoenix-wing"];
const expectedLabel = `Registry ${baseline.version}=${baseline.source?.commit?.slice(0, 7) ?? ""}`;
if (typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  throw new Error("phoenix-wing 必须在 dependencies 中使用精确版本号");
}
if (
  baseline.package !== "phoenix-wing"
  || baseline.version !== expectedVersion
  || baseline.registryTag !== "latest"
  || baseline.label !== expectedLabel
  || baseline.source?.branch !== "develop"
  || !/^[0-9a-f]{40}$/.test(baseline.source?.commit ?? "")
  || !/^[0-9a-f]{40}$/.test(baseline.dist?.shasum ?? "")
  || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(baseline.dist?.integrity ?? "")
) {
  throw new Error("Wing Registry 发布基线缺失或与 package.json 精确版本不一致");
}
if (projectManifest.overrides || projectManifest.pnpm?.overrides) {
  throw new Error("Hub 正式依赖禁止使用 overrides");
}

const lockfile = readFileSync(path.join(projectRoot, "pnpm-lock.yaml"), "utf8");
const escapedVersion = escapeRegExp(expectedVersion);
const escapedIntegrity = escapeRegExp(baseline.dist.integrity);
if (!new RegExp(
  `\\n      phoenix-wing:\\n        specifier: ${escapedVersion}\\n        version: ${escapedVersion}(?:\\(|\\n)`,
).test(lockfile)) {
  throw new Error(`pnpm-lock.yaml 未锁定 phoenix-wing importer ${expectedVersion}`);
}
if (!new RegExp(
  `\\n  phoenix-wing@${escapedVersion}:\\n    resolution: \\{integrity: ${escapedIntegrity}\\}`,
).test(lockfile)) {
  throw new Error(`pnpm-lock.yaml 的 phoenix-wing@${expectedVersion} integrity 与发布基线不一致`);
}
if (/phoenix-wing:\s*\n\s+specifier:\s*(?:link:|file:|workspace:)/.test(lockfile)) {
  throw new Error("Hub 正式 lock 禁止 phoenix-wing 使用 link:/file:/workspace: 协议");
}

const manifestPath = path.join(projectRoot, "node_modules/phoenix-wing/package.json");
if (!existsSync(manifestPath)) {
  throw new Error("Wing Registry 包尚未安装，请先运行 pnpm install");
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entryPath = path.resolve(path.dirname(manifestPath), manifest.main ?? "dist/index.js");
const entrySource = readFileSync(entryPath, "utf8");
const pnwVersion = entrySource.match(
  /\b(?:const|let|var)\s+PNW_VERSION\s*=\s*(["'])([^"']+)\1/,
)?.[2];
if (manifest.version !== expectedVersion || pnwVersion !== expectedVersion) {
  throw new Error(
    `Wing Registry 版本门禁失败：期望 package.json/PNW_VERSION 均为 ${expectedVersion}，实际 ${manifest.version}/${pnwVersion ?? "未导出"}`,
  );
}

const installedRoot = realpathSync(path.dirname(manifestPath));
const nodeModulesRoot = realpathSync(path.join(projectRoot, "node_modules"));
const relativeInstallPath = path.relative(nodeModulesRoot, installedRoot);
if (relativeInstallPath.startsWith("..") || path.isAbsolute(relativeInstallPath)) {
  throw new Error(`Wing 安装 realpath 不属于 Hub node_modules：${installedRoot}`);
}
const adjacentDist = path.resolve(projectRoot, "../phoenix-wing/dist");
if (installedRoot === adjacentDist || installedRoot.startsWith(`${adjacentDist}${path.sep}`)) {
  throw new Error(`Hub 正式依赖错误解析到相邻 Wing dist：${installedRoot}`);
}

process.stdout.write(
  `Wing Registry 门禁通过：${baseline.label}；source=${baseline.source.commit}；shasum=${baseline.dist.shasum}；realpath=${installedRoot}\n`,
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
