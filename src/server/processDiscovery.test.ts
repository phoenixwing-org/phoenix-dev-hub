import { describe, expect, it } from "vitest";
import type { ProcessSummary } from "../shared/contracts.js";
import { sameProcessIdentity } from "./processDiscovery.js";

const identity: ProcessSummary = {
  pid: 4101,
  parentPid: 4000,
  processGroupId: 4101,
  sessionId: 4000,
  cwd: "/workspace/service",
  command: "node server.js",
  startedAt: "Sat Aug  1 12:00:00 2026",
  tty: "??",
};

describe("sameProcessIdentity", () => {
  it("只有 PID、PGID、启动时间、cwd 与命令都一致才延续 ownership", () => {
    expect(sameProcessIdentity(identity, { ...identity })).toBe(true);
  });

  it("拒绝陈旧 PID、PID 复用与不完整身份", () => {
    expect(sameProcessIdentity(identity, undefined)).toBe(false);
    expect(sameProcessIdentity(identity, { ...identity, startedAt: "Sat Aug  1 12:01:00 2026" })).toBe(false);
    expect(sameProcessIdentity(identity, { ...identity, processGroupId: 9999 })).toBe(false);
    expect(sameProcessIdentity(identity, { ...identity, command: "node other.js" })).toBe(false);
    expect(sameProcessIdentity({ ...identity, startedAt: undefined }, identity)).toBe(false);
  });
});
