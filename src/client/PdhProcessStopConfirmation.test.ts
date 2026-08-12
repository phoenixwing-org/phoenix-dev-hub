import { describe, expect, it } from "vitest";
import type { StopTargetDetails } from "@shared/contracts";
import { pdhProcessStopConfirmationText } from "./PdhProcessStopConfirmation";

const details: StopTargetDetails = {
  serviceId: "admin-api",
  ownership: "external",
  token: "secret-token",
  expiresAt: "2026-08-12T10:00:00.000Z",
  ports: [8101],
  processGroupIds: [58127],
  processes: [{
    pid: 58131,
    parentPid: 58127,
    processGroupId: 58127,
    cwd: "/workspace/admin-node",
    command: "node ./bootstrap.js --keepalive",
    startedAt: "Wed Aug 12 10:00:00 2026",
  }],
  command: "pnpm dev",
  cwd: "/workspace/admin-node",
  impact: "只影响精确进程组",
};

describe("pdhProcessStopConfirmationText", () => {
  it("按行包含 PID、PPID、PGID、cwd、command，且不复制确认 token", () => {
    const text = pdhProcessStopConfirmationText(details, false);
    expect(text).toContain("PID: 58131");
    expect(text).toContain("PPID: 58127");
    expect(text).toContain("PGID: 58127");
    expect(text).toContain("cwd: /workspace/admin-node");
    expect(text).toContain("command: node ./bootstrap.js --keepalive");
    expect(text).toContain("确认后仍会重新核验");
    expect(text).not.toContain(details.token);
  });

  it("强制终止文案明确 SIGKILL 风险", () => {
    expect(pdhProcessStopConfirmationText(details, true)).toContain("SIGKILL");
  });
});
