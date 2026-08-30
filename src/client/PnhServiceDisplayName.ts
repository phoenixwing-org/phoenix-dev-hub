import type { ServiceDefinition } from "@shared/contracts";

const roleLabels: Readonly<Record<string, string>> = {
  api: "API",
  app: "应用",
  web: "Web",
};

/**
 * Ribbon 单项宽度有限：保留实例的语义词，省去会与角色、产品名重复的修饰。
 * 这是纯展示层的缩写，不改变服务配置中的完整实例名称。
 */
const profileDisplayAliases: Readonly<Record<string, string>> = {
  "稳定测试": "测试",
  "干净安装验证": "安装",
  "8.x / Midway 4 联调": "联调",
  "默认实例": "默认",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 单体应用在 Ribbon 中先显示站点辨识词，避免“默认实例”占据首行。 */
function appModuleHint(moduleName: string): string {
  return moduleName
    .replace(/^Phoenix\s+/i, "")
    .replace(/^Open\s+/i, "")
    || moduleName;
}

/** 在已由 Series 标题说明网站时，去掉 Profile 中重复的网站前缀。 */
export function pnhServiceProfileDisplayName(
  definition: Pick<ServiceDefinition, "moduleName" | "profileName">,
): string {
  const profileName = definition.profileName ?? "默认实例";
  const modulePrefixes = [
    definition.moduleName,
    definition.moduleName.replace(/^Phoenix\s+/i, ""),
  ].filter(Boolean);
  const withoutModulePrefix = modulePrefixes.reduce(
    (result, prefix) => result.replace(new RegExp(`^${escapeRegExp(prefix)}\\s+`, "i"), ""),
    profileName,
  );
  return profileDisplayAliases[withoutModulePrefix] ?? withoutModulePrefix;
}

/** 同一服务在导航和表格中使用的上下文显示名，避免同系列 Web/API 重名。 */
export function pnhServiceDisplayName(
  definition: Pick<ServiceDefinition, "moduleName" | "profileName" | "serviceRole">,
): string {
  const profile = pnhServiceProfileDisplayName(definition);
  if (definition.serviceRole === "app") {
    return `${appModuleHint(definition.moduleName)} · ${profile} · ${definition.moduleName}`;
  }
  const role = definition.serviceRole ? (roleLabels[definition.serviceRole] ?? definition.serviceRole) : "";
  if (definition.moduleName.startsWith("Cool ")) {
    return `Cool${role ? ` ${role}` : ""} · ${definition.moduleName.slice("Cool ".length)}`;
  }
  return `${profile}${role ? ` ${role}` : ""} · ${definition.moduleName}`;
}
