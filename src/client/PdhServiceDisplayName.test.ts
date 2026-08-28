import { describe, expect, it } from "vitest";
import type { ServiceDefinition } from "@shared/contracts";
import {
  pdhServiceDisplayName,
  pdhServiceProfileDisplayName,
} from "./PdhServiceDisplayName";

function definition(input: Pick<ServiceDefinition, "moduleName" | "profileName" | "serviceRole">) {
  return input;
}

describe("PdhServiceDisplayName", () => {
  it("去掉与 Phoenix Admin Series 重复的实例前缀", () => {
    const value = definition({
      moduleName: "Phoenix Admin",
      profileName: "Admin 进行中",
      serviceRole: "api",
    });
    expect(pdhServiceProfileDisplayName(value)).toBe("进行中");
    expect(pdhServiceDisplayName(value)).toBe("进行中 API · Phoenix Admin");
  });

  it("将常用实例名缩写为适合 Ribbon 的短标签", () => {
    expect(pdhServiceProfileDisplayName(definition({
      moduleName: "Phoenix Admin",
      profileName: "Admin 稳定测试",
      serviceRole: "web",
    }))).toBe("测试");
    expect(pdhServiceProfileDisplayName(definition({
      moduleName: "Phoenix Admin",
      profileName: "Admin 干净安装验证",
      serviceRole: "web",
    }))).toBe("安装");
    expect(pdhServiceProfileDisplayName(definition({
      moduleName: "Cool Admin Midway 4",
      profileName: "8.x / Midway 4 联调",
      serviceRole: "api",
    }))).toBe("联调");
    expect(pdhServiceDisplayName(definition({
      moduleName: "Cool Admin Midway 4",
      profileName: "8.x / Midway 4 联调",
      serviceRole: "api",
    }))).toBe("Cool API · Admin Midway 4");
  });

  it("单体应用先显示站点辨识词，再显示默认实例", () => {
    const value = definition({
      moduleName: "Phoenix Open Issue",
      profileName: "默认实例",
      serviceRole: "app",
    });
    expect(pdhServiceDisplayName(value)).toBe("Issue · 默认 · Phoenix Open Issue");
  });
});
