import type { LogEntry } from "../shared/contracts.js";

const SENSITIVE_KEY = "(?:password|passwd|pwd|access_?token|refresh_?token|token|client_?secret|app_?secret|secret|captcha|verify_?code|ticket|oauth_?code)";
const SENSITIVE_KEY_VALUE = new RegExp(
  `(["']?${SENSITIVE_KEY}["']?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^,;\\s}]+)`,
  "gi",
);

export function pnhSanitizeServiceLogText(text: string): string {
  return text
    .replace(/(\bAuthorization\s*[:=]\s*)(Bearer|Basic)\s+\S+/gi, "$1$2 [REDACTED]")
    .replace(/(\bAuthorization\s*[:=]\s*)(?!Bearer\b|Basic\b)\S+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(new RegExp(`([?&]${SENSITIVE_KEY}=)[^&\\s]*`, "gi"), "$1[REDACTED]")
    .replace(SENSITIVE_KEY_VALUE, (match, prefix: string) => {
      const value = match.slice(prefix.length);
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
      return `${prefix}${quote}[REDACTED]${quote}`;
    });
}

export class ServiceLogBuffer {
  readonly #entries: LogEntry[] = [];
  readonly #partial = new Map<"stdout" | "stderr", string>();
  #sequence = 1;
  #generation = 1;
  #totalWritten = 0;

  constructor(private readonly capacity = 500) {}

  append(stream: LogEntry["stream"], text: string): void {
    const normalized = text.replaceAll("\r\n", "\n");
    this.#push(stream, normalized);
  }

  appendChunk(stream: "stdout" | "stderr", chunk: Buffer | string): void {
    const combined = (this.#partial.get(stream) ?? "") + chunk.toString().replaceAll("\r\n", "\n");
    const lines = combined.split("\n");
    this.#partial.set(stream, lines.pop() ?? "");
    for (const line of lines) this.#push(stream, line);
  }

  flush(stream: "stdout" | "stderr"): void {
    const partial = this.#partial.get(stream);
    if (partial) this.#push(stream, partial);
    this.#partial.delete(stream);
  }

  after(sequence: number): readonly LogEntry[] {
    return this.#entries.filter((entry) => entry.sequence > sequence);
  }

  snapshot(afterSequence = 0, generation?: number): {
    readonly generation: number;
    readonly entries: readonly LogEntry[];
    readonly nextSequence: number;
    readonly retainedCount: number;
    readonly capacity: number;
    readonly totalWritten: number;
  } {
    const entries = generation === undefined || generation !== this.#generation
      ? [...this.#entries]
      : this.after(afterSequence);
    return {
      generation: this.#generation,
      entries,
      nextSequence: this.#sequence,
      retainedCount: this.#entries.length,
      capacity: this.capacity,
      totalWritten: this.#totalWritten,
    };
  }

  /** 清空当前 Hub 会话日志并切换 generation，旧游标不会触发历史回放。 */
  clear(): ReturnType<ServiceLogBuffer["snapshot"]> {
    this.#entries.splice(0);
    this.#partial.clear();
    this.#sequence = 1;
    this.#totalWritten = 0;
    this.#generation += 1;
    return this.snapshot(0, this.#generation);
  }

  get nextSequence(): number {
    return this.#sequence;
  }

  get generation(): number {
    return this.#generation;
  }

  #push(stream: LogEntry["stream"], text: string): void {
    if (text === "") return;
    this.#entries.push({
      sequence: this.#sequence++,
      timestamp: new Date().toISOString(),
      stream,
      text: pnhSanitizeServiceLogText(text),
    });
    this.#totalWritten += 1;
    if (this.#entries.length > this.capacity) {
      this.#entries.splice(0, this.#entries.length - this.capacity);
    }
  }
}
