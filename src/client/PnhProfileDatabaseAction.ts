import type { ServiceRuntimeStatus } from "@shared/contracts";

export interface PnhProfileDatabaseConfirmation {
  readonly databaseName: string;
  readonly confirmation: string;
  readonly message: string;
}

/** 构造 UI 与 API 共用的显式建库确认；不接受密码、DSN 或任意 SQL。 */
export function pnhProfileDatabaseConfirmation(
  service: ServiceRuntimeStatus,
): PnhProfileDatabaseConfirmation | undefined {
  const policy = service.definition.profilePolicy;
  const databaseName = policy?.database.name;
  const cleanupResponsibility = policy?.database.preflight?.creation?.cleanupResponsibility;
  if (
    policy?.environmentKind !== "release-validation"
    || !databaseName
    || !cleanupResponsibility
  ) return undefined;
  return {
    databaseName,
    confirmation: `create-release-validation-database:${databaseName}`,
    message: [
      `创建发布验收隔离数据库 ${databaseName}？`,
      "该动作与“启动”分离，只允许本机 PostgreSQL、精确 allowlist 且数据库原先不存在。",
      `回收责任：${cleanupResponsibility}`,
    ].join("\n\n"),
  };
}
