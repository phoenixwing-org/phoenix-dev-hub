import { describe, expect, it } from "vitest";
import { pnhServiceRibbonIcon } from "./PnhServiceRoleIcons";

describe("PnhServiceRoleIcons", () => {
  it("按服务角色选择稳定的 Ribbon SVG 图标", () => {
    const stopped = { health: "unhealthy", lifecycle: "stopped" } as const;
    expect(pnhServiceRibbonIcon({ ...stopped, definition: { serviceRole: "web" } }).name).toBe("PnhWebServiceIcon");
    expect(pnhServiceRibbonIcon({ ...stopped, definition: { serviceRole: "api" } }).name).toBe("PnhApiServiceIcon");
    expect(pnhServiceRibbonIcon({ ...stopped, definition: { serviceRole: "app" } }).name).toBe("PnhApplicationServiceIcon");
  });
});
