import type { ProcessSummary, StopTargetDetails } from "@shared/contracts";

function value(value: string | number | undefined): string {
  return value === undefined || value === "" ? "不可用" : String(value);
}

function processDetails(process: ProcessSummary, index: number): readonly string[] {
  return [
    `进程 ${index + 1}`,
    `PID: ${process.pid}`,
    `PPID: ${value(process.parentPid)}`,
    `PGID: ${process.processGroupId}`,
    `cwd: ${value(process.cwd)}`,
    `command: ${value(process.command)}`,
  ];
}

/** 生成可复制、可审计的进程停止确认文本。 */
export function pdhProcessStopConfirmationText(
  details: StopTargetDetails,
  force: boolean,
): string {
  return [
    force ? "强制终止确认" : "关闭外部进程确认",
    `服务: ${details.serviceId}`,
    `归属: ${details.ownership === "hub" ? "Hub 管理" : "外部进程"}`,
    `端口: ${details.ports.join(", ") || "未配置"}`,
    `进程组: ${details.processGroupIds.join(", ") || "不可用"}`,
    `配置 cwd: ${details.cwd}`,
    `配置 command: ${details.command}`,
    `影响范围: ${details.impact}`,
    ...details.processes.flatMap((process, index) => ["", ...processDetails(process, index)]),
    "",
    force
      ? "风险: 将发送 SIGKILL，可能丢失未保存数据。"
      : "安全边界: 确认后仍会重新核验 PID、PGID、启动时间、cwd 与端口所有者。",
  ].join("\n");
}
