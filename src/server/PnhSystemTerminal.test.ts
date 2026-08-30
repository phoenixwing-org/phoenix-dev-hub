import { describe, expect, it } from "vitest";
import {
  pnhSystemTerminalCapability,
  pnhSystemTerminalLaunchSpecs,
} from "./PnhSystemTerminal.js";

describe("PnhSystemTerminal", () => {
  it("远程环境禁用系统终端", () => {
    expect(pnhSystemTerminalCapability("darwin", { SSH_CONNECTION: "remote" })).toMatchObject({
      available: false,
    });
  });

  it("macOS 使用 Terminal 打开受控目录", () => {
    expect(pnhSystemTerminalLaunchSpecs("/workspace/app", "darwin")).toEqual([{
      label: "Terminal",
      executable: "open",
      args: ["-a", "Terminal", "/workspace/app"],
    }]);
  });

  it("Windows 优先 PowerShell 并回退 CMD", () => {
    const specs = pnhSystemTerminalLaunchSpecs("C:\\workspace\\app", "win32");
    expect(specs.map((spec) => spec.label)).toEqual(["PowerShell", "CMD"]);
    expect(specs[0]?.args.at(-1)).toContain("Set-Location -LiteralPath");
  });

  it("无桌面显示的 Linux 会话禁用系统终端", () => {
    expect(pnhSystemTerminalCapability("linux", {})).toMatchObject({ available: false });
    expect(pnhSystemTerminalCapability("linux", { DISPLAY: ":0" })).toMatchObject({ available: true });
  });
});
