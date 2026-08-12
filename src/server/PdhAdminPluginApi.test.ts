import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminPluginCatalogResponse, AdminPluginStatus } from "../shared/contracts.js";
import { createApiHandler, pdhAdminPluginVerificationBoundary } from "./api.js";
import { PdhAdminPluginWorkspace } from "./PdhAdminPluginWorkspace.js";
import { PdhBuiltinServiceConfigStore } from "./PdhBuiltinServiceConfig.js";
import { PdhProjectConfigStore } from "./PdhProjectConfig.js";
import { PdhServiceManager } from "./PdhServiceManager.js";

const roots: string[] = [];
const servers: Server[] = [];

function initGit(directory: string): void {
  mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: directory });
}

function createPlugin(root: string, version = "1.0.0"): string {
  const product = path.join(root, `example-product-${version}`);
  const pluginRoot = path.join(product, "packages/admin-plugin");
  const moduleId = "example-admin-plugin";
  initGit(product);
  for (const side of ["vue", "midway"]) {
    mkdirSync(path.join(pluginRoot, side, moduleId), { recursive: true });
    writeFileSync(path.join(pluginRoot, side, moduleId, "config.ts"), "export default {}\n");
  }
  writeFileSync(path.join(pluginRoot, "manifest.json"), JSON.stringify({
    formatVersion: 2,
    moduleId,
    name: "Example",
    version,
    publisher: "Fixture",
    activationMode: "restart",
    routePrefix: "/example",
    entrypoints: { web: `vue/${moduleId}/config.ts`, node: `midway/${moduleId}/config.ts` },
    routes: [{ id: "example", path: "/example/list", title: "Example" }],
    navigation: { preferredGroupId: "pah-group-business", modules: [] },
    migrations: [],
  }));
  execFileSync("git", ["add", "."], { cwd: product });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"], { cwd: product });
  return product;
}

async function fixture(): Promise<{ baseUrl: string; product: string; root: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "pdh-admin-plugin-api-"));
  roots.push(root);
  const hub = path.join(root, "hub");
  const web = path.join(root, "web-host");
  const node = path.join(root, "node-host");
  mkdirSync(hub);
  initGit(web);
  initGit(node);
  const product = createPlugin(root);
  const manager = new PdhServiceManager([]);
  const workspace = new PdhAdminPluginWorkspace(
    hub,
    { adminWebRoot: web, adminNodeRoot: node },
    { syncRuntimeEntities: () => ({ count: 0, sha256: "a".repeat(64) }) },
  );
  const handler = createApiHandler(
    manager,
    new PdhProjectConfigStore(hub),
    new PdhBuiltinServiceConfigStore(hub, []),
    workspace,
  );
  const server = createServer((request, response) => void handler(request, response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得 API 测试端口");
  return { baseUrl: `http://127.0.0.1:${address.port}`, product, root };
}

async function request<T>(baseUrl: string, pathname: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(parsed.error || `HTTP ${response.status}`);
  return parsed;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Admin 插件工作区 API", () => {
  it("完成 inspect/add/status/mount/unmount/remove 闭环", async () => {
    const current = await fixture();
    const inspected = await request<{ configured: boolean; manifest: { moduleId: string } }>(
      current.baseUrl,
      "/api/admin-plugins/inspect",
      "POST",
      { directory: current.product },
    );
    expect(inspected).toMatchObject({ configured: false, manifest: { moduleId: "example-admin-plugin" } });

    const added = await request<AdminPluginStatus>(current.baseUrl, "/api/admin-plugins", "POST", {
      directory: current.product,
    });
    expect(added.mountState).toBe("unmounted");
    expect((await request<AdminPluginStatus>(
      current.baseUrl,
      `/api/admin-plugins/${added.registration.id}/mount`,
      "POST",
      {},
    )).mountState).toBe("mounted");

    const catalog = await request<AdminPluginCatalogResponse>(current.baseUrl, "/api/admin-plugins");
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0]?.mounts).toHaveLength(2);
    const boundary = pdhAdminPluginVerificationBoundary(catalog);
    expect(boundary).toMatchObject({
      scope: "development-assembly",
      completeProductVerification: false,
      migrationSkillCommit: "46e25e3041dc9a57dbbb629feedc9e4694dfcd82",
    });
    expect(boundary.hostOwned).toHaveLength(2);
    expect(boundary.pluginOwned).toHaveLength(1);
    expect([...boundary.hostOwned, ...boundary.pluginOwned].every((owner) => (
      owner.gates.length === 4
      && owner.gates.every((gate) => (
        gate.status === "not-recorded"
        && gate.command === null
        && gate.scanRoot === null
        && gate.followsSymlinks === "not-recorded"
      ))
    ))).toBe(true);
    expect(boundary.gitExcludePolicy).toContain("只影响 Git");

    const nextProduct = createPlugin(current.root, "1.1.0");
    const updated = await request<AdminPluginStatus>(
      current.baseUrl,
      `/api/admin-plugins/${added.registration.id}`,
      "PATCH",
      { directory: nextProduct },
    );
    expect(updated).toMatchObject({
      mountState: "mounted",
      identity: { moduleId: "example-admin-plugin", version: "1.1.0" },
      recentOperation: { action: "repoint" },
    });

    expect((await request<AdminPluginStatus>(
      current.baseUrl,
      `/api/admin-plugins/${added.registration.id}/unmount`,
      "POST",
      {},
    )).mountState).toBe("unmounted");
    await request(current.baseUrl, `/api/admin-plugins/${added.registration.id}`, "DELETE", {});
    expect((await request<AdminPluginCatalogResponse>(current.baseUrl, "/api/admin-plugins")).plugins).toHaveLength(0);
  });
});
