import { describe, expect, it } from "vitest";
import type { ServiceRuntimeStatus } from "@shared/contracts";
import {
  pdhPresentedEndpoint,
  pdhPresentedHealth,
} from "./PdhServiceHealthPresentation";

function status(
  value: Partial<ServiceRuntimeStatus> = {},
): ServiceRuntimeStatus {
  return {
    definition: {
      id: "sample",
      name: "Sample",
      moduleId: "sample",
      moduleName: "Sample",
      cwd: "/tmp/sample",
      command: { executable: "node", args: [] },
      endpoints: [],
    },
    lifecycle: "starting",
    health: "unhealthy",
    build: { state: "building" },
    ownership: "hub",
    managed: true,
    endpoints: [],
    externalProcesses: [],
    identityMatched: true,
    logSource: "captured",
    ...value,
  };
}

describe("PdhServiceHealthPresentation", () => {
  it("将启动宽限期内的暂时不可达显示为正在检查", () => {
    const service = status();
    const endpoint = {
      id: "api",
      label: "API",
      port: 8101,
      reachable: false,
      healthy: null,
      probeState: "unreachable" as const,
      probeMessage: "连接被拒绝",
      pids: [],
    };

    expect(pdhPresentedHealth(service)).toEqual({ state: "checking", label: "正在检查" });
    expect(pdhPresentedEndpoint(service, endpoint)).toEqual({
      state: "checking",
      label: "CHECKING",
    });
  });

  it("明确构建失败时不使用正在检查掩盖错误", () => {
    const service = status({ build: { state: "failed", message: "Found 1 error" } });

    expect(pdhPresentedHealth(service)).toEqual({
      state: "unhealthy",
      label: "健康检查失败",
    });
  });

  it("启动期间已经健康的端点仍显示 HEALTHY", () => {
    const service = status({ health: "partial" });
    const endpoint = {
      id: "api",
      label: "API",
      port: 8101,
      healthUrl: "http://127.0.0.1:8101/health",
      reachable: true,
      healthy: true,
      probeState: "healthy" as const,
      probeMessage: "HTTP 200",
      pids: [123],
    };

    expect(pdhPresentedEndpoint(service, endpoint)).toEqual({
      state: "healthy",
      label: "HEALTHY",
    });
  });

  it("宽限期结束后显示真实健康失败", () => {
    const service = status({ lifecycle: "running" });

    expect(pdhPresentedHealth(service)).toEqual({
      state: "unhealthy",
      label: "健康检查失败",
    });
  });
});
