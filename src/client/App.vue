<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { storeToRefs } from "pinia";
import {
  PnwWorkbenchShell,
  type PnwNavigationNode,
} from "phoenix-wing";
import type {
  AdminPluginCatalogResponse,
  LogEntry,
  ServiceLogsResponse,
  ServiceRuntimeStatus,
  StopServiceRequest,
  StopTargetDetails,
  SystemTerminalCapability,
} from "@shared/contracts";
import { ApiError, hubApi } from "./api";
import { pnhProfileDatabaseConfirmation } from "./PnhProfileDatabaseAction";
import PnhLogPanel from "./components/PnhLogPanel.vue";
import PnhAdminPluginPrimaryPanel from "./components/PnhAdminPluginPrimaryPanel.vue";
import PnhAdminPluginView from "./components/PnhAdminPluginView.vue";
import PnhHubSettingsView from "./components/PnhHubSettingsView.vue";
import PnhPrimaryPanel from "./components/PnhPrimaryPanel.vue";
import PnhProcessStopConfirmation from "./components/PnhProcessStopConfirmation.vue";
import PnhServiceConfigView from "./components/PnhServiceConfigView.vue";
import PnhServiceTable from "./components/PnhServiceTable.vue";
import { pnhServiceDisplayName } from "./PnhServiceDisplayName";
import { pnhServiceRibbonIcon } from "./PnhServiceRoleIcons";
import { usePnhWorkbenchPreferencesStore } from "./stores/PnhWorkbenchPreferencesStore";

const preferences = usePnhWorkbenchPreferencesStore();
const {
  presentation,
  ribbonAppearance,
  treeCollapsed,
  treeAppearance,
  tabBarPlacement,
  colorScheme,
  layoutState,
  displaySettingsPositions,
  serviceSearchQuery,
  serviceSortMode,
  collapsedServiceSeriesIds,
  collapsedServiceProfileIds,
} = storeToRefs(preferences);
const expandedNodeIds = ref<readonly string[]>([
  "group-websites",
  "website-modules",
  "group-system",
  "system-services",
  "system-admin-tools",
]);
const activeNodeId = ref("services-all");
const activeWebsiteModule = ref("all");
const activeBottomTabId = ref("");

const services = ref<readonly ServiceRuntimeStatus[]>([]);
const serviceConfigurationErrors = ref<readonly string[]>([]);
const adminPluginCatalog = ref<AdminPluginCatalogResponse>();
const selectedAdminPluginId = ref("");
const selectedId = ref("");
const busyIds = ref<ReadonlySet<string>>(new Set());
const logTabIds = ref<readonly string[]>([]);
const logEntriesByService = ref<Record<string, readonly LogEntry[]>>({});
const logAfterByService = ref<Record<string, number>>({});
const logGenerationByService = ref<Record<string, number>>({});
const logInfoByService = ref<Record<string, Omit<ServiceLogsResponse, "serviceId" | "entries">>>({});
const errorMessage = ref("");
const systemTerminal = ref<SystemTerminalCapability>({
  available: false,
  label: "系统终端",
  reason: "正在检测本机终端能力",
});
const settingsInitialProjectId = ref("");
const settingsInitialServiceId = ref("");
const lastRefreshAt = ref<Date>();
const pendingStopConfirmation = shallowRef<{
  readonly details: StopTargetDetails;
  readonly force: boolean;
  readonly resolve: (confirmed: boolean) => void;
}>();
let refreshPending = false;
let restoredManagedLogTabs = false;
const logRefreshPending = new Set<string>();
const logRequestEpoch = new Map<string, number>();
let serviceTimer: number | undefined;
let logTimer: number | undefined;

const selectedService = computed(() => services.value.find(
  (service) => service.definition.id === selectedId.value,
));
const activeLogService = computed(() => services.value.find(
  (service) => service.definition.id === activeBottomTabId.value,
));
const activeLogEntries = computed(() => logEntriesByService.value[activeBottomTabId.value] ?? []);
const activeLogInfo = computed(() => logInfoByService.value[activeBottomTabId.value]);
const logTabs = computed(() => logTabIds.value.map((serviceId) => ({
  id: serviceId,
  label: services.value.find((service) => service.definition.id === serviceId)?.definition.name ?? serviceId,
  count: logEntriesByService.value[serviceId]?.length ?? 0,
})));
const filteredServices = computed(() => activeWebsiteModule.value === "all"
  ? services.value
  : services.value.filter((service) => service.definition.moduleId === activeWebsiteModule.value));
const runningCount = computed(() => services.value.filter(
  (service) => ["running", "starting", "stopping", "external", "conflict"].includes(service.lifecycle),
).length);
const adminPluginViewActive = computed(() => activeNodeId.value === "admin-plugin-development");
const servicePrimaryTitle = computed(() => activeNodeId.value === "services-settings"
  ? "服务设置"
  : activeNodeId.value === "hub-settings"
    ? "Hub 设置"
    : "服务进程");
const activeWorkbenchTabId = computed(() => adminPluginViewActive.value ? "admin-plugins" : "services");
const workbenchTabs = computed(() => [{
  id: "services",
  pageId: "services",
  title: "服务控制台",
  dirty: false,
}, {
  id: "admin-plugins",
  pageId: "admin-plugins",
  title: "Admin 插件",
  subtitle: "Phoenix Admin 插件开发组合",
  dirty: false,
}]);

const websiteModules = computed(() => {
  const modules = new Map<string, { readonly id: string; readonly name: string }>();
  for (const service of services.value) {
    modules.set(service.definition.moduleId, {
      id: service.definition.moduleId,
      name: service.definition.moduleName,
    });
  }
  return [...modules.values()];
});
const websiteNodeMap = computed<Map<string, string>>(() => new Map<string, string>(
  websiteModules.value.map((module) => [`website-${module.id}`, module.id] as const),
));
const navigationNodes = computed<readonly PnwNavigationNode[]>(() => {
  const modules = websiteModules.value.map((module, index) => ({
    id: `website-${module.id}`,
    label: module.name,
    shortLabel: module.name.replace(/^Phoenix\s*/i, "").slice(0, 6),
    icon: index % 2 === 0 ? "◇" : "⌘",
    order: (index + 1) * 10,
    children: [{
      id: `website-${module.id}-processes`,
      label: "进程",
      children: services.value
        .filter((service) => service.definition.moduleId === module.id)
        .map((service, serviceIndex) => ({
          id: service.definition.id,
          label: pnhServiceDisplayName(service.definition),
          shortLabel: pnhServiceDisplayName(service.definition),
          icon: pnhServiceRibbonIcon(service),
          order: serviceIndex * 10,
        })),
    }],
  }));
  return [{
    id: "group-websites",
    label: "网站",
    shortLabel: "网站",
    icon: "◎",
    order: 0,
    children: [{
      id: "website-modules",
      label: "网站模块",
      children: modules,
    }],
  }, {
    id: "group-system",
    label: "系统",
    shortLabel: "系统",
    icon: "⚙",
    order: 10,
    children: [{
      id: "system-services",
      label: "Hub",
      children: [
        { id: "services-all", label: "服务总览", icon: "▦" },
        { id: "services-settings", label: "服务设置", icon: "⚙" },
        { id: "hub-settings", label: "Hub 设置", icon: "◇" },
      ],
    }, {
      id: "system-admin-tools",
      label: "Admin 工具",
      children: [
        { id: "admin-plugin-development", label: "Admin 插件", shortLabel: "插件", icon: "◇" },
      ],
    }],
  }];
});

function selectService(serviceId: string): void {
  const service = services.value.find((item) => item.definition.id === serviceId);
  if (!service) return;
  selectedId.value = serviceId;
}

function activateNode(nodeId: string): void {
  if (nodeId === "admin-plugin-development") {
    activeNodeId.value = nodeId;
    activeWebsiteModule.value = "phoenix-admin";
    void refreshAdminPlugins();
    return;
  }
  if (nodeId === "services-all") {
    activeNodeId.value = nodeId;
    activeWebsiteModule.value = "all";
    return;
  }
  if (nodeId === "services-settings") {
    activeNodeId.value = nodeId;
    activeWebsiteModule.value = "all";
    settingsInitialProjectId.value = "";
    settingsInitialServiceId.value = "";
    return;
  }
  if (nodeId === "hub-settings") {
    activeNodeId.value = nodeId;
    activeWebsiteModule.value = "all";
    return;
  }
  const moduleId = websiteNodeMap.value.get(nodeId);
  if (moduleId) {
    setFilter(moduleId);
    return;
  }
  const service = services.value.find((item) => item.definition.id === nodeId);
  if (!service) return;
  activeNodeId.value = nodeId;
  activeWebsiteModule.value = service.definition.moduleId;
  selectedId.value = nodeId;
}

function selectWorkbenchTab(tabId: string): void {
  if (tabId === "admin-plugins") activateNode("admin-plugin-development");
  else activateNode("services-all");
}

function selectModule(groupId: string): void {
  if (groupId === "group-system") {
    activateNode("services-all");
    return;
  }
  if (groupId !== "group-websites") return;
  const firstModule = websiteModules.value[0];
  if (firstModule) setFilter(firstModule.id);
}

function setFilter(moduleId: string): void {
  activeWebsiteModule.value = moduleId;
  if (moduleId === "all") {
    activeNodeId.value = "services-all";
    return;
  }
  activeNodeId.value = `website-${moduleId}`;
  const first = services.value.find((service) => service.definition.moduleId === moduleId);
  if (first) selectedId.value = first.definition.id;
}

function showError(error: unknown): void {
  errorMessage.value = error instanceof ApiError || error instanceof Error
    ? error.message
    : String(error);
}

function openServiceSettings(target?: { readonly projectId?: string; readonly serviceId?: string }): void {
  settingsInitialProjectId.value = target?.projectId ?? "";
  settingsInitialServiceId.value = target?.serviceId ?? "";
  activeWebsiteModule.value = "all";
  activeNodeId.value = "services-settings";
}

async function serviceConfigChanged(serviceId?: string): Promise<void> {
  await refreshServices();
  if (!serviceId) return;
  const service = services.value.find((item) => item.definition.id === serviceId);
  if (!service) return;
  selectedId.value = serviceId;
  if (activeNodeId.value !== "services-settings") {
    activeWebsiteModule.value = service.definition.moduleId;
    activeNodeId.value = `website-${service.definition.moduleId}`;
  }
}

async function refreshServices(): Promise<void> {
  if (refreshPending) return;
  refreshPending = true;
  try {
    const response = await hubApi.listServices();
    services.value = response.services;
    serviceConfigurationErrors.value = response.configurationErrors ?? [];
    lastRefreshAt.value = new Date(response.generatedAt);
    if (!selectedId.value && response.services[0]) selectedId.value = response.services[0].definition.id;
    if (selectedId.value && !response.services.some((item) => item.definition.id === selectedId.value)) {
      selectedId.value = response.services[0]?.definition.id ?? "";
    }
    if (!restoredManagedLogTabs) {
      const restoredTabs = response.services
        .filter((service) => service.managed)
        .map((service) => service.definition.id)
        .filter((serviceId) => !logTabIds.value.includes(serviceId));
      if (restoredTabs.length) logTabIds.value = [...logTabIds.value, ...restoredTabs];
      restoredManagedLogTabs = true;
    }
    if (!activeBottomTabId.value && logTabIds.value[0]) activeBottomTabId.value = logTabIds.value[0];
  } catch (error) {
    showError(error);
  } finally {
    refreshPending = false;
  }
}

async function refreshAdminPlugins(preferredId?: string): Promise<void> {
  try {
    const catalog = await hubApi.adminPluginCatalog();
    adminPluginCatalog.value = catalog;
    if (preferredId && catalog.plugins.some((plugin) => plugin.registration.id === preferredId)) {
      selectedAdminPluginId.value = preferredId;
    } else if (!catalog.plugins.some((plugin) => plugin.registration.id === selectedAdminPluginId.value)) {
      selectedAdminPluginId.value = catalog.plugins[0]?.registration.id ?? "";
    }
  } catch (error) {
    showError(error);
  }
}

async function adminPluginChanged(pluginId?: string): Promise<void> {
  await refreshAdminPlugins(pluginId);
}

async function refreshHostCapabilities(): Promise<void> {
  try {
    systemTerminal.value = (await hubApi.hostCapabilities()).systemTerminal;
  } catch (error) {
    showError(error);
  }
}

function ensureLogTab(serviceId: string): void {
  if (!logTabIds.value.includes(serviceId)) logTabIds.value = [...logTabIds.value, serviceId];
  activeBottomTabId.value = serviceId;
  if (!layoutState.value.visibility.bottom) {
    layoutState.value = {
      ...layoutState.value,
      visibility: { ...layoutState.value.visibility, bottom: true },
    };
  }
}

function closeLogTab(serviceId = activeBottomTabId.value): void {
  const closedIndex = logTabIds.value.indexOf(serviceId);
  if (closedIndex < 0) return;
  const nextTabs = logTabIds.value.filter((id) => id !== serviceId);
  logTabIds.value = nextTabs;

  const nextEntries = { ...logEntriesByService.value };
  const nextAfter = { ...logAfterByService.value };
  const nextGeneration = { ...logGenerationByService.value };
  const nextInfo = { ...logInfoByService.value };
  delete nextEntries[serviceId];
  delete nextAfter[serviceId];
  delete nextGeneration[serviceId];
  delete nextInfo[serviceId];
  logEntriesByService.value = nextEntries;
  logAfterByService.value = nextAfter;
  logGenerationByService.value = nextGeneration;
  logInfoByService.value = nextInfo;
  logRequestEpoch.set(serviceId, (logRequestEpoch.get(serviceId) ?? 0) + 1);

  if (activeBottomTabId.value === serviceId) {
    activeBottomTabId.value = nextTabs[Math.min(closedIndex, nextTabs.length - 1)] ?? "";
  }
  if (nextTabs.length === 0 && layoutState.value.visibility.bottom) {
    layoutState.value = {
      ...layoutState.value,
      visibility: { ...layoutState.value.visibility, bottom: false },
    };
  }
}

function closeAllLogTabs(): void {
  const closedIds = logTabIds.value;
  logTabIds.value = [];
  logEntriesByService.value = {};
  logAfterByService.value = {};
  logGenerationByService.value = {};
  logInfoByService.value = {};
  for (const serviceId of closedIds) {
    logRequestEpoch.set(serviceId, (logRequestEpoch.get(serviceId) ?? 0) + 1);
  }
  activeBottomTabId.value = "";
  if (layoutState.value.visibility.bottom) {
    layoutState.value = {
      ...layoutState.value,
      visibility: { ...layoutState.value.visibility, bottom: false },
    };
  }
}

async function refreshLogs(serviceId: string): Promise<void> {
  if (!serviceId || logRefreshPending.has(serviceId)) return;
  logRefreshPending.add(serviceId);
  const requestEpoch = logRequestEpoch.get(serviceId) ?? 0;
  try {
    const knownGeneration = logGenerationByService.value[serviceId];
    const response = await hubApi.serviceLogs(
      serviceId,
      logAfterByService.value[serviceId] ?? 0,
      knownGeneration,
    );
    if ((logRequestEpoch.get(serviceId) ?? 0) !== requestEpoch) return;
    const generationChanged = knownGeneration !== undefined && knownGeneration !== response.generation;
    const previous = generationChanged ? [] : (logEntriesByService.value[serviceId] ?? []);
    const merged = response.available
      ? [...new Map([...previous, ...response.entries].map((entry) => [entry.sequence, entry])).values()]
          .sort((left, right) => left.sequence - right.sequence)
          .slice(-response.capacity)
      : [];
    const { serviceId: _serviceId, entries: _entries, ...info } = response;
    logEntriesByService.value = { ...logEntriesByService.value, [serviceId]: merged };
    logAfterByService.value = {
      ...logAfterByService.value,
      [serviceId]: Math.max(0, response.nextSequence - 1),
    };
    logGenerationByService.value = {
      ...logGenerationByService.value,
      [serviceId]: response.generation,
    };
    logInfoByService.value = { ...logInfoByService.value, [serviceId]: info };
  } catch (error) {
    showError(error);
  } finally {
    logRefreshPending.delete(serviceId);
  }
}

async function clearActiveLog(): Promise<void> {
  const serviceId = activeBottomTabId.value;
  if (!serviceId) return;
  logRequestEpoch.set(serviceId, (logRequestEpoch.get(serviceId) ?? 0) + 1);
  try {
    const response = await hubApi.clearServiceLogs(serviceId);
    const { serviceId: _serviceId, entries: _entries, ...info } = response;
    logEntriesByService.value = { ...logEntriesByService.value, [serviceId]: [] };
    logAfterByService.value = {
      ...logAfterByService.value,
      [serviceId]: Math.max(0, response.nextSequence - 1),
    };
    logGenerationByService.value = {
      ...logGenerationByService.value,
      [serviceId]: response.generation,
    };
    logInfoByService.value = { ...logInfoByService.value, [serviceId]: info };
  } catch (error) {
    showError(error);
  }
}

function stopDetails(value: unknown): StopTargetDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Partial<StopTargetDetails>;
  return typeof details.token === "string" && Array.isArray(details.processes)
    ? details as StopTargetDetails
    : undefined;
}

function requestStopConfirmation(details: StopTargetDetails, force: boolean): Promise<boolean> {
  pendingStopConfirmation.value?.resolve(false);
  return new Promise((resolve) => {
    pendingStopConfirmation.value = { details, force, resolve };
  });
}

function resolveStopConfirmation(confirmed: boolean): void {
  const pending = pendingStopConfirmation.value;
  pendingStopConfirmation.value = undefined;
  pending?.resolve(confirmed);
}

async function stopWithConfirmation(
  serviceId: string,
  input: StopServiceRequest = {},
): Promise<ServiceRuntimeStatus | undefined> {
  try {
    return await hubApi.stopService(serviceId, input);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const details = stopDetails(error.details);
    if (error.code === "EXTERNAL_CONFIRMATION_REQUIRED" && details) {
      if (!await requestStopConfirmation(details, false)) return undefined;
      return stopWithConfirmation(serviceId, { mode: "confirm-external", token: details.token });
    }
    if (error.code === "FORCE_STOP_REQUIRED" && details) {
      if (!await requestStopConfirmation(details, true)) return undefined;
      return hubApi.stopService(serviceId, { mode: "force", token: details.token });
    }
    throw error;
  }
}

async function runAction(serviceId: string, action: "start" | "stop" | "restart"): Promise<void> {
  const service = services.value.find((item) => item.definition.id === serviceId);
  if (!service || busyIds.value.has(serviceId)) return;
  busyIds.value = new Set([...busyIds.value, serviceId]);
  try {
    if (action === "start") {
      ensureLogTab(serviceId);
      await hubApi.startService(serviceId);
    } else if (action === "restart") {
      ensureLogTab(serviceId);
      await hubApi.restartService(serviceId);
    } else {
      const stopped = await stopWithConfirmation(serviceId);
      if (!stopped) return;
      closeLogTab(serviceId);
    }
    await Promise.all([
      refreshServices(),
      action !== "stop" ? refreshLogs(serviceId) : Promise.resolve(),
    ]);
  } catch (error) {
    showError(error);
  } finally {
    const next = new Set(busyIds.value);
    next.delete(serviceId);
    busyIds.value = next;
  }
}

async function createProfileDatabase(serviceId: string): Promise<void> {
  const service = services.value.find((item) => item.definition.id === serviceId);
  if (!service || busyIds.value.has(serviceId)) return;
  const confirmation = pnhProfileDatabaseConfirmation(service);
  if (!confirmation || !window.confirm(confirmation.message)) return;
  const profileServices = services.value.filter((item) => (
    (item.definition.seriesId ?? item.definition.moduleId) === (service.definition.seriesId ?? service.definition.moduleId)
    && (item.definition.profileId ?? "default") === (service.definition.profileId ?? "default")
  ));
  busyIds.value = new Set([...busyIds.value, ...profileServices.map((item) => item.definition.id)]);
  try {
    await hubApi.createProfileDatabase(
      serviceId,
      confirmation.confirmation,
    );
  } catch (error) {
    showError(error);
  } finally {
    const nextBusy = new Set(busyIds.value);
    for (const item of profileServices) nextBusy.delete(item.definition.id);
    busyIds.value = nextBusy;
    await refreshServices();
  }
}

function runtimeProfileId(service: ServiceRuntimeStatus): string {
  return service.definition.profileId ?? "default";
}

async function runProfileAction(input: {
  readonly seriesId: string;
  readonly profileId: string;
  readonly action: "start" | "stop" | "switch" | "restart";
}): Promise<void> {
  const targets = services.value
    .filter((service) => (
      (service.definition.seriesId ?? service.definition.moduleId) === input.seriesId
      && runtimeProfileId(service) === input.profileId
    ))
    .sort((left, right) => (left.definition.startOrder ?? 0) - (right.definition.startOrder ?? 0));
  if (targets.length === 0) return;
  const slots = new Set(targets.map((service) => service.definition.runtimeSlot).filter(Boolean));
  const blockers = services.value.filter((service) => (
    service.lifecycle !== "stopped"
    && runtimeProfileId(service) !== input.profileId
    && service.definition.runtimeSlot
    && slots.has(service.definition.runtimeSlot)
  ));
  if (input.action === "switch") {
    const blockerNames = [...new Set(blockers.map((service) => service.definition.profileName
      ?? service.definition.name))];
    if (!window.confirm([
      `切换到 ${targets[0]?.definition.profileName ?? "目标版本"}？`,
      `将先停止：${blockerNames.join("、") || "当前版本"}`,
      `随后按顺序启动：${targets.map((service) => service.definition.name).join(" → ")}`,
      "外部监控进程仍会逐项要求二次确认。",
    ].join("\n\n"))) return;
  }

  const affected = input.action === "stop" || input.action === "restart"
    ? targets
    : [...blockers, ...targets];
  busyIds.value = new Set([...busyIds.value, ...affected.map((service) => service.definition.id)]);
  try {
    if (["stop", "switch", "restart"].includes(input.action)) {
      const stopping = input.action === "switch" ? [...blockers].reverse() : [...targets].reverse();
      for (const service of stopping) {
        if (service.lifecycle === "stopped") continue;
        const stopped = await stopWithConfirmation(service.definition.id);
        if (!stopped) return;
        if (input.action !== "restart") closeLogTab(service.definition.id);
      }
    }
    if (["start", "switch", "restart"].includes(input.action)) {
      for (const service of targets) {
        // restart 的 target 是停止前快照；不能用旧 lifecycle 跳过刚刚停止的服务。
        if (input.action !== "restart" && service.lifecycle !== "stopped") continue;
        ensureLogTab(service.definition.id);
        await hubApi.startService(service.definition.id);
      }
    }
  } catch (error) {
    showError(error);
  } finally {
    const nextBusy = new Set(busyIds.value);
    for (const service of affected) nextBusy.delete(service.definition.id);
    busyIds.value = nextBusy;
    await refreshServices();
  }
}

function openRuntimeLog(serviceId: string): void {
  selectService(serviceId);
  ensureLogTab(serviceId);
  void refreshLogs(serviceId);
}

async function openSystemTerminal(serviceId: string): Promise<void> {
  try {
    await hubApi.openSystemTerminal(serviceId);
  } catch (error) {
    showError(error);
  }
}

function openService(serviceId: string): void {
  const service = services.value.find((item) => item.definition.id === serviceId);
  const url = service?.endpoints.find((endpoint) => endpoint.openUrl && endpoint.reachable)?.openUrl;
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

onMounted(() => {
  void refreshServices();
  void refreshAdminPlugins();
  void refreshHostCapabilities();
  serviceTimer = window.setInterval(() => void refreshServices(), 2_500);
  logTimer = window.setInterval(
    () => void Promise.all(logTabIds.value.map((serviceId) => refreshLogs(serviceId))),
    1_200,
  );
});

onBeforeUnmount(() => {
  resolveStopConfirmation(false);
  if (serviceTimer) window.clearInterval(serviceTimer);
  if (logTimer) window.clearInterval(logTimer);
});
</script>

<template>
  <div class="hub-app">
    <PnwWorkbenchShell
      v-model:presentation="presentation"
      v-model:expanded-node-ids="expandedNodeIds"
      v-model:ribbon-appearance="ribbonAppearance"
      v-model:tree-collapsed="treeCollapsed"
      v-model:tree-appearance="treeAppearance"
      v-model:color-scheme="colorScheme"
      v-model:layout-state="layoutState"
      v-model:active-bottom-tab-id="activeBottomTabId"
      v-model:tab-bar-placement="tabBarPlacement"
      v-model:display-settings-positions="displaySettingsPositions"
      class="hub-workbench"
      :nodes="navigationNodes"
      :active-node-id="activeNodeId"
      :contributions="{ primary: true, bottom: true }"
      :bottom-tabs="logTabs"
      :tabs="workbenchTabs"
      :active-tab-id="activeWorkbenchTabId"
      brand-title="Phoenix Hub"
      brand-subtitle="127.0.0.1:42100"
      tree-header-label="网站与系统"
      header-aria-label="Phoenix Hub 页眉"
      activity-aria-label="开发服务导航"
      @activate="activateNode"
      @select-module="selectModule"
      @select-tab="selectWorkbenchTab"
      @close-tab="selectWorkbenchTab($event === 'admin-plugins' ? 'services' : 'admin-plugins')"
    >
      <template #header-actions>
        <div class="header-actions">
          <span class="running-summary"><i />{{ runningCount }} / {{ services.length }} 活动</span>
          <button type="button" title="立即刷新" @click="adminPluginViewActive ? refreshAdminPlugins() : refreshServices()">↻</button>
        </div>
      </template>

      <div v-if="errorMessage" class="error-banner" role="alert">
        <span>{{ errorMessage }}</span>
        <button type="button" aria-label="关闭错误消息" @click="errorMessage = ''">×</button>
      </div>

      <PnhAdminPluginView
        v-if="adminPluginViewActive"
        :catalog="adminPluginCatalog"
        :selected-id="selectedAdminPluginId"
        @select="selectedAdminPluginId = $event"
        @changed="adminPluginChanged"
        @host-started="refreshServices"
        @configure-host="activeNodeId = 'hub-settings'"
        @error="showError"
      />

      <PnhServiceConfigView
        v-else-if="activeNodeId === 'services-settings'"
        open
        embedded
        :initial-project-id="settingsInitialProjectId"
        :initial-service-id="settingsInitialServiceId"
        :services="services"
        @changed="serviceConfigChanged"
        @error="showError"
      />

      <PnhHubSettingsView
        v-else-if="activeNodeId === 'hub-settings'"
        @admin-plugin-settings-changed="adminPluginChanged"
        @open-service-settings="openServiceSettings"
        @error="showError"
      />

      <PnhServiceTable
        v-else
        :services="filteredServices"
        :configuration-errors="serviceConfigurationErrors"
        :selected-id="selectedId"
        :busy-ids="busyIds"
        :system-terminal="systemTerminal"
        v-model:search-query="serviceSearchQuery"
        v-model:sort-mode="serviceSortMode"
        v-model:collapsed-series-ids="collapsedServiceSeriesIds"
        v-model:collapsed-profile-ids="collapsedServiceProfileIds"
        @select="selectService"
        @start="runAction($event, 'start')"
        @stop="runAction($event, 'stop')"
        @restart="runAction($event, 'restart')"
        @open="openService"
        @logs="openRuntimeLog"
        @terminal="openSystemTerminal"
        @create-database="createProfileDatabase"
        @configure="openServiceSettings"
        @profile-action="runProfileAction"
      />

      <template #primary>
        <PnhAdminPluginPrimaryPanel
          v-if="adminPluginViewActive"
          :plugins="adminPluginCatalog?.plugins ?? []"
          :selected-id="selectedAdminPluginId"
          @select="selectedAdminPluginId = $event"
          @changed="adminPluginChanged"
          @error="showError"
        />
        <PnhPrimaryPanel
          v-else
          :title="servicePrimaryTitle"
          :services="services"
          :active-module="activeWebsiteModule"
          :selected-service="selectedService"
          @filter="setFilter"
        />
      </template>
      <template #bottom>
        <PnhLogPanel
          :entries="activeLogEntries"
          :service-name="activeLogService?.definition.name"
          :log-tab-count="logTabs.length"
          :available="activeLogInfo?.available"
          :retained-count="activeLogInfo?.retainedCount"
          :capacity="activeLogInfo?.capacity"
          :total-written="activeLogInfo?.totalWritten"
          :message="activeLogInfo?.message"
          @clear="clearActiveLog"
          @close="closeLogTab()"
          @close-all="closeAllLogTabs"
        />
      </template>
      <template #footer>
        <span>Wing 0.7.1</span>
        <span v-if="lastRefreshAt">最近刷新 {{ lastRefreshAt.toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
      </template>
    </PnwWorkbenchShell>
    <PnhProcessStopConfirmation
      v-if="pendingStopConfirmation"
      :details="pendingStopConfirmation.details"
      :force="pendingStopConfirmation.force"
      :color-scheme="colorScheme"
      @cancel="resolveStopConfirmation(false)"
      @confirm="resolveStopConfirmation(true)"
    />
  </div>
</template>

<style scoped>
.hub-app, .hub-workbench { width: 100%; height: 100%; }
.header-actions { display: flex; align-items: center; gap: 8px; padding-right: 7px; }
.running-summary { display: inline-flex; align-items: center; gap: 6px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 11px; white-space: nowrap; }
.running-summary i { width: 7px; height: 7px; border-radius: 999px; background: #22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, .12); }
.header-actions button { width: 28px; height: 26px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.header-actions button:hover { background: var(--pnw-control-hover-bg, var(--pnw-workbench-default-hover-bg, rgba(59, 130, 246, .08))); }
.error-banner { position: absolute; z-index: 20; top: 8px; left: 50%; transform: translateX(-50%); max-width: min(620px, 85%); display: flex; gap: 12px; align-items: center; padding: 9px 12px; border: 1px solid rgba(239, 68, 68, .48); border-radius: 8px; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); color: #ef4444; box-shadow: 0 10px 28px rgba(15, 23, 42, .18); font-size: 12px; }
.error-banner button { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 18px; }
:deep(.pnw-workbench-editor) { position: relative; }
</style>
