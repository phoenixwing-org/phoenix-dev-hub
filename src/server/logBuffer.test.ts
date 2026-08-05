import { describe, expect, it } from "vitest";
import { ServiceLogBuffer } from "./logBuffer.js";

describe("ServiceLogBuffer", () => {
  it("按行合并数据块并保留递增序号", () => {
    const logs = new ServiceLogBuffer(10);
    logs.appendChunk("stdout", "first\nsec");
    logs.appendChunk("stdout", "ond\n");
    logs.append("system", "done");

    expect(logs.after(0).map((entry) => [entry.sequence, entry.stream, entry.text])).toEqual([
      [1, "stdout", "first"],
      [2, "stdout", "second"],
      [3, "system", "done"],
    ]);
    expect(logs.after(1)).toHaveLength(2);
    expect(logs.nextSequence).toBe(4);
  });

  it("超出容量时只保留最近记录", () => {
    const logs = new ServiceLogBuffer(2);
    logs.append("system", "one");
    logs.append("system", "two");
    logs.append("system", "three");
    expect(logs.after(0).map((entry) => entry.text)).toEqual(["two", "three"]);
    expect(logs.snapshot()).toMatchObject({ retainedCount: 2, capacity: 2, totalWritten: 3 });
  });

  it("清空后切换 generation，不会用旧游标回填历史，新日志仍可追加", () => {
    const logs = new ServiceLogBuffer(500);
    for (let index = 0; index < 510; index += 1) logs.append("stdout", `old-${index}`);
    const before = logs.snapshot(0, logs.generation);
    expect(before).toMatchObject({ retainedCount: 500, capacity: 500, totalWritten: 510 });

    const cleared = logs.clear();
    expect(cleared.generation).toBe(before.generation + 1);
    expect(cleared.entries).toEqual([]);
    expect(cleared).toMatchObject({ retainedCount: 0, totalWritten: 0, nextSequence: 1 });

    // 即使客户端重连时仍携带旧 generation，服务端也只能返回新 generation 的内容。
    expect(logs.snapshot(0, before.generation).entries).toEqual([]);
    logs.append("stdout", "new-line");
    expect(logs.snapshot(0, before.generation).entries.map((entry) => entry.text)).toEqual(["new-line"]);
    expect(logs.snapshot(0, cleared.generation)).toMatchObject({
      retainedCount: 1,
      totalWritten: 1,
      nextSequence: 2,
    });
  });
});
