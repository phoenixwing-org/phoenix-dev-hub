import { describe, expect, it } from "vitest";
import type { ServiceRuntimeStatus } from "@shared/contracts";
import { pdhProfileDatabaseConfirmation } from "./PdhProfileDatabaseAction";

function status(environmentKind: "development" | "release-validation"): ServiceRuntimeStatus {
  return {
    definition: {
      id: "fixture-release-api",
      name: "Fixture Release API",
      moduleId: "fixture",
      moduleName: "Fixture",
      cwd: "/fixture",
      command: { executable: "node", args: [] },
      endpoints: [],
      profilePolicy: {
        environmentKind,
        deploymentMode: environmentKind === "development" ? "source-mounted" : "package-assembled",
        database: {
          serviceRole: "api",
          envName: "TEST_DB",
          name: "fixture_release_validation_20260804",
          preflight: {
            provider: "postgresql",
            host: "127.0.0.1",
            port: 5432,
            maintenanceDatabase: "postgres",
            usernameEnv: "USER",
            passwordEnv: "TEST_PASSWORD",
            creation: {
              allowedDatabaseNames: ["fixture_release_validation_20260804"],
              cleanupResponsibility: "验收结束后受控回收。",
            },
          },
        },
      },
    },
    lifecycle: "stopped",
    health: "unknown",
    build: { state: "unknown" },
    ownership: "none",
    managed: false,
    endpoints: [],
    externalProcesses: [],
    identityMatched: null,
    logSource: "monitoring-only",
  };
}

describe("pdhProfileDatabaseConfirmation", () => {
  it("只为 release-validation 生成固定确认文本和回收责任提示", () => {
    expect(pdhProfileDatabaseConfirmation(status("release-validation"))).toEqual({
      databaseName: "fixture_release_validation_20260804",
      confirmation: "create-release-validation-database:fixture_release_validation_20260804",
      message: expect.stringContaining("回收责任：验收结束后受控回收。"),
    });
    expect(pdhProfileDatabaseConfirmation(status("development"))).toBeUndefined();
  });
});
