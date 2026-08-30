import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ProcessSummary } from "../shared/contracts.js";

const execFileAsync = promisify(execFile);

const WINDOWS_PROCESS_QUERY_PID_ENV = "PHOENIX_HUB_PROCESS_QUERY_PID";
const WINDOWS_PROCESS_QUERY_DESCENDANTS_ENV = "PHOENIX_HUB_PROCESS_QUERY_DESCENDANTS";
const WINDOWS_PROCESS_DISCOVERY_SCRIPT = String.raw`
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace PhoenixHub {
  public static class ProcessCurrentDirectory {
    private const uint PROCESS_VM_READ = 0x0010;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const int PROCESS_BASIC_INFORMATION_CLASS = 0;
    private const int PROCESS_WOW64_INFORMATION_CLASS = 26;

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION {
      public IntPtr Reserved1;
      public IntPtr PebBaseAddress;
      public IntPtr Reserved2_0;
      public IntPtr Reserved2_1;
      public IntPtr UniqueProcessId;
      public IntPtr Reserved3;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(
      IntPtr process,
      IntPtr address,
      [Out] byte[] buffer,
      int size,
      out IntPtr bytesRead
    );

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
      IntPtr process,
      int informationClass,
      ref PROCESS_BASIC_INFORMATION information,
      int informationLength,
      out int returnLength
    );

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
      IntPtr process,
      int informationClass,
      ref IntPtr information,
      int informationLength,
      out int returnLength
    );

    public static string TryRead(int processId) {
      IntPtr process = OpenProcess(
        PROCESS_VM_READ | PROCESS_QUERY_LIMITED_INFORMATION,
        false,
        processId
      );
      if (process == IntPtr.Zero) return null;
      try {
        IntPtr pebAddress;
        bool targetIs32Bit;
        if (Environment.Is64BitProcess) {
          IntPtr wow64Peb = IntPtr.Zero;
          int ignored;
          int wow64Status = NtQueryInformationProcess(
            process,
            PROCESS_WOW64_INFORMATION_CLASS,
            ref wow64Peb,
            IntPtr.Size,
            out ignored
          );
          targetIs32Bit = wow64Status == 0 && wow64Peb != IntPtr.Zero;
          pebAddress = targetIs32Bit ? wow64Peb : ReadPebAddress(process);
        } else {
          targetIs32Bit = true;
          pebAddress = ReadPebAddress(process);
        }
        if (pebAddress == IntPtr.Zero) return null;

        int processParametersOffset = targetIs32Bit ? 0x10 : 0x20;
        IntPtr processParameters = ReadPointer(process, Add(pebAddress, processParametersOffset), targetIs32Bit);
        if (processParameters == IntPtr.Zero) return null;

        int currentDirectoryOffset = targetIs32Bit ? 0x24 : 0x38;
        byte[] unicodeString = ReadBytes(
          process,
          Add(processParameters, currentDirectoryOffset),
          targetIs32Bit ? 8 : 16
        );
        int byteLength = BitConverter.ToUInt16(unicodeString, 0);
        if (byteLength <= 0 || byteLength > 32768 || (byteLength % 2) != 0) return null;
        int pointerOffset = targetIs32Bit ? 4 : 8;
        IntPtr bufferAddress = targetIs32Bit
          ? new IntPtr(BitConverter.ToUInt32(unicodeString, pointerOffset))
          : new IntPtr(BitConverter.ToInt64(unicodeString, pointerOffset));
        if (bufferAddress == IntPtr.Zero) return null;
        return Encoding.Unicode.GetString(ReadBytes(process, bufferAddress, byteLength));
      } catch {
        return null;
      } finally {
        CloseHandle(process);
      }
    }

    private static IntPtr ReadPebAddress(IntPtr process) {
      PROCESS_BASIC_INFORMATION information = new PROCESS_BASIC_INFORMATION();
      int ignored;
      int status = NtQueryInformationProcess(
        process,
        PROCESS_BASIC_INFORMATION_CLASS,
        ref information,
        Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)),
        out ignored
      );
      return status == 0 ? information.PebBaseAddress : IntPtr.Zero;
    }

    private static IntPtr ReadPointer(IntPtr process, IntPtr address, bool pointerIs32Bit) {
      byte[] bytes = ReadBytes(process, address, pointerIs32Bit ? 4 : 8);
      return pointerIs32Bit
        ? new IntPtr(BitConverter.ToUInt32(bytes, 0))
        : new IntPtr(BitConverter.ToInt64(bytes, 0));
    }

    private static byte[] ReadBytes(IntPtr process, IntPtr address, int size) {
      byte[] bytes = new byte[size];
      IntPtr bytesRead;
      if (!ReadProcessMemory(process, address, bytes, size, out bytesRead) || bytesRead.ToInt64() != size) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return bytes;
    }

    private static IntPtr Add(IntPtr address, int offset) {
      return new IntPtr(address.ToInt64() + offset);
    }
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
$targetPid = 0
[void][int]::TryParse($env:${WINDOWS_PROCESS_QUERY_PID_ENV}, [ref]$targetPid)
$includeDescendants = $env:${WINDOWS_PROCESS_QUERY_DESCENDANTS_ENV} -eq '1'
$processes = if ($includeDescendants -and $targetPid -gt 0) {
  $rows = @(Get-CimInstance Win32_Process)
  $memberIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$memberIds.Add($targetPid)
  do {
    $changed = $false
    foreach ($row in $rows) {
      if ($memberIds.Contains([int]$row.ParentProcessId) -and $memberIds.Add([int]$row.ProcessId)) {
        $changed = $true
      }
    }
  } while ($changed)
  @($rows | Where-Object { $memberIds.Contains([int]$_.ProcessId) })
} elseif ($targetPid -gt 0) {
  @(Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid")
} else {
  @()
}
$processes | ForEach-Object {
  [pscustomobject]@{
    ProcessId = $_.ProcessId
    ParentProcessId = $_.ParentProcessId
    CommandLine = $_.CommandLine
    CreationDate = $_.CreationDate
    CurrentDirectory = [PhoenixHub.ProcessCurrentDirectory]::TryRead($_.ProcessId)
  }
} | ConvertTo-Json -Compress
`;
const WINDOWS_PROCESS_DISCOVERY_COMMAND = Buffer
  .from(WINDOWS_PROCESS_DISCOVERY_SCRIPT, "utf16le")
  .toString("base64");

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
  const output = await outputOrEmpty("netstat.exe", ["-ano", "-p", "tcp"]);
  return [...new Set(output.split(/\r?\n/u).flatMap((line) => {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP" || columns[3]?.toUpperCase() !== "LISTENING") {
      return [];
    }
    const localPort = Number(columns[1]?.match(/:(\d+)$/u)?.[1]);
    const pid = Number(columns.at(-1));
    return localPort === port && Number.isInteger(pid) && pid > 0 ? [pid] : [];
  }))];
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

async function windowsProcessRows(
  pid: number,
  includeDescendants = false,
): Promise<readonly Record<string, unknown>[]> {
  try {
    const result = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      WINDOWS_PROCESS_DISCOVERY_COMMAND,
    ], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        [WINDOWS_PROCESS_QUERY_PID_ENV]: String(pid),
        [WINDOWS_PROCESS_QUERY_DESCENDANTS_ENV]: includeDescendants ? "1" : "0",
      },
    });
    const output = result.stdout.trim();
    if (!output) return [];
    const raw = JSON.parse(output) as Record<string, unknown> | readonly Record<string, unknown>[];
    return Array.isArray(raw) ? raw : [raw as Record<string, unknown>];
  } catch {
    return [];
  }
}

function windowsProcessSummary(row: Record<string, unknown>): ProcessSummary | undefined {
  const pid = Number(row.ProcessId);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return {
    pid,
    parentPid: Number(row.ParentProcessId) || undefined,
    processGroupId: pid,
    cwd: typeof row.CurrentDirectory === "string" && row.CurrentDirectory
      ? path.resolve(row.CurrentDirectory)
      : undefined,
    command: typeof row.CommandLine === "string" ? row.CommandLine : undefined,
    startedAt: typeof row.CreationDate === "string" ? row.CreationDate : undefined,
    tty: "none",
  };
}

async function windowsProcess(pid: number): Promise<ProcessSummary | undefined> {
  const [row] = await windowsProcessRows(pid);
  return row ? windowsProcessSummary(row) : undefined;
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
    const rows = await windowsProcessRows(processGroupId, true);
    try {
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
        const summary = windowsProcessSummary(row);
        return summary && memberIds.has(summary.pid) ? [summary] : [];
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
