import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ProcessSummary } from "../shared/contracts.js";

const execFileAsync = promisify(execFile);

async function outputOrEmpty(command: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync(command, [...args], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 512 * 1024,
    });
    return result.stdout;
  } catch {
    return "";
  }
}

async function windowsListenerPids(port: number): Promise<readonly number[]> {
  const command = `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess`;
  const output = await outputOrEmpty("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
  return output.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function listenerPids(port: number): Promise<readonly number[]> {
  const output = process.platform === "win32"
    ? await windowsListenerPids(port).then((pids) => pids.join("\n"))
    : await outputOrEmpty("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  return [...new Set(
    output.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0),
  )];
}

async function cwdForPid(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const output = await outputOrEmpty("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  return output.split("\n").find((line) => line.startsWith("n"))?.slice(1) || undefined;
}

async function windowsProcess(pid: number): Promise<ProcessSummary | undefined> {
  const command = [
    `Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`,
    "Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate",
    "ConvertTo-Json -Compress",
  ].join(" | ");
  const output = (await outputOrEmpty(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
  )).trim();
  if (!output) return undefined;
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    return {
      pid,
      parentPid: Number(value.ParentProcessId) || undefined,
      processGroupId: pid,
      command: typeof value.CommandLine === "string" ? value.CommandLine : undefined,
      startedAt: typeof value.CreationDate === "string" ? value.CreationDate : undefined,
      tty: "none",
    };
  } catch {
    return undefined;
  }
}

async function posixProcess(pid: number): Promise<ProcessSummary | undefined> {
  const [line, startedAt, sessionRaw, cwd] = await Promise.all([
    outputOrEmpty("ps", [
      "-p", String(pid),
      "-o", "pid=",
      "-o", "ppid=",
      "-o", "pgid=",
      "-o", "tty=",
      "-o", "command=",
    ]),
    outputOrEmpty("ps", ["-p", String(pid), "-o", "lstart="]),
    outputOrEmpty("ps", ["-p", String(pid), "-o", "sess="])
      .then(async (output) => output || outputOrEmpty("ps", ["-p", String(pid), "-o", "sid="])),
    cwdForPid(pid),
  ]);
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line.trim());
  if (!match || Number(match[1]) !== pid) return undefined;
  const sessionId = Number(sessionRaw.trim());
  return {
    pid,
    parentPid: Number(match[2]),
    processGroupId: Number(match[3]),
    sessionId: Number.isInteger(sessionId) && sessionId >= 0 ? sessionId : undefined,
    cwd,
    command: match[5] || undefined,
    startedAt: startedAt.trim() || undefined,
    tty: match[4] || undefined,
  };
}

export async function describeProcess(pid: number): Promise<ProcessSummary | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return process.platform === "win32" ? windowsProcess(pid) : posixProcess(pid);
}

export async function processGroupMembers(
  processGroupId: number,
): Promise<readonly ProcessSummary[]> {
  if (process.platform === "win32") {
    const output = (await outputOrEmpty("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress",
    ])).trim();
    if (!output) return [];
    try {
      const raw = JSON.parse(output) as Record<string, unknown> | readonly Record<string, unknown>[];
      const rows = Array.isArray(raw) ? raw : [raw];
      const memberIds = new Set<number>([processGroupId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          const pid = Number(row.ProcessId);
          const parentPid = Number(row.ParentProcessId);
          if (!memberIds.has(pid) && memberIds.has(parentPid)) {
            memberIds.add(pid);
            changed = true;
          }
        }
      }
      return rows.flatMap((row): ProcessSummary[] => {
        const pid = Number(row.ProcessId);
        if (!memberIds.has(pid)) return [];
        return [{
          pid,
          parentPid: Number(row.ParentProcessId) || undefined,
          processGroupId: pid,
          command: typeof row.CommandLine === "string" ? row.CommandLine : undefined,
          startedAt: typeof row.CreationDate === "string" ? row.CreationDate : undefined,
          tty: "none",
        }];
      });
    } catch {
      return [];
    }
  }
  const output = await outputOrEmpty("ps", ["-ax", "-o", "pid=", "-o", "pgid="]);
  const pids = output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    return match && Number(match[2]) === processGroupId ? [Number(match[1])] : [];
  });
  return (await Promise.all(pids.map(describeProcess))).filter(
    (item): item is ProcessSummary => Boolean(item),
  );
}

export async function discoverProcesses(ports: readonly number[]): Promise<readonly ProcessSummary[]> {
  const pidLists = await Promise.all(ports.map(listenerPids));
  const pids = [...new Set(pidLists.flat())];
  return (await Promise.all(pids.map(describeProcess))).filter(
    (item): item is ProcessSummary => Boolean(item),
  );
}

export function isPathInside(candidate: string | undefined, root: string): boolean {
  if (!candidate) return false;
  const canonical = (value: string) => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const relative = path.relative(canonical(root), canonical(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function sameProcessIdentity(
  expected: ProcessSummary,
  current: ProcessSummary | undefined,
): boolean {
  if (!current || !expected.startedAt || !current.startedAt) return false;
  return expected.pid === current.pid
    && expected.processGroupId === current.processGroupId
    && expected.startedAt === current.startedAt
    && expected.cwd === current.cwd
    && expected.command === current.command;
}

export async function isProcessIdentityAlive(identity: ProcessSummary): Promise<boolean> {
  return sameProcessIdentity(identity, await describeProcess(identity.pid));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
