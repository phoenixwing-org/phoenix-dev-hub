import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "./api.js";
import { loadServiceConfiguration } from "./config.js";
import { PdhAdminPluginWorkspace } from "./PdhAdminPluginWorkspace.js";
import { PdhBuiltinServiceConfigStore } from "./PdhBuiltinServiceConfig.js";
import { PdhProjectConfigStore } from "./PdhProjectConfig.js";
import { PdhServiceManager } from "./PdhServiceManager.js";
import { PdhSystemTerminal } from "./PdhSystemTerminal.js";
import { serveStatic } from "./staticFiles.js";

function isProjectRoot(candidate: string): boolean {
  const manifestPath = path.join(candidate, "package.json");
  if (!existsSync(manifestPath)) return false;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")).name === "phoenix-dev-hub";
  } catch {
    return false;
  }
}

function findProjectRoot(): string {
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let current = path.resolve(start);
    while (true) {
      if (isProjectRoot(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error("无法定位 phoenix-dev-hub 项目根目录");
}

const projectRoot = findProjectRoot();
const packageManifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
  version?: string;
};
const host = "127.0.0.1";
const port = Number(process.env.PHOENIX_DEV_HUB_PORT ?? 42_100);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PHOENIX_DEV_HUB_PORT 不合法");

const projectConfig = new PdhProjectConfigStore(projectRoot);
const loadedServiceConfiguration = loadServiceConfiguration(projectRoot);
const configurationWarnings = new Map<string, string[]>();
for (const warning of loadedServiceConfiguration.configurationErrors ?? []) {
  configurationWarnings.set(warning, ["服务配置文件"]);
}
for (const definition of loadedServiceConfiguration.definitions) {
  for (const warning of definition.configurationErrors ?? []) {
    configurationWarnings.set(warning, [
      ...(configurationWarnings.get(warning) ?? []),
      definition.name,
    ]);
  }
}
for (const [warning, affectedServices] of configurationWarnings) {
  process.stderr.write(`服务配置警告：${warning}（影响：${affectedServices.join("、")}）\n`);
}
const builtinServiceConfig = new PdhBuiltinServiceConfigStore(projectRoot, loadedServiceConfiguration);
const initialBuiltinDefinitions = builtinServiceConfig.effectiveDefinitions();
const adminPluginWorkspace = new PdhAdminPluginWorkspace(projectRoot, {
  adminWebRoot: initialBuiltinDefinitions.find((definition) => definition.id === "admin-web")?.cwd,
  adminNodeRoot: initialBuiltinDefinitions.find((definition) => definition.id === "admin-api")?.cwd,
});
const manager = new PdhServiceManager([
  ...initialBuiltinDefinitions,
  ...projectConfig.serviceDefinitions(),
], new PdhSystemTerminal());
manager.setConfigurationErrors(loadedServiceConfiguration.configurationErrors ?? []);
const handleApi = createApiHandler(
  manager,
  projectConfig,
  builtinServiceConfig,
  adminPluginWorkspace,
  {
    projectRoot,
    version: packageManifest.version ?? "unknown",
    address: `http://${host}:${port}`,
    requestShutdown: () => void shutdown("网页请求"),
  },
);
const development = process.env.NODE_ENV !== "production";
const vite = development
  ? await import("vite").then(({ createServer: createViteServer }) => createViteServer({
      root: projectRoot,
      appType: "spa",
      // 后端由 tsx watch 负责重载；独立 HMR WebSocket 会在快速重载时遗留 24678 端口竞争。
      server: { middlewareMode: true, host, hmr: false },
    }))
  : undefined;

const server = createServer(async (request, response) => {
  if (await handleApi(request, response)) return;
  if (vite) {
    vite.middlewares(request, response, (error: unknown) => {
      if (!error) return;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
    return;
  }
  serveStatic(path.join(projectRoot, "dist"), request, response);
});

server.once("error", (error: NodeJS.ErrnoException) => {
  const message = error.code === "EADDRINUSE"
    ? `Phoenix Dev Hub 已在 http://${host}:${port} 运行；拒绝启动第二个实例。`
    : `Phoenix Dev Hub 监听失败：${error.message}`;
  process.stderr.write(`${message}\n`);
  void vite?.close().finally(() => process.exit(1));
});

server.listen(port, host, () => {
  process.stdout.write(`Phoenix Dev Hub: http://${host}:${port}\n`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`收到 ${signal}，停止 Dev Hub 管理的服务进程…\n`);
  // 先释放 42100，避免 tsx watch 在旧进程清理服务期间启动新实例并触发 EADDRINUSE。
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  await vite?.close();
  await manager.stopAllManaged();
  await serverClosed;
  process.exit(0);
  setTimeout(() => process.exit(1), 8_000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
