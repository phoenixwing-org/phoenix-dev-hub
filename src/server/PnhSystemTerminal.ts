import { statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  OpenSystemTerminalResponse,
  SystemTerminalCapability,
} from "../shared/contracts.js";
import { HubError } from "./errors.js";

type SupportedPlatform = "darwin" | "win32" | "linux";

interface TerminalLaunchSpec {
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
}

type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: {
    readonly detached: boolean;
    readonly stdio: "ignore";
    readonly windowsHide: boolean;
  },
) => ChildProcess;

const REMOTE_ENV_KEYS = [
  "SSH_CLIENT",
  "SSH_CONNECTION",
  "SSH_TTY",
  "CODESPACES",
  "REMOTE_CONTAINERS",
  "DEVCONTAINER",
  "PHOENIX_HUB_REMOTE",
] as const;

function hasRemoteEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return REMOTE_ENV_KEYS.some((key) => Boolean(environment[key]));
}

export function pnhSystemTerminalCapability(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): SystemTerminalCapability {
  if (hasRemoteEnvironment(environment)) {
    return { available: false, label: "系统终端", reason: "远程开发环境不允许打开本机终端" };
  }
  if (platform === "darwin") return { available: true, label: "Terminal" };
  if (platform === "win32") return { available: true, label: "PowerShell / CMD" };
  if (platform === "linux") {
    if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY) {
      return { available: false, label: "系统终端", reason: "当前 Linux 会话没有桌面显示环境" };
    }
    return { available: true, label: "桌面终端" };
  }
  return { available: false, label: "系统终端", reason: `暂不支持 ${platform} 平台` };
}

function powershellDirectoryCommand(directory: string): string {
  return `Set-Location -LiteralPath '${directory.replaceAll("'", "''")}'`;
}

function cmdDirectoryCommand(directory: string): string {
  return `cd /d "${directory.replaceAll('"', '""')}"`;
}

export function pnhSystemTerminalLaunchSpecs(
  directory: string,
  platform: SupportedPlatform,
): readonly TerminalLaunchSpec[] {
  if (platform === "darwin") {
    return [{ label: "Terminal", executable: "open", args: ["-a", "Terminal", directory] }];
  }
  if (platform === "win32") {
    return [{
      label: "PowerShell",
      executable: "powershell.exe",
      args: ["-NoLogo", "-NoExit", "-Command", powershellDirectoryCommand(directory)],
    }, {
      label: "CMD",
      executable: "cmd.exe",
      args: ["/D", "/K", cmdDirectoryCommand(directory)],
    }];
  }
  return [{
    label: "桌面终端",
    executable: "x-terminal-emulator",
    args: ["--working-directory", directory],
  }, {
    label: "GNOME Terminal",
    executable: "gnome-terminal",
    args: [`--working-directory=${directory}`],
  }, {
    label: "Konsole",
    executable: "konsole",
    args: ["--workdir", directory],
  }];
}

async function spawnDetached(
  spec: TerminalLaunchSpec,
  spawnProcess: SpawnProcess,
): Promise<void> {
  const child = spawnProcess(spec.executable, spec.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

/** 仅从服务端受控目录打开本机系统终端，不接收浏览器提供的路径或命令。 */
export class PnhSystemTerminal {
  constructor(
    readonly platform: NodeJS.Platform = process.platform,
    readonly environment: NodeJS.ProcessEnv = process.env,
    readonly spawnProcess: SpawnProcess = spawn,
  ) {}

  capability(): SystemTerminalCapability {
    return pnhSystemTerminalCapability(this.platform, this.environment);
  }

  async open(serviceId: string, directory: string): Promise<OpenSystemTerminalResponse> {
    const capability = this.capability();
    if (!capability.available) {
      throw new HubError("SYSTEM_TERMINAL_UNAVAILABLE", capability.reason ?? "系统终端不可用", 409);
    }
    let directoryExists = false;
    try {
      directoryExists = statSync(directory).isDirectory();
    } catch {
      directoryExists = false;
    }
    if (!directoryExists) {
      throw new HubError("SERVICE_CWD_NOT_FOUND", `服务目录不存在：${directory}`, 409);
    }

    const specs = pnhSystemTerminalLaunchSpecs(directory, this.platform as SupportedPlatform);
    let lastError: unknown;
    for (const spec of specs) {
      try {
        await spawnDetached(spec, this.spawnProcess);
        return { opened: true, serviceId, terminalLabel: spec.label };
      } catch (error) {
        lastError = error;
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new HubError("SYSTEM_TERMINAL_OPEN_FAILED", `无法打开系统终端：${message}`, 500);
  }
}
