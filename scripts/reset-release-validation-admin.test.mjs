import { describe, expect, it } from "vitest";
import {
  assertServicesStopped,
  parseArgs,
  readSecret,
  resolveConfigPath,
  selectReleaseProfile,
  updateSecretContent,
} from "./reset-release-validation-admin.mjs";

function fixture() {
  return {
    version: 2,
    series: [{
      id: "admin",
      template: {
        services: {
          web: { endpoints: [{ port: 9100 }] },
          api: { endpoints: [{ port: 8201 }] },
        },
      },
      profiles: [{
        id: "release-validation",
        policy: {
          environmentKind: "release-validation",
          deploymentMode: "package-assembled",
          database: {
            name: "sample_release_validation",
            forbiddenNames: ["sample_production"],
            preflight: {
              host: "127.0.0.1",
              port: 5432,
              usernameEnv: "USER",
              creation: { allowedDatabaseNames: ["sample_release_validation"] },
            },
          },
        },
        services: {
          web: { id: "release-web" },
          api: { id: "release-api" },
        },
      }],
    }],
  };
}

describe("release-validation 管理员重置入口", () => {
  it("优先读取用户配置且不会执行 sample", () => {
    const existing = new Set([
      "/workspace/config/services.user.json",
      "/workspace/config/services.sample.json",
    ]);
    expect(resolveConfigPath("/workspace", candidate => existing.has(candidate)))
      .toBe("/workspace/config/services.user.json");
    existing.delete("/workspace/config/services.user.json");
    expect(() => resolveConfigPath("/workspace", candidate => existing.has(candidate)))
      .toThrow("用户服务配置");
  });

  it("只接受显式 Profile 与安全用户名", () => {
    expect(parseArgs(["--profile", "release-validation", "--username", "admin"]))
      .toMatchObject({ profileId: "release-validation", username: "admin" });
    expect(() => parseArgs(["--profile", "release-validation", "--username", "bad user"]))
      .toThrow("--username");
    expect(() => parseArgs(["--username", "admin"]))
      .toThrow("--profile");
  });

  it("只选择带本机精确数据库锚点的发布验收 Profile", () => {
    const selected = selectReleaseProfile(fixture(), "release-validation");
    expect(selected.database.name).toBe("sample_release_validation");
    expect(selected.services).toEqual([
      { id: "release-web", ports: [9100] },
      { id: "release-api", ports: [8201] },
    ]);

    const remote = fixture();
    remote.series[0].profiles[0].policy.database.preflight.host = "db.example.com";
    expect(() => selectReleaseProfile(remote, "release-validation"))
      .toThrow("安全锚点");

    const development = fixture();
    development.series[0].profiles[0].policy.environmentKind = "development";
    expect(() => selectReleaseProfile(development, "release-validation"))
      .toThrow("release-validation");
  });

  it("要求 Hub 报告 Profile 全部服务完全停止", () => {
    const stopped = id => ({
      definition: { id },
      lifecycle: "stopped",
      ownership: "none",
      managed: false,
    });
    expect(() => assertServicesStopped(
      [stopped("release-web"), stopped("release-api")],
      ["release-web", "release-api"],
    )).not.toThrow();
    expect(() => assertServicesStopped(
      [{ ...stopped("release-web"), lifecycle: "running", ownership: "hub", managed: true }],
      ["release-web"],
    )).toThrow("完全停止");
  });

  it("原子内容更新同时轮换用户名、密码与时间并保留责任字段", () => {
    const source = [
      "PAH_HOST_BASELINE_ADMIN_USERNAME=old-admin",
      "PAH_HOST_BASELINE_ADMIN_PASSWORD=old-password",
      "PAH_HOST_BASELINE_SECRET_CREATED_AT=2026-01-01T00:00:00.000Z",
      "PAH_HOST_BASELINE_SECRET_CLEANUP_RESPONSIBILITY=local-only",
      "",
    ].join("\n");
    const updated = updateSecretContent(
      source,
      "admin",
      "new-password-2026",
      new Date("2026-08-05T00:00:00.000Z"),
    );
    expect(readSecret(updated)).toEqual(new Map([
      ["PAH_HOST_BASELINE_ADMIN_USERNAME", "admin"],
      ["PAH_HOST_BASELINE_ADMIN_PASSWORD", "new-password-2026"],
      ["PAH_HOST_BASELINE_SECRET_CREATED_AT", "2026-08-05T00:00:00.000Z"],
      ["PAH_HOST_BASELINE_SECRET_CLEANUP_RESPONSIBILITY", "local-only"],
    ]));
  });
});
