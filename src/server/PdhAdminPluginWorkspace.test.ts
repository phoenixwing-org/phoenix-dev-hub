import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PdhAdminPluginWorkspace } from "./PdhAdminPluginWorkspace.js";

const roots: string[] = [];

function directoryLink(source: string, target: string): void {
  symlinkSync(
    process.platform === "win32" ? path.resolve(source) : path.relative(path.dirname(target), source),
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function gitRoot(directory: string): void {
  mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: directory });
}

function pluginFixture(root: string, version = "0.1.0", ddl = false, moduleId = "example-admin-plugin"): string {
  const product = path.join(root, `product-${version}`);
  const pluginRoot = path.join(product, "packages/admin-plugin");
  gitRoot(product);
  mkdirSync(path.join(pluginRoot, "vue", moduleId), { recursive: true });
  mkdirSync(path.join(pluginRoot, "midway", moduleId), { recursive: true });
  writeFileSync(path.join(pluginRoot, "vue", moduleId, "config.ts"), "export default {}\n");
  writeFileSync(path.join(pluginRoot, "midway", moduleId, "config.ts"), "export default {}\n");
  writeFileSync(path.join(pluginRoot, "midway", moduleId, "pah-plugin.artifacts.json"), JSON.stringify({
    formatVersion: 1,
    moduleId,
    version,
  }));
  if (ddl) {
    mkdirSync(path.join(pluginRoot, "midway", moduleId, "migrations"));
    writeFileSync(path.join(pluginRoot, "midway", moduleId, "migrations/001.sql"), "create table example(id int);\n");
  }
  writeFileSync(path.join(pluginRoot, "manifest.json"), JSON.stringify({
    formatVersion: 2,
    moduleId,
    name: "Example Admin Plugin",
    version,
    publisher: "Fixture",
    activationMode: "restart",
    routePrefix: "/example",
    entrypoints: {
      web: `vue/${moduleId}/config.ts`,
      node: `midway/${moduleId}/config.ts`,
    },
    routes: [{ id: "example", path: "/example/list", title: "Example" }],
    navigation: { preferredGroupId: "pah-group-business", preferredGroupLabel: "业务", modules: [] },
    migrations: ddl ? [{
      id: `${moduleId}-001`,
      version: 1,
      checksum: `sha256:${createHash("sha256").update("create table example(id int);\n").digest("hex")}`,
      description: "fixture",
      artifact: { format: "sql", path: "migrations/001.sql" },
    }] : [],
  }, null, 2));
  execFileSync("git", ["add", "."], { cwd: product });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"], { cwd: product });
  return product;
}

function fixture(): {
  root: string;
  hub: string;
  web: string;
  node: string;
  workspace: PdhAdminPluginWorkspace;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "pdh-admin-plugin-"));
  roots.push(root);
  const hub = path.join(root, "phoenix-dev-hub");
  const web = path.join(root, "phoenix-admin-vue");
  const node = path.join(root, "phoenix-admin-node");
  mkdirSync(hub);
  gitRoot(web);
  gitRoot(node);
  return {
    root,
    hub,
    web,
    node,
    workspace: new PdhAdminPluginWorkspace(hub, {
      adminWebRoot: web,
      adminNodeRoot: node,
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Admin 插件开发工作区", () => {
  it("识别 Manifest v2，并完成精确挂载、明细记录和开发卸载", () => {
    const current = fixture();
    const product = pluginFixture(current.root);
    const candidate = current.workspace.inspect(product);
    expect(candidate).toMatchObject({
      configured: false,
      manifest: {
        moduleId: "example-admin-plugin",
        preferredGroupId: "pah-group-business",
      },
    });
    expect(candidate.sourceCommit).toMatch(/^[a-f0-9]{40}$/);

    const added = current.workspace.add(product);
    expect(added.mountState).toBe("unmounted");
    const mounted = current.workspace.mount(added.registration.id);
    expect(mounted.mountState).toBe("mounted");
    expect(mounted.mounts).toHaveLength(2);
    expect(mounted.mounts.every((entry) => entry.linkState === "mounted" && entry.excludeState === "managed")).toBe(true);
    expect(mounted.recentOperation?.changes.some((change) => change.action === "created-link")).toBe(true);
    expect(mounted.recentOperation?.changes.map((change) => String(change.action)))
      .not.toContain("synced-entities");
    for (const entry of mounted.mounts) {
      expect(realpathSync(entry.target)).toBe(realpathSync(entry.source));
      expect(readFileSync(entry.excludePath, "utf8")).toContain(entry.excludePattern);
    }

    const unmounted = current.workspace.unmount(added.registration.id);
    expect(unmounted.mountState).toBe("unmounted");
    expect(unmounted.mounts.every((entry) => !existsSync(entry.target))).toBe(true);
    expect(current.workspace.remove(added.registration.id).id).toBe(added.registration.id);
  });

  it("只管理双端链接与 Git exclude，不执行 Admin Node 内部实体脚本", () => {
    const current = fixture();
    const sentinel = path.join(current.node, "entity-sync-was-called");
    const script = path.join(
      current.node,
      "scripts",
      "pah-sync-runtime-entities.cjs",
    );
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "called\\n");\n`,
    );
    const workspace = new PdhAdminPluginWorkspace(current.hub, {
      adminWebRoot: current.web,
      adminNodeRoot: current.node,
    });
    const added = workspace.add(pluginFixture(current.root));

    const mounted = workspace.mount(added.registration.id);
    expect(mounted.mountState).toBe("mounted");
    expect(existsSync(sentinel)).toBe(false);
    workspace.unmount(added.registration.id);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("拒绝覆盖实体目录、外来版本链接和未开发卸载的列表移除", () => {
    const current = fixture();
    const first = current.workspace.add(pluginFixture(current.root, "0.1.0"));
    current.workspace.mount(first.registration.id);
    expect(() => current.workspace.remove(first.registration.id)).toThrow("先执行开发卸载");

    const second = current.workspace.add(pluginFixture(current.root, "0.2.0"));
    expect(second.mountState).toBe("conflict");
    expect(() => current.workspace.mount(second.registration.id)).toThrow("拒绝覆盖外来链接");

    current.workspace.unmount(first.registration.id);
    const target = second.mounts[0]!.target;
    mkdirSync(target, { recursive: true });
    expect(() => current.workspace.mount(second.registration.id)).toThrow("拒绝覆盖实体目录/文件");
  });

  it("原子更新已挂载登记，并受控认领已经指向新 worktree 的 Vue/Node 链接", () => {
    const current = fixture();
    const oldProduct = pluginFixture(current.root, "0.1.0");
    const newProduct = pluginFixture(current.root, "0.2.0");
    const added = current.workspace.add(oldProduct);
    const mounted = current.workspace.mount(added.registration.id);
    const newCandidate = current.workspace.inspect(newProduct);

    for (const mount of mounted.mounts) {
      const source = mount.kind === "web" ? newCandidate.webModulePath : newCandidate.nodeModulePath;
      unlinkSync(mount.target);
      directoryLink(source, mount.target);
    }

    const updated = current.workspace.repoint(added.registration.id, newProduct);
    expect(updated).toMatchObject({
      sourceState: "available",
      mountState: "mounted",
      identity: { moduleId: "example-admin-plugin", version: "0.2.0" },
      registration: { productRoot: realpathSync(newProduct), manifestVersion: "0.2.0" },
      recentOperation: { action: "repoint" },
    });
    expect(updated.recentOperation?.changes.filter((change) => change.action === "claimed-link")).toHaveLength(2);
    expect(updated.mounts.every((mount) => realpathSync(mount.target) === mount.source)).toBe(true);
    const saved = JSON.parse(readFileSync(path.join(current.hub, ".runtime/admin-plugins.json"), "utf8")) as {
      plugins: readonly { productRoot: string }[];
    };
    expect(saved.plugins).toContainEqual(expect.objectContaining({ productRoot: realpathSync(newProduct) }));
    expect(saved.plugins).not.toContainEqual(expect.objectContaining({ productRoot: realpathSync(oldProduct) }));
  });

  it("旧目录不可用时保留可理解状态，并用身份快照安全重新指向同模块", () => {
    const current = fixture();
    const oldProduct = pluginFixture(current.root, "0.1.0");
    const added = current.workspace.add(oldProduct);
    current.workspace.mount(added.registration.id);
    rmSync(oldProduct, { recursive: true, force: true });

    const unavailable = current.workspace.status(added.registration.id);
    expect(unavailable).toMatchObject({
      sourceState: "unavailable",
      identity: { moduleId: "example-admin-plugin", version: "0.1.0" },
    });
    expect(unavailable.sourceError?.message).toContain("不存在");

    const newProduct = pluginFixture(current.root, "0.2.0");
    const updated = current.workspace.repoint(added.registration.id, newProduct);
    expect(updated).toMatchObject({ sourceState: "available", mountState: "mounted" });
    expect(updated.recentOperation?.changes.filter((change) => change.action === "replaced-link")).toHaveLength(2);
  });

  it("早期登记缺少 moduleId 时只凭受控旧链接与 marker 恢复并修改目录", () => {
    const current = fixture();
    const oldProduct = pluginFixture(current.root, "0.1.0");
    const added = current.workspace.add(oldProduct);
    const mounted = current.workspace.mount(added.registration.id);
    const configPath = path.join(current.hub, ".runtime/admin-plugins.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    delete config.plugins[0]!.moduleId;
    delete config.plugins[0]!.name;
    delete config.plugins[0]!.manifestVersion;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    unlinkSync(mounted.mounts.find((mount) => mount.kind === "node")!.target);
    rmSync(oldProduct, { recursive: true, force: true });

    const legacy = new PdhAdminPluginWorkspace(current.hub, {
      adminWebRoot: current.web,
      adminNodeRoot: current.node,
    });
    expect(legacy.status(added.registration.id)).toMatchObject({
      sourceState: "unavailable",
      identity: { moduleId: undefined },
    });
    const newProduct = pluginFixture(current.root, "0.2.0");
    const updated = legacy.repoint(added.registration.id, newProduct);
    expect(updated).toMatchObject({
      sourceState: "available",
      mountState: "mounted",
      identity: { moduleId: "example-admin-plugin", version: "0.2.0" },
    });
    expect(updated.recentOperation?.changes.some((change) => change.action === "replaced-link")).toBe(true);
    expect(updated.recentOperation?.changes.some((change) => change.action === "created-link")).toBe(true);
  });

  it("早期登记缺少身份且没有任何受控旧链接时拒绝猜测 moduleId", () => {
    const current = fixture();
    const oldProduct = pluginFixture(current.root, "0.1.0");
    const added = current.workspace.add(oldProduct);
    const mounted = current.workspace.mount(added.registration.id);
    const configPath = path.join(current.hub, ".runtime/admin-plugins.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    delete config.plugins[0]!.moduleId;
    delete config.plugins[0]!.name;
    delete config.plugins[0]!.manifestVersion;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    for (const mount of mounted.mounts) unlinkSync(mount.target);
    rmSync(oldProduct, { recursive: true, force: true });

    const legacy = new PdhAdminPluginWorkspace(current.hub, {
      adminWebRoot: current.web,
      adminNodeRoot: current.node,
    });
    const newProduct = pluginFixture(current.root, "0.2.0");
    expect(() => legacy.repoint(added.registration.id, newProduct)).toThrow("不会根据登记 ID 猜测模块身份");
  });

  it("重新指向拒绝不同 moduleId、重复登记与第三方链接，且不改原登记", () => {
    const current = fixture();
    const oldProduct = pluginFixture(current.root, "0.1.0");
    const added = current.workspace.add(oldProduct);
    const mounted = current.workspace.mount(added.registration.id);
    const different = pluginFixture(current.root, "9.0.0", false, "another-admin-plugin");
    expect(() => current.workspace.repoint(added.registration.id, different)).toThrow("拒绝重新指向其他模块");

    const nextProduct = pluginFixture(current.root, "0.2.0");
    const target = mounted.mounts[0]!;
    const thirdParty = path.join(current.root, "third-party-module");
    mkdirSync(thirdParty);
    unlinkSync(target.target);
    directoryLink(thirdParty, target.target);
    expect(() => current.workspace.repoint(added.registration.id, nextProduct)).toThrow("既不指向旧目录也不指向本次新目录");
    expect(current.workspace.status(added.registration.id).registration.productRoot).toBe(realpathSync(oldProduct));

    unlinkSync(target.target);
    directoryLink(target.source, target.target);
    const duplicate = current.workspace.add(nextProduct);
    expect(() => current.workspace.repoint(added.registration.id, nextProduct)).toThrow(duplicate.registration.id);
  });

  it("登记保存失败时恢复原链接，并明确报告自动回滚登记无法复写", () => {
    const current = fixture();
    const oldProduct = pluginFixture(current.root, "0.1.0");
    const nextProduct = pluginFixture(current.root, "0.2.0");
    const added = current.workspace.add(oldProduct);
    const mounted = current.workspace.mount(added.registration.id);
    const configPath = path.join(current.hub, ".runtime/admin-plugins.json");
    const blockedTemporary = `${configPath}.${process.pid}.tmp`;

    mkdirSync(blockedTemporary);
    try {
      expect(() => current.workspace.repoint(added.registration.id, nextProduct)).toThrow("自动回滚未完整完成");
    } finally {
      rmSync(blockedTemporary, { recursive: true, force: true });
    }

    for (const mount of mounted.mounts) {
      expect(realpathSync(mount.target)).toBe(mount.source);
      expect(readFileSync(mount.excludePath, "utf8")).toContain(mount.excludePattern);
    }
    const reloaded = new PdhAdminPluginWorkspace(current.hub, {
      adminWebRoot: current.web,
      adminNodeRoot: current.node,
    });
    expect(reloaded.status(added.registration.id).registration.productRoot).toBe(realpathSync(oldProduct));
  });

  it("包含 DDL 时只接受安全声明和 artifacts descriptor", () => {
    const current = fixture();
    const product = pluginFixture(current.root, "0.3.0", true);
    const candidate = current.workspace.inspect(product);
    expect(candidate.manifest.migrations).toHaveLength(1);
    expect(candidate.artifactsPath).toContain("pah-plugin.artifacts.json");

    const artifactsPath = path.join(product, "packages/admin-plugin/midway/example-admin-plugin/pah-plugin.artifacts.json");
    const artifacts = JSON.parse(readFileSync(artifactsPath, "utf8")) as { version: string };
    artifacts.version = "0.3.1";
    writeFileSync(artifactsPath, JSON.stringify(artifacts));
    expect(() => current.workspace.inspect(product)).toThrow("artifacts.version 与 manifest.version 不一致");
    artifacts.version = "0.3.0";
    writeFileSync(artifactsPath, JSON.stringify(artifacts));

    const manifestPath = path.join(product, "packages/admin-plugin/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { navigation: { preferredGroupId: string } };
    manifest.navigation.preferredGroupId = "pah-group-other";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const warned = current.workspace.inspect(product);
    expect(warned.mountAllowed).toBe(false);
    expect(warned.validationWarnings[0]).toContain("pah-group-business");
    const added = current.workspace.add(product);
    expect(() => current.workspace.mount(added.registration.id)).toThrow("拒绝挂载");
  });

  it("本机配置使用 0600 保存且不包含数据库连接串内容", () => {
    const current = fixture();
    current.workspace.updateSettings({
      adminWebRoot: current.web,
      adminNodeRoot: current.node,
      adminWebServiceId: "admin-web",
      adminApiServiceId: "admin-api",
      postgresEnvFile: path.join(current.root, "private-admin-plugin.env"),
    });
    const file = path.join(current.hub, ".runtime/admin-plugins.json");
    const content = readFileSync(file, "utf8");
    expect(content).toContain("private-admin-plugin.env");
    expect(content).not.toContain("postgres://");
  });

  it("修改 Phoenix Admin 开发 Host 前要求开发插件已卸载", () => {
    const current = fixture();
    const alternateWeb = path.join(current.root, "alternate-web-host");
    const alternateNode = path.join(current.root, "alternate-node-host");
    gitRoot(alternateWeb);
    gitRoot(alternateNode);

    const plugin = current.workspace.add(pluginFixture(current.root));
    current.workspace.mount(plugin.registration.id);
    expect(() => current.workspace.updateSettings({
      adminWebRoot: alternateWeb,
      adminNodeRoot: alternateNode,
      adminWebServiceId: "admin-web-alt",
      adminApiServiceId: "admin-api-alt",
    })).toThrow("必须先对已挂载或冲突的插件执行开发卸载");
    expect(current.workspace.settings()).toMatchObject({
      adminWebRoot: current.web,
      adminNodeRoot: current.node,
    });

    current.workspace.unmount(plugin.registration.id);
    expect(current.workspace.updateSettings({
      adminWebRoot: alternateWeb,
      adminNodeRoot: alternateNode,
      adminWebServiceId: "admin-web-alt",
      adminApiServiceId: "admin-api-alt",
    })).toMatchObject({
      adminWebRoot: realpathSync(alternateWeb),
      adminNodeRoot: realpathSync(alternateNode),
      adminWebServiceId: "admin-web-alt",
      adminApiServiceId: "admin-api-alt",
    });
  });

  it("sample 风格相对路径按 Hub 根目录解析，登记后仍需显式开发挂载", () => {
    const current = fixture();
    const product = pluginFixture(current.root);
    const configPath = path.join(current.hub, ".runtime/admin-plugins.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      sampleNotice: "fixture",
      version: 1,
      settings: {
        adminWebRoot: path.relative(current.hub, current.web),
        adminNodeRoot: path.relative(current.hub, current.node),
        adminWebServiceId: "admin-web",
        adminApiServiceId: "admin-api",
      },
      plugins: [{
        id: "example-admin-plugin-local",
        productRoot: path.relative(current.hub, product),
        manifestPath: "packages/admin-plugin/manifest.json",
        createdAt: "2026-01-01T00:00:00.000Z",
        moduleId: "example-admin-plugin",
        name: "Example Admin Plugin",
      }],
    }, null, 2));

    const workspace = new PdhAdminPluginWorkspace(current.hub);
    expect(workspace.settings()).toMatchObject({
      adminWebRoot: realpathSync(current.web),
      adminNodeRoot: realpathSync(current.node),
    });
    const plugin = workspace.status("example-admin-plugin-local");
    expect(plugin).toMatchObject({
      sourceState: "available",
      mountState: "unmounted",
      registration: { productRoot: realpathSync(product) },
    });
    expect(plugin.mounts.every((mount) => mount.linkState === "missing")).toBe(true);
  });
});
