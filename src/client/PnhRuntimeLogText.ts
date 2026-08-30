import type { LogEntry } from "@shared/contracts";

export function pnhDisplayLogText(text: string): string {
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function pnhRuntimeLogClipboardText(entries: readonly LogEntry[]): string {
  return entries
    .map((entry) => {
      const timestamp = new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
      return `[${timestamp}] ${entry.stream.toUpperCase()} ${pnhDisplayLogText(entry.text)}`;
    })
    .join("\n");
}
