export type ServiceLifecycleState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "external"
  | "conflict";

export type ServiceHealthState = "ready" | "reachable" | "partial" | "unhealthy" | "unknown";
export type EndpointProbeState = "healthy" | "unhealthy" | "reachable-unverified" | "unreachable";
export type ServiceBuildState = "unknown" | "building" | "ready" | "failed";
export type ServiceOwnership = "hub" | "external" | "none" | "conflict";
export type ServiceLogSource = "captured" | "recovered-ownership" | "monitoring-only";
export type ServiceEnvironmentKind =
  | "development"
  | "release-validation"
  | "preproduction"
  | "production";
export type ServiceDeploymentMode = "source-mounted" | "package-assembled";

export interface ServiceProfilePostgresPreflightPolicy {
  readonly provider: "postgresql";
  readonly host: string;
  readonly port: number;
  readonly maintenanceDatabase: string;
  /** 只保存环境变量名；用户名与密码本身不得进入服务配置。 */
  readonly usernameEnv: string;
  readonly passwordEnv: string;
  /** spawn 前必须存在的 Host/Pah 基线关系；只接受安全 SQL 标识符。 */
  readonly requiredRelations?: readonly string[];
  /** provisional 不足以放行启动；收到版本化真源清单后改为 versioned-manifest。 */
  readonly requiredRelationsStatus?: "provisional" | "versioned-manifest";
  /** 仅供显式 release-validation 建库动作使用；普通 start 永远不会消费此配置执行写操作。 */
  readonly creation?: {
    readonly allowedDatabaseNames: readonly string[];
    readonly cleanupResponsibility: string;
  };
}

export interface ServiceProfileDatabasePolicy {
  readonly serviceRole: string;
  readonly envName: string;
  readonly name: string;
  readonly forbiddenNames?: readonly string[];
  readonly preflight?: ServiceProfilePostgresPreflightPolicy;
}

export interface ServiceProfileDatabaseEvidence {
  readonly state: "ready" | "missing" | "uninitialized" | "unavailable" | "not-configured";
  readonly databaseName: string;
  readonly server: string;
  readonly exists: boolean | null;
  readonly message: string;
  readonly checkedAt: string;
  readonly missingRelations?: readonly string[];
  readonly requiredRelationsStatus?: "provisional" | "versioned-manifest";
  readonly cleanupResponsibility?: string;
}

export interface CreateProfileDatabaseRequest {
  readonly confirm: string;
}

export interface ServiceProfileDatabaseCreationEvidence extends ServiceProfileDatabaseEvidence {
  readonly state: "ready" | "uninitialized";
  readonly exists: true;
  readonly existingBefore: false;
  readonly createdAt: string;
  readonly cleanupResponsibility: string;
  readonly evidenceFile: string;
}

export interface ServiceProfileGitInput {
  readonly root: string;
  readonly commit: string;
}

export interface ServiceProfileRegistryPackage {
  readonly serviceRole: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
}

export interface ServiceProfileAssemblyPolicy {
  readonly outputRoot: string;
  readonly roleDirectories: Readonly<Record<string, string>>;
  readonly packagePath: string;
  readonly packageSha256: string;
  readonly packageKind: "pah-business-module";
  readonly moduleId: string;
  readonly version: string;
  readonly nodeHost: ServiceProfileGitInput;
  readonly vueHost: ServiceProfileGitInput;
  readonly registryPackages: readonly ServiceProfileRegistryPackage[];
  readonly installDependencies?: boolean;
}

export interface ServiceProfilePolicy {
  readonly environmentKind: ServiceEnvironmentKind;
  readonly deploymentMode: ServiceDeploymentMode;
  /** production 必须为 false；其他环境默认 true。 */
  readonly lifecycleControl?: boolean;
  readonly database: ServiceProfileDatabasePolicy;
  readonly assembly?: ServiceProfileAssemblyPolicy;
}

export type ServiceProfileEvidenceState =
  | "source-mounted"
  | "unprepared"
  | "verified"
  | "invalid";

export interface ServiceProfileEvidence {
  readonly state: ServiceProfileEvidenceState;
  readonly environmentKind: ServiceEnvironmentKind;
  readonly deploymentMode: ServiceDeploymentMode;
  readonly message: string;
  readonly databaseName: string;
  readonly packageSha256?: string;
  readonly nodeCommit?: string;
  readonly vueCommit?: string;
  readonly wingSource?: "registry" | "source";
  readonly wingVersion?: string;
  readonly wingIntegrity?: string;
  readonly lockVerified?: boolean;
  readonly verifiedAt?: string;
  readonly database?: ServiceProfileDatabaseEvidence;
}

export interface ServiceEndpointDefinition {
  readonly id: string;
  readonly label: string;
  readonly port: number;
  readonly openUrl?: string;
  readonly healthUrl?: string;
  /** 默认 true；可选端点不阻止服务进入 ready。 */
  readonly required?: boolean;
}

/** 可选的 HTTP JSON 身份证明；可同时校验服务名、版本等稳定字段。 */
export interface ServiceIdentityDefinition {
  readonly url: string;
  readonly expected: Readonly<Record<string, string | number | boolean>>;
}

export interface ServiceCommandDefinition {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface ServiceDefinition {
  readonly id: string;
  readonly name: string;
  /** 一套网站对应一个模块；同一模块可以包含 Web/API 等多个受控进程。 */
  readonly moduleId: string;
  readonly moduleName: string;
  readonly description?: string;
  readonly cwd: string;
  readonly command: ServiceCommandDefinition;
  readonly endpoints: readonly ServiceEndpointDefinition[];
  readonly identity?: ServiceIdentityDefinition;
  readonly externalStop?: "deny" | "confirm-matching-cwd";
  /** 仅本机私有项目服务存在；内置受控清单不提供此字段。 */
  readonly localProjectId?: string;
  readonly configurationSource?: "builtin" | "user";
  readonly configurationOverridden?: boolean;
  /** 本机配置仍会加载，但存在这些错误时禁止启动并在服务总览中提示。 */
  readonly configurationErrors?: readonly string[];
  /** version 2 分组元数据；旧版与 User 项目可由 moduleId 自动推导。 */
  readonly seriesId?: string;
  readonly seriesName?: string;
  readonly profileId?: string;
  readonly profileName?: string;
  readonly serviceRole?: string;
  readonly runtimeSlot?: string;
  readonly profileMetadata?: ServiceProfileMetadata;
  readonly profilePolicy?: ServiceProfilePolicy;
  readonly startOrder?: number;
}

export interface ServiceProfileMetadata {
  readonly wingVersion?: string;
  readonly description?: string;
  /** 服务详情面板展示的人工联调步骤；不作为自动健康门禁。 */
  readonly testGuide?: string;
  /** 输入源码/版本的简短冻结证据。 */
  readonly sourceBaseline?: string;
  readonly [key: string]: string | undefined;
}

/** Series 模板或 Profile 覆盖中的服务片段。合并后必须形成完整 ServiceDefinition。 */
export interface ServiceSourceDefinition {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly cwd?: string;
  readonly command?: {
    readonly executable?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>> | null;
  };
  readonly endpoints?: readonly ServiceEndpointDefinition[];
  readonly identity?: ServiceIdentityDefinition | null;
  readonly externalStop?: "deny" | "confirm-matching-cwd";
  readonly startOrder?: number;
}

export interface ServiceSeriesTemplate {
  readonly runtimeSlot?: string;
  readonly services: Readonly<Record<string, ServiceSourceDefinition>>;
}

export interface ServiceProfileSource {
  readonly id: string;
  readonly name: string;
  readonly runtimeSlot?: string;
  readonly metadata?: ServiceProfileMetadata;
  readonly policy?: ServiceProfilePolicy;
  /** false 表示该 Profile 不包含模板中的对应服务。 */
  readonly services: Readonly<Record<string, ServiceSourceDefinition | false>>;
}

export interface ServiceSeriesSource {
  readonly id: string;
  readonly name: string;
  readonly template: ServiceSeriesTemplate;
  readonly profiles: readonly ServiceProfileSource[];
}

export interface ServiceConfigurationFileV2 {
  readonly version: 2;
  readonly series: readonly ServiceSeriesSource[];
}

export type NodePackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface LocalNodeProject {
  readonly id: string;
  readonly serviceId: string;
  readonly name: string;
  readonly directory: string;
  readonly script: string;
  readonly packageManager: NodePackageManager;
  readonly createdAt: string;
}

export interface LocalNodeProjectCandidate {
  readonly name: string;
  readonly directory: string;
  readonly scripts: readonly string[];
  readonly packageManager: NodePackageManager;
  readonly configured: boolean;
}

export interface LocalProjectCatalogResponse {
  readonly defaultRoot: string;
  readonly projects: readonly LocalNodeProject[];
  readonly candidates: readonly LocalNodeProjectCandidate[];
}

export interface AddLocalProjectRequest {
  readonly directory: string;
  readonly script: string;
  readonly name?: string;
}

export interface AddLocalProjectResponse {
  readonly project: LocalNodeProject;
  readonly service: ServiceRuntimeStatus;
}

export interface UpdateLocalProjectRequest extends AddLocalProjectRequest {}

export interface UpdateLocalProjectResponse extends AddLocalProjectResponse {}

export interface DeleteLocalProjectResponse {
  readonly removed: true;
  readonly project: LocalNodeProject;
}

export interface LocalProjectTransferItem {
  readonly name: string;
  readonly directory: string;
  readonly script: string;
}

export interface LocalProjectTransferDocument {
  readonly format: "phoenix-dev-hub-projects";
  readonly version: 1;
  readonly projects: readonly LocalProjectTransferItem[];
}

export interface BuiltinServiceConfigEntry {
  readonly id: string;
  readonly source: "builtin";
  readonly removed: boolean;
  readonly overridden: boolean;
  readonly baseline: ServiceDefinition;
  readonly definition?: ServiceDefinition;
}

export interface BuiltinServiceConfigCatalogResponse {
  readonly services: readonly BuiltinServiceConfigEntry[];
  readonly series: readonly BuiltinServiceSeriesConfigEntry[];
}

export interface BuiltinServiceSeriesConfigEntry {
  readonly id: string;
  readonly source: "builtin";
  readonly overridden: boolean;
  readonly baseline: ServiceSeriesSource;
  readonly definition: ServiceSeriesSource;
  readonly services: readonly ServiceDefinition[];
}

export interface DevHubConfigurationDocumentV1 {
  readonly format: "phoenix-dev-hub-config";
  readonly version: 1;
  readonly services: readonly ServiceDefinition[];
  readonly projects: readonly LocalProjectTransferItem[];
}

export interface DevHubConfigurationDocumentV2 {
  readonly format: "phoenix-dev-hub-config";
  readonly version: 2;
  readonly series: readonly ServiceSeriesSource[];
  readonly hiddenServiceIds: readonly string[];
  readonly projects: readonly LocalProjectTransferItem[];
}

export type DevHubConfigurationDocument =
  | DevHubConfigurationDocumentV1
  | DevHubConfigurationDocumentV2;

export interface ImportDevHubConfigurationResponse {
  readonly builtinUpdated: number;
  readonly seriesUpdated?: number;
  readonly projectsAdded: number;
  readonly projectsUpdated: number;
  readonly services: readonly ServiceRuntimeStatus[];
}

export interface ImportLocalProjectsResponse {
  readonly projects: readonly LocalNodeProject[];
  readonly added: number;
  readonly updated: number;
  readonly services: readonly ServiceRuntimeStatus[];
}

export interface EndpointStatus extends ServiceEndpointDefinition {
  readonly reachable: boolean;
  readonly healthy: boolean | null;
  readonly probeState: EndpointProbeState;
  readonly probeMessage: string;
  readonly statusCode?: number;
  readonly pids: readonly number[];
}

export interface ProcessSummary {
  readonly pid: number;
  readonly parentPid?: number;
  readonly processGroupId: number;
  readonly sessionId?: number;
  readonly cwd?: string;
  readonly command?: string;
  /** `ps lstart` 的稳定原始值，用于防止 PID 复用。 */
  readonly startedAt?: string;
  readonly tty?: string;
}

export interface ServiceBuildStatus {
  readonly state: ServiceBuildState;
  readonly message?: string;
  readonly updatedAt?: string;
}

export interface ServiceRuntimeStatus {
  readonly definition: ServiceDefinition;
  readonly profileEvidence?: ServiceProfileEvidence;
  readonly lifecycle: ServiceLifecycleState;
  readonly health: ServiceHealthState;
  /** 仅来自当前 Hub-owned 进程输出；HTTP 2xx 不能覆盖明确的构建失败。 */
  readonly build: ServiceBuildStatus;
  readonly ownership: ServiceOwnership;
  readonly managed: boolean;
  readonly pid?: number;
  readonly processGroupId?: number;
  readonly ownershipId?: string;
  readonly rootProcess?: ProcessSummary;
  readonly startedAt?: string;
  readonly exitedAt?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly endpoints: readonly EndpointStatus[];
  readonly externalProcesses: readonly ProcessSummary[];
  readonly identityMatched: boolean | null;
  readonly identityMessage?: string;
  readonly logSource: ServiceLogSource;
  readonly message?: string;
}

export interface LogEntry {
  readonly sequence: number;
  readonly timestamp: string;
  readonly stream: "system" | "stdout" | "stderr";
  readonly text: string;
}

export interface ServiceListResponse {
  readonly services: readonly ServiceRuntimeStatus[];
  readonly generatedAt: string;
  /** 配置文件整体无法解析时仍启动 Hub，并在前端展示这些错误。 */
  readonly configurationErrors?: readonly string[];
}

export interface ServiceLogsResponse {
  readonly serviceId: string;
  readonly generation: number;
  readonly entries: readonly LogEntry[];
  readonly nextSequence: number;
  readonly retainedCount: number;
  readonly capacity: number;
  readonly totalWritten: number;
  readonly available: boolean;
  readonly source: ServiceLogSource;
  readonly message?: string;
}

export type StopServiceMode = "request" | "confirm-external" | "force";

export interface StopServiceRequest {
  readonly mode?: StopServiceMode;
  readonly token?: string;
}

export interface StopTargetDetails {
  readonly serviceId: string;
  readonly ownership: "hub" | "external";
  readonly token: string;
  readonly expiresAt: string;
  readonly ports: readonly number[];
  readonly processGroupIds: readonly number[];
  readonly processes: readonly ProcessSummary[];
  readonly command: string;
  readonly cwd: string;
  readonly impact: string;
}

export interface SystemTerminalCapability {
  readonly available: boolean;
  readonly label: string;
  readonly reason?: string;
}

export interface HostCapabilitiesResponse {
  readonly systemTerminal: SystemTerminalCapability;
}

export interface OpenSystemTerminalResponse {
  readonly opened: true;
  readonly serviceId: string;
  readonly terminalLabel: string;
}

export interface HubRuntimeInfo {
  readonly name: "Phoenix Dev Hub";
  readonly version: string;
  readonly address: string;
  readonly projectRoot: string;
  readonly systemTerminal: SystemTerminalCapability;
  readonly restartSupported: false;
  readonly restartMessage: string;
}

export interface ShutdownHubResponse {
  readonly accepted: true;
  readonly message: string;
}

export type AdminPluginMountKind = "web" | "node";
export type AdminPluginPathState =
  | "mounted"
  | "missing"
  | "occupied"
  | "foreign-link"
  | "invalid";
export type AdminPluginMountState = "mounted" | "unmounted" | "partial" | "conflict" | "unavailable";

export interface AdminPluginRouteDeclaration {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

export interface AdminPluginMigrationDeclaration {
  readonly id: string;
  readonly version: number;
  readonly checksum: string;
  readonly description: string;
  readonly artifact: { readonly format: "sql"; readonly path: string };
}

/** Hub 只消费 Admin Plugin Manifest v2 的开发编排字段，不替代 Pah 的权威校验。 */
export interface AdminPluginManifestSummary {
  readonly formatVersion: 2;
  readonly moduleId: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly activationMode: string;
  readonly routePrefix: string;
  readonly entrypoints: { readonly web: string; readonly node: string };
  readonly routes: readonly AdminPluginRouteDeclaration[];
  readonly preferredGroupId: string;
  readonly migrations: readonly AdminPluginMigrationDeclaration[];
}

export interface AdminPluginCandidate {
  readonly productRoot: string;
  readonly pluginRoot: string;
  readonly manifestPath: string;
  readonly webModulePath: string;
  readonly nodeModulePath: string;
  readonly artifactsPath?: string;
  readonly sourceCommit?: string;
  readonly configured: boolean;
  readonly mountAllowed: boolean;
  readonly validationWarnings: readonly string[];
  readonly manifest: AdminPluginManifestSummary;
}

export interface AdminPluginRegistration {
  readonly id: string;
  readonly productRoot: string;
  readonly manifestPath: string;
  readonly createdAt: string;
  /** 新登记会保存稳定身份快照，让旧 worktree 不可用时仍能安全校验重新指向。 */
  readonly moduleId?: string;
  readonly name?: string;
  readonly manifestVersion?: string;
  readonly updatedAt?: string;
}

export interface AdminPluginIdentity {
  readonly moduleId?: string;
  readonly name: string;
  readonly version?: string;
}

export interface AdminPluginMountPath {
  readonly kind: AdminPluginMountKind;
  readonly label: string;
  readonly source: string;
  readonly target: string;
  readonly excludePath: string;
  readonly excludePattern: string;
  readonly linkState: AdminPluginPathState;
  readonly excludeState: "managed" | "missing" | "invalid";
  readonly linkValue?: string;
  readonly detail?: string;
}

export interface AdminPluginOperationChange {
  readonly kind: AdminPluginMountKind;
  readonly action:
    | "created-link"
    | "removed-link"
    | "replaced-link"
    | "claimed-link"
    | "added-exclude"
    | "removed-exclude"
    | "unchanged";
  readonly path: string;
  readonly detail: string;
}

export interface AdminPluginOperationResult {
  readonly action: "mount" | "unmount" | "repoint";
  readonly completedAt: string;
  readonly changes: readonly AdminPluginOperationChange[];
}

export interface AdminPluginStatus {
  readonly registration: AdminPluginRegistration;
  readonly identity: AdminPluginIdentity;
  readonly sourceState: "available" | "unavailable";
  readonly sourceError?: { readonly code: string; readonly message: string };
  readonly candidate?: AdminPluginCandidate;
  readonly mountState: AdminPluginMountState;
  readonly mounts: readonly AdminPluginMountPath[];
  readonly recentOperation?: AdminPluginOperationResult;
}

export interface AdminPluginWorkspaceSettings {
  readonly adminWebRoot: string;
  readonly adminNodeRoot: string;
  readonly adminWebServiceId: string;
  readonly adminApiServiceId: string;
  /** 只保存本机私有 env 文件路径，不读取或返回连接串、token、备份路径。 */
  readonly postgresEnvFile?: string;
}

export interface AdminPluginCatalogResponse {
  readonly settings: AdminPluginWorkspaceSettings;
  readonly plugins: readonly AdminPluginStatus[];
}

export interface AddAdminPluginRequest {
  readonly directory: string;
}

export interface AdminPluginHostStartResponse {
  readonly api: ServiceRuntimeStatus;
  readonly web: ServiceRuntimeStatus;
}

export interface AdminPluginRouteCheck {
  readonly path: string;
  readonly url: string;
  readonly reachable: boolean;
  readonly statusCode?: number;
  readonly message?: string;
}

export interface AdminPluginVerifyItem {
  readonly plugin: AdminPluginStatus;
  readonly manifestVersion: string;
  readonly lifecycle?: string;
  readonly routes: readonly AdminPluginRouteCheck[];
}

export type AdminPluginGateTool = "lint" | "typecheck" | "test" | "build";

export interface AdminPluginGateRecord {
  readonly tool: AdminPluginGateTool;
  readonly command: string | null;
  readonly scanRoot: string | null;
  readonly followsSymlinks: "not-recorded" | "yes" | "no";
  readonly exclusionConfig: readonly string[];
  readonly status: "not-recorded" | "passed" | "failed";
}

export interface AdminPluginGateOwnerBoundary {
  readonly owner: "host" | "plugin";
  readonly targetId: string;
  readonly label: string;
  /** 仅作为配置入口提示；不冒充实际工具扫描根。 */
  readonly candidateRoot: string;
  readonly gates: readonly AdminPluginGateRecord[];
}

export interface AdminPluginVerificationBoundary {
  readonly scope: "development-assembly";
  readonly label: string;
  readonly completeProductVerification: false;
  readonly migrationSkillCommit: string;
  readonly gitExcludePolicy: string;
  readonly hostOwned: readonly AdminPluginGateOwnerBoundary[];
  readonly pluginOwned: readonly AdminPluginGateOwnerBoundary[];
  readonly blockingReasons: readonly string[];
}

export interface AdminPluginVerifyResponse {
  readonly generatedAt: string;
  readonly host: {
    readonly api: ServiceRuntimeStatus;
    readonly web: ServiceRuntimeStatus;
  };
  readonly plugins: readonly AdminPluginVerifyItem[];
  readonly ddlPolicy: string;
  readonly verificationBoundary: AdminPluginVerificationBoundary;
}

export interface AdminPluginDryRunResponse {
  readonly moduleId: string;
  readonly endpoint: string;
  readonly plan: unknown;
  readonly policy: string;
}

export interface ApiErrorResponse {
  readonly error: string;
  readonly code: string;
  readonly details?: unknown;
}
