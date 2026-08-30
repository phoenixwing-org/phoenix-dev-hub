import type {
  AddLocalProjectRequest,
  AddLocalProjectResponse,
  AdminPluginCandidate,
  AdminPluginCatalogResponse,
  AdminPluginDryRunResponse,
  AdminPluginHostStartResponse,
  AdminPluginStatus,
  AdminPluginVerifyResponse,
  AdminPluginWorkspaceSettings,
  ApiErrorResponse,
  BuiltinServiceConfigCatalogResponse,
  BuiltinServiceSeriesConfigEntry,
  DeleteLocalProjectResponse,
  HubConfigurationDocument,
  HostCapabilitiesResponse,
  HubRuntimeInfo,
  ImportLocalProjectsResponse,
  ImportHubConfigurationResponse,
  LocalNodeProjectCandidate,
  LocalProjectCatalogResponse,
  LocalProjectTransferDocument,
  OpenSystemTerminalResponse,
  ServiceListResponse,
  ServiceLogsResponse,
  ServiceProfileDatabaseCreationEvidence,
  ServiceRuntimeStatus,
  ServiceDefinition,
  ServiceSeriesSource,
  ShutdownHubResponse,
  StopServiceRequest,
  UpdateLocalProjectRequest,
  UpdateLocalProjectResponse,
} from "@shared/contracts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json() as T | ApiErrorResponse;
  if (!response.ok) {
    const error = body as ApiErrorResponse;
    throw new ApiError(error.error || `请求失败：${response.status}`, error.code, error.details);
  }
  return body as T;
}

export const hubApi = {
  listServices: () => request<ServiceListResponse>("/api/services"),
  hostCapabilities: () => request<HostCapabilitiesResponse>("/api/host-capabilities"),
  hubInfo: () => request<HubRuntimeInfo>("/api/hub"),
  openHubTerminal: () => request<OpenSystemTerminalResponse>(
    "/api/hub/terminal",
    { method: "POST", body: "{}" },
  ),
  shutdownHub: () => request<ShutdownHubResponse>(
    "/api/hub/shutdown",
    { method: "POST", body: JSON.stringify({ confirm: "shutdown-phoenix-hub" }) },
  ),
  projectCatalog: () => request<LocalProjectCatalogResponse>("/api/projects"),
  builtinServiceConfig: () => request<BuiltinServiceConfigCatalogResponse>("/api/service-config"),
  adminPluginCatalog: () => request<AdminPluginCatalogResponse>("/api/admin-plugins"),
  inspectAdminPlugin: (directory: string) => request<AdminPluginCandidate>(
    "/api/admin-plugins/inspect",
    { method: "POST", body: JSON.stringify({ directory }) },
  ),
  addAdminPlugin: (directory: string) => request<AdminPluginStatus>(
    "/api/admin-plugins",
    { method: "POST", body: JSON.stringify({ directory }) },
  ),
  repointAdminPlugin: (pluginId: string, directory: string) => request<AdminPluginStatus>(
    `/api/admin-plugins/${pluginId}`,
    { method: "PATCH", body: JSON.stringify({ directory }) },
  ),
  removeAdminPlugin: (pluginId: string, forceNonMountedCleanup = false) => request<{ removed: true }>(
    `/api/admin-plugins/${pluginId}`,
    {
      method: "DELETE",
      body: JSON.stringify(forceNonMountedCleanup
        ? { confirm: `cleanup-nonmounted:${pluginId}` }
        : {}),
    },
  ),
  mountAdminPlugin: (pluginId: string) => request<AdminPluginStatus>(
    `/api/admin-plugins/${pluginId}/mount`,
    { method: "POST", body: "{}" },
  ),
  unmountAdminPlugin: (pluginId: string) => request<AdminPluginStatus>(
    `/api/admin-plugins/${pluginId}/unmount`,
    { method: "POST", body: "{}" },
  ),
  updateAdminPluginSettings: (settings: AdminPluginWorkspaceSettings) => request<AdminPluginWorkspaceSettings>(
    "/api/admin-plugins/settings",
    { method: "PATCH", body: JSON.stringify(settings) },
  ),
  startAdminPluginHost: () => request<AdminPluginHostStartResponse>(
    "/api/admin-plugins/host/start",
    { method: "POST", body: "{}" },
  ),
  verifyAdminPlugins: (authorization?: string) => request<AdminPluginVerifyResponse>(
    "/api/admin-plugins/verify",
    { method: "POST", body: JSON.stringify({ authorization }) },
  ),
  adminPluginDdlDryRun: (pluginId: string, authorization: string) => request<AdminPluginDryRunResponse>(
    `/api/admin-plugins/${pluginId}/ddl-dry-run`,
    { method: "POST", body: JSON.stringify({ authorization }) },
  ),
  inspectProject: (directory: string) => request<LocalNodeProjectCandidate>(
    "/api/projects/inspect",
    { method: "POST", body: JSON.stringify({ directory }) },
  ),
  addProject: (input: AddLocalProjectRequest) => request<AddLocalProjectResponse>(
    "/api/projects",
    { method: "POST", body: JSON.stringify(input) },
  ),
  updateProject: (projectId: string, input: UpdateLocalProjectRequest) => request<UpdateLocalProjectResponse>(
    `/api/projects/${projectId}`,
    { method: "PATCH", body: JSON.stringify(input) },
  ),
  deleteProject: (projectId: string) => request<DeleteLocalProjectResponse>(
    `/api/projects/${projectId}`,
    { method: "DELETE", body: "{}" },
  ),
  exportProjects: () => request<LocalProjectTransferDocument>("/api/projects/export"),
  importProjects: (document: LocalProjectTransferDocument) => request<ImportLocalProjectsResponse>(
    "/api/projects/import",
    { method: "POST", body: JSON.stringify(document) },
  ),
  updateBuiltinService: (serviceId: string, definition: ServiceDefinition) => request<ServiceRuntimeStatus>(
    `/api/service-config/${serviceId}`,
    { method: "PATCH", body: JSON.stringify(definition) },
  ),
  updateBuiltinSeries: (seriesId: string, definition: ServiceSeriesSource) => request<BuiltinServiceSeriesConfigEntry>(
    `/api/service-series/${seriesId}`,
    { method: "PATCH", body: JSON.stringify(definition) },
  ),
  deleteBuiltinService: (serviceId: string) => request<{ removed: true; serviceId: string }>(
    `/api/service-config/${serviceId}`,
    { method: "DELETE", body: "{}" },
  ),
  restoreBuiltinService: (serviceId: string) => request<ServiceRuntimeStatus>(
    `/api/service-config/${serviceId}`,
    { method: "POST", body: "{}" },
  ),
  resetBuiltinServices: () => request<BuiltinServiceConfigCatalogResponse>(
    "/api/service-config/reset",
    { method: "POST", body: "{}" },
  ),
  exportConfiguration: () => request<HubConfigurationDocument>("/api/config/export"),
  importConfiguration: (document: HubConfigurationDocument) => request<ImportHubConfigurationResponse>(
    "/api/config/import",
    { method: "POST", body: JSON.stringify(document) },
  ),
  startService: (serviceId: string) => request<ServiceRuntimeStatus>(
    `/api/services/${serviceId}/start`,
    { method: "POST", body: "{}" },
  ),
  stopService: (serviceId: string, input: StopServiceRequest = {}) => request<ServiceRuntimeStatus>(
    `/api/services/${serviceId}/stop`,
    { method: "POST", body: JSON.stringify(input) },
  ),
  restartService: (serviceId: string) => request<ServiceRuntimeStatus>(
    `/api/services/${serviceId}/restart`,
    { method: "POST", body: "{}" },
  ),
  createProfileDatabase: (serviceId: string, confirm: string) => request<ServiceProfileDatabaseCreationEvidence>(
    `/api/services/${serviceId}/database`,
    { method: "POST", body: JSON.stringify({ confirm }) },
  ),
  serviceLogs: (serviceId: string, after: number, generation?: number) => request<ServiceLogsResponse>(
    `/api/services/${serviceId}/logs?after=${after}${generation ? `&generation=${generation}` : ""}`,
  ),
  clearServiceLogs: (serviceId: string) => request<ServiceLogsResponse>(
    `/api/services/${serviceId}/logs/clear`,
    { method: "POST", body: "{}" },
  ),
  openSystemTerminal: (serviceId: string) => request<OpenSystemTerminalResponse>(
    `/api/services/${serviceId}/terminal`,
    { method: "POST", body: "{}" },
  ),
};
