import { describe, expect, it } from "vitest";
import { pdhDisplayLogText, pdhRuntimeLogClipboardText } from "./PdhRuntimeLogText";

describe("Hub 运行日志复制文本", () => {
  it("移除 ANSI 控制符并保留换行和日志流", () => {
    const text = pdhRuntimeLogClipboardText([
      {
        sequence: 1,
        timestamp: "2026-08-13T04:30:00.000Z",
        stream: "stderr",
        text: "\u001B[31mfirst error\u001B[0m\nnext line",
      },
    ]);

    expect(text).toContain("STDERR first error\nnext line");
    expect(text).not.toContain("\u001B");
  });

  it("空日志复制为空字符串", () => {
    expect(pdhRuntimeLogClipboardText([])).toBe("");
    expect(pdhDisplayLogText("plain")).toBe("plain");
  });
});
