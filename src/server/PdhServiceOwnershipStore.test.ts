import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceDefinition } from "../shared/contracts.js";
import {
  PdhServiceOwnershipStore,
  pdhServiceDefinitionIdentity,
} from "./PdhServiceOwnershipStore.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "pdh-ownership-store-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  const { rmSync } = await import("node:fs");
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("PdhServiceOwnershipStore", () => {
  it("以 0600 原子保存记录，并在删除最后一项后移除文件", () => {
    const projectRoot = root();
    const store = new PdhServiceOwnershipStore(projectRoot);
    store.put({
      serviceId: "admin-api",
      ownershipId: "ownership-1",
      root: {
        pid: 1200,
        parentPid: 1100,
        processGroupId: 1200,
        sessionId: 1200,
        cwd: "/workspace/admin-node",
        command: "pnpm dev",
        startedAt: "Wed Aug 12 10:00:00 2026",
      },
      startedAt: "2026-08-12T10:00:00.000Z",
      ports: [8101],
      definitionIdentity: "sha256:test",
    });

    const file = path.join(projectRoot, ".runtime/ownership.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      version: 1,
      records: [{ serviceId: "admin-api", ports: [8101] }],
    });
    expect(new PdhServiceOwnershipStore(projectRoot).entries()).toHaveLength(1);

    store.delete("admin-api", "wrong-ownership");
    expect(store.entries()).toHaveLength(1);
    store.delete("admin-api", "ownership-1");
    expect(() => statSync(file)).toThrow();
  });

  it("定义指纹覆盖命令、环境和端点但不在指纹中泄露环境值", () => {
    const definition: ServiceDefinition = {
      id: "admin-api",
      name: "Admin API",
      moduleId: "admin",
      moduleName: "Admin",
      cwd: "/workspace/admin-node",
      command: { executable: "pnpm", args: ["dev"], env: { SECRET: "private-value" } },
      endpoints: [{ id: "api", label: "API", port: 8101, healthUrl: "http://127.0.0.1:8101/health" }],
    };
    const fingerprint = pdhServiceDefinitionIdentity(definition);
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("private-value");
    expect(pdhServiceDefinitionIdentity({
      ...definition,
      command: { ...definition.command, env: { SECRET: "changed" } },
    })).not.toBe(fingerprint);
  });
});
