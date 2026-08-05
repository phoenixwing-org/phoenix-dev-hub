import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PdhProjectConfigStore } from "./PdhProjectConfig.js";

const temporaryRoots: string[] = [];

function createWorkspace(): { readonly hub: string; readonly project: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "pdh-projects-"));
  temporaryRoots.push(root);
  const hub = path.join(root, "phoenix-dev-hub");
  const project = path.join(root, "sample-node-app");
  mkdirSync(hub);
  mkdirSync(project);
  writeFileSync(path.join(project, "package.json"), JSON.stringify({
    name: "@phoenix/sample-node-app",
    packageManager: "pnpm@10.15.1",
    scripts: { test: "vitest run", dev: "vite" },
  }));
  writeFileSync(path.join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return { hub, project };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PdhProjectConfigStore", () => {
  it("发现 Hub 同级 Node.js 项目并优先提供 dev script", () => {
    const workspace = createWorkspace();
    const catalog = new PdhProjectConfigStore(workspace.hub).catalog();
    expect(catalog.defaultRoot).toBe(realpathSync(path.dirname(workspace.hub)));
    expect(catalog.candidates).toHaveLength(1);
    expect(catalog.candidates[0]).toMatchObject({
      name: "@phoenix/sample-node-app",
      directory: realpathSync(workspace.project),
      packageManager: "pnpm",
      scripts: ["dev", "test"],
      configured: false,
    });
  });

  it("以私有权限写入本机 JSON 并恢复受控服务", () => {
    const workspace = createWorkspace();
    const store = new PdhProjectConfigStore(workspace.hub);
    const added = store.add(workspace.project, "dev", new Set());
    const configPath = path.join(workspace.hub, ".runtime/projects.json");
    expect(added.definition).toMatchObject({
      id: added.project.serviceId,
      moduleId: added.project.id,
      localProjectId: added.project.id,
      cwd: realpathSync(workspace.project),
      command: { executable: "pnpm", args: ["dev"] },
      endpoints: [],
      externalStop: "deny",
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      version: 1,
      projects: [{ directory: realpathSync(workspace.project), script: "dev" }],
    });
    expect(new PdhProjectConfigStore(workspace.hub).serviceDefinitions()).toHaveLength(1);
  });

  it("拒绝不存在的 script 和重复项目", () => {
    const workspace = createWorkspace();
    const store = new PdhProjectConfigStore(workspace.hub);
    expect(() => store.add(workspace.project, "missing", new Set())).toThrow("不存在 script");
    store.add(workspace.project, "dev", new Set());
    expect(() => store.add(workspace.project, "dev", new Set())).toThrow("已经加入启动列表");
  });

  it("编辑项目时保留稳定 ID，并可只移出 Hub 配置", () => {
    const workspace = createWorkspace();
    const store = new PdhProjectConfigStore(workspace.hub);
    const added = store.add(workspace.project, "dev", new Set());
    const updated = store.update(added.project.id, workspace.project, "test", "示例测试服务");

    expect(updated.project).toMatchObject({
      id: added.project.id,
      serviceId: added.project.serviceId,
      name: "示例测试服务",
      script: "test",
    });
    expect(updated.definition.command).toEqual({ executable: "pnpm", args: ["test"] });
    expect(store.remove(added.project.id).serviceId).toBe(added.project.serviceId);
    expect(store.listProjects()).toEqual([]);
    expect(existsSync(workspace.project)).toBe(true);
  });

  it("导出便携文档并以合并方式新增和更新项目", () => {
    const workspace = createWorkspace();
    const secondProject = path.join(path.dirname(workspace.hub), "second-node-app");
    mkdirSync(secondProject);
    writeFileSync(path.join(secondProject, "package.json"), JSON.stringify({
      name: "second-node-app",
      scripts: { start: "node index.js" },
    }));

    const store = new PdhProjectConfigStore(workspace.hub);
    const existing = store.add(workspace.project, "dev", new Set());
    expect(store.exportDocument()).toEqual({
      format: "phoenix-dev-hub-projects",
      version: 1,
      projects: [{
        name: "@phoenix/sample-node-app",
        directory: realpathSync(workspace.project),
        script: "dev",
      }],
    });

    const plan = store.prepareImport({
      format: "phoenix-dev-hub-projects",
      version: 1,
      projects: [
        { name: "更新后的名称", directory: workspace.project, script: "test" },
        { name: "第二个项目", directory: secondProject, script: "start" },
      ],
    }, new Set(["builtin-service", existing.project.serviceId]));
    expect(plan.updated).toHaveLength(1);
    expect(plan.added).toHaveLength(1);
    expect(plan.updated[0].project.serviceId).toBe(existing.project.serviceId);
    expect(plan.added[0].project.serviceId).not.toBe("builtin-service");

    store.commitImport(plan);
    expect(store.listProjects()).toHaveLength(2);
    expect(store.listProjects()[0]).toMatchObject({ name: "更新后的名称", script: "test" });
  });

  it("拒绝错误格式和重复的导入目录", () => {
    const workspace = createWorkspace();
    const store = new PdhProjectConfigStore(workspace.hub);
    expect(() => store.prepareImport({ version: 1, projects: [] }, new Set())).toThrow(
      "phoenix-dev-hub-projects",
    );
    expect(() => store.prepareImport({
      format: "phoenix-dev-hub-projects",
      version: 1,
      projects: [
        { name: "A", directory: workspace.project, script: "dev" },
        { name: "B", directory: workspace.project, script: "test" },
      ],
    }, new Set())).toThrow("重复目录");
  });
});
