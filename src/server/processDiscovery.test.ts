import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import type { ProcessSummary } from "../shared/contracts.js";
import {
  describeProcess,
  isPathInside,
  processGroupMembers,
  sameProcessIdentity,
} from "./processDiscovery.js";

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

describe.runIf(process.platform === "win32")("Windows process discovery", () => {
  it("为单进程与进程组成员读取实际 cwd", async () => {
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
      await once(child, "spawn");
      expect(child.pid).toBeTypeOf("number");

      const summary = await describeProcess(child.pid!);
      expect(summary).toBeDefined();
      expect(isPathInside(summary?.cwd, process.cwd())).toBe(true);

      const members = await processGroupMembers(child.pid!);
      const root = members.find((item) => item.pid === child!.pid);
      expect(root).toBeDefined();
      expect(isPathInside(root?.cwd, process.cwd())).toBe(true);
    } finally {
      child?.kill("SIGTERM");
    }
  }, 15_000);
});
