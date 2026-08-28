import { describe, expect, it } from "vitest";
import { pdhServiceRibbonIcon } from "./PdhServiceRoleIcons";

describe("PdhServiceRoleIcons", () => {
  it("按服务角色选择稳定的 Ribbon SVG 图标", () => {
    const stopped = { health: "unhealthy", lifecycle: "stopped" } as const;
    expect(pdhServiceRibbonIcon({ ...stopped, definition: { serviceRole: "web" } }).name).toBe("PdhWebServiceIcon");
    expect(pdhServiceRibbonIcon({ ...stopped, definition: { serviceRole: "api" } }).name).toBe("PdhApiServiceIcon");
    expect(pdhServiceRibbonIcon({ ...stopped, definition: { serviceRole: "app" } }).name).toBe("PdhApplicationServiceIcon");
  });
});
