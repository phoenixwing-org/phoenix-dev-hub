import { describe, expect, it } from "vitest";

import {
  assertIncidentScope,
  assertProtectedDatabases,
  assertServiceStatuses,
  normalizePgDumpSchema,
  parseArgs,
} from "./rebuild-incident-admin-database.mjs";

const incidentId = "admin-bom-validation-default-db-start-20260901-1251";

describe("共享 Admin incident 受控重建", () => {
  it("确认文本绑定 incident 与精确数据库", () => {
    expect(parseArgs([
      "--",
      "--incident", incidentId,
      "--database", "phoenix_admin",
      "--confirmation", `rebuild-incident-database:${incidentId}:phoenix_admin`,
    ])).toMatchObject({ incidentId, databaseName: "phoenix_admin" });
    expect(() => parseArgs([
      "--incident", incidentId,
      "--database", "phoenix_admin",
      "--confirmation", "wrong",
    ])).toThrow(/确认文本/);
  });

  it("只接受 pending incident 对应的 phoenix_admin", () => {
    const incident = {
      incidentId,
      status: "contained-pending-environment-owner-audit",
      environmentAudit: {
        applicationDefaultsObservedInFrozenAssembly: { database: "phoenix_admin" },
      },
    };
    expect(() => assertIncidentScope(incident, { incidentId, databaseName: "phoenix_admin" })).not.toThrow();
    expect(() => assertIncidentScope(incident, { incidentId, databaseName: "phoenix_admin_development" })).toThrow();
    expect(() => assertIncidentScope({ ...incident, status: "rebuilt-and-verified" }, { incidentId, databaseName: "phoenix_admin" })).toThrow();
  });

  it("稳定测试、BOM 双验证与生产库均受保护", () => {
    for (const name of [
      "phoenix_admin_development",
      "phoenix_admin_bom_install_validation",
      "phoenix_admin_bom_restore_validation",
      "phoenix_admin_preproduction",
      "phoenix_admin_production",
    ]) expect(() => assertProtectedDatabases(name)).toThrow(/受保护/);
    expect(() => assertProtectedDatabases("phoenix_admin")).not.toThrow();
  });

  it("目标数据库消费者必须由 Hub 完全停止", () => {
    const stopped = {
      definition: { id: "admin-in-progress-api", command: { env: { PAH_DB_DATABASE: "phoenix_admin" } } },
      lifecycle: "stopped",
      ownership: "none",
      managed: false,
    };
    expect(assertServiceStatuses([stopped], "phoenix_admin")).toEqual(["admin-in-progress-api"]);
    expect(() => assertServiceStatuses([{ ...stopped, lifecycle: "ready" }], "phoenix_admin")).toThrow(/完全停止/);
    expect(() => assertServiceStatuses([stopped], "phoenix_admin_development")).toThrow(/找不到/);
  });

  it("只规范化 pg_dump 随机 restrict 令牌", () => {
    const first = "\\restrict abc123\nCREATE TABLE demo(id int);\n\\unrestrict abc123\n";
    const second = "\\restrict xyz789\nCREATE TABLE demo(id int);\n\\unrestrict xyz789\n";
    expect(normalizePgDumpSchema(first)).toBe(normalizePgDumpSchema(second));
    expect(normalizePgDumpSchema(first)).toContain("CREATE TABLE demo(id int);");
  });
});
