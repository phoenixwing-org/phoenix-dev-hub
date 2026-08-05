import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectManifest = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const expectedVersion = projectManifest.dependencies?.["phoenix-wing"];
if (typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  throw new Error("phoenix-wing 必须在 dependencies 中使用精确版本号");
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

process.stdout.write(`Wing Registry 版本门禁通过：phoenix-wing@${expectedVersion}\n`);
