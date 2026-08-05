import type { ServiceBuildStatus } from "../shared/contracts.js";

const FAILURE_PATTERNS = [
  /\berror TS\d{4}:/i,
  /\bFound [1-9]\d* errors?\b/i,
  /\b(?:compilation|build) failed\b/i,
  /\bFailed to compile\b/i,
  /\bTSError:/i,
] as const;

const SUCCESS_PATTERNS = [
  /\bFound 0 errors?\b/i,
  /\bcompiled successfully\b/i,
  /\bbuild (?:completed|finished) successfully\b/i,
] as const;

const BUILDING_PATTERNS = [
  /\bStarting compilation in watch mode\b/i,
  /\bFile change detected\. Starting incremental compilation\b/i,
] as const;

function compactMessage(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, 300);
}

/**
 * 从受控进程的连续输出中提取通用 TypeScript/build 状态。
 * 仅匹配明确的失败/成功信号，普通 stderr 与 warning 不会误判为构建失败。
 */
export class PdhBuildOutputTracker {
  readonly #partial = new Map<"stdout" | "stderr", string>();
  #status: ServiceBuildStatus = { state: "unknown" };

  appendChunk(stream: "stdout" | "stderr", chunk: Buffer | string): void {
    const combined = (this.#partial.get(stream) ?? "")
      + chunk.toString().replaceAll("\r\n", "\n");
    const lines = combined.split("\n");
    this.#partial.set(stream, lines.pop() ?? "");
    for (const line of lines) this.#inspect(line);
  }

  flush(stream: "stdout" | "stderr"): void {
    const partial = this.#partial.get(stream);
    if (partial) this.#inspect(partial);
    this.#partial.delete(stream);
  }

  snapshot(): ServiceBuildStatus {
    return { ...this.#status };
  }

  #inspect(line: string): void {
    const message = compactMessage(line);
    if (!message) return;
    if (FAILURE_PATTERNS.some((pattern) => pattern.test(message))) {
      this.#status = { state: "failed", message, updatedAt: new Date().toISOString() };
      return;
    }
    if (SUCCESS_PATTERNS.some((pattern) => pattern.test(message))) {
      this.#status = { state: "ready", message, updatedAt: new Date().toISOString() };
      return;
    }
    if (BUILDING_PATTERNS.some((pattern) => pattern.test(message))) {
      this.#status = { state: "building", message, updatedAt: new Date().toISOString() };
    }
  }
}
