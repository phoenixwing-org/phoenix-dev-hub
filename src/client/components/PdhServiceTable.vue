<script setup lang="ts">
import { computed } from "vue";
import PnwPageHeader from "phoenix-wing/layout/PnwPageHeader.vue";
import PnwPageLayout from "phoenix-wing/layout/PnwPageLayout.vue";
import type {
  ServiceEndpointDefinition,
  ServiceEnvironmentKind,
  ServiceRuntimeStatus,
  SystemTerminalCapability,
} from "@shared/contracts";
import {
  pdhPresentedEndpoint,
  pdhPresentedHealth,
} from "../PdhServiceHealthPresentation";
import {
  pdhServiceDisplayName,
  pdhServiceProfileDisplayName,
} from "../PdhServiceDisplayName";
import type { PdhServiceSortMode } from "../stores/PdhWorkbenchPreferencesStore";

defineOptions({ name: "PdhServiceTable" });
const props = defineProps<{
  services: readonly ServiceRuntimeStatus[];
  configurationErrors: readonly string[];
  selectedId: string;
  busyIds: ReadonlySet<string>;
  systemTerminal: SystemTerminalCapability;
  searchQuery: string;
  sortMode: PdhServiceSortMode;
  collapsedSeriesIds: readonly string[];
  collapsedProfileIds: readonly string[];
}>();

const emit = defineEmits<{
  select: [serviceId: string];
  start: [serviceId: string];
  stop: [serviceId: string];
  restart: [serviceId: string];
  open: [serviceId: string];
  logs: [serviceId: string];
  terminal: [serviceId: string];
  "create-database": [serviceId: string];
  configure: [target?: { readonly projectId?: string; readonly serviceId?: string }];
  "update:searchQuery": [value: string];
  "update:sortMode": [value: PdhServiceSortMode];
  "update:collapsedSeriesIds": [value: readonly string[]];
  "update:collapsedProfileIds": [value: readonly string[]];
  "profile-action": [value: {
    readonly seriesId: string;
    readonly profileId: string;
    readonly action: "start" | "stop" | "switch" | "restart";
  }];
}>();

const lifecycleLabels: Readonly<Record<ServiceRuntimeStatus["lifecycle"], string>> = {
  stopped: "已停止",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  external: "外部监控",
  conflict: "端口冲突",
};
const ownershipLabels: Readonly<Record<ServiceRuntimeStatus["ownership"], string>> = {
  hub: "Hub 管理",
  external: "外部启动",
  conflict: "身份不符",
  none: "未接管",
};
const endpointPositions = ["api", "other", "web"] as const;
const searchQueryModel = computed({
  get: () => props.searchQuery,
  set: (value: string) => emit("update:searchQuery", value),
});
const sortModeModel = computed({
  get: () => props.sortMode,
  set: (value: PdhServiceSortMode) => emit("update:sortMode", value),
});

const lifecyclePriority: Readonly<Record<ServiceRuntimeStatus["lifecycle"], number>> = {
  conflict: 0,
  stopping: 1,
  starting: 2,
  running: 3,
  external: 4,
  stopped: 5,
};

function statusPriority(service: ServiceRuntimeStatus): number {
  if (service.lifecycle === "conflict") return 0;
  if (service.health === "unhealthy") return 1;
  if (service.health === "partial") return 2;
  if (service.health === "reachable") return 3;
  return lifecyclePriority[service.lifecycle] + 4;
}

function seriesId(service: ServiceRuntimeStatus): string {
  return service.definition.seriesId ?? service.definition.moduleId;
}

function seriesName(service: ServiceRuntimeStatus): string {
  return service.definition.seriesName ?? service.definition.moduleName;
}

function profileId(service: ServiceRuntimeStatus): string {
  return service.definition.profileId ?? "default";
}

function profileName(service: ServiceRuntimeStatus): string {
  return service.definition.profileName ?? "默认实例";
}

function serviceMatchesQuery(service: ServiceRuntimeStatus, query: string): boolean {
  const searchable = [
    service.definition.id,
    service.definition.name,
    service.definition.description,
    service.definition.moduleId,
    service.definition.moduleName,
    seriesId(service),
    seriesName(service),
    profileId(service),
    profileName(service),
    service.definition.profileMetadata?.wingVersion,
    service.definition.profilePolicy?.environmentKind,
    service.definition.profilePolicy?.deploymentMode,
    service.definition.profilePolicy?.database.name,
    service.profileEvidence?.state,
    service.profileEvidence?.wingSource,
    service.profileEvidence?.wingVersion,
    service.profileEvidence?.database?.state,
    service.profileEvidence?.database?.message,
    ...(service.definition.configurationErrors ?? []),
    lifecycleLabels[service.lifecycle],
    pdhPresentedHealth(service).label,
    ownershipLabels[service.ownership],
    ...service.endpoints.flatMap((endpoint) => [endpoint.id, endpoint.label, String(endpoint.port)]),
  ];
  return searchable.some((value) => String(value ?? "").toLocaleLowerCase("zh-CN").includes(query));
}

function sortServices(values: readonly ServiceRuntimeStatus[]): ServiceRuntimeStatus[] {
  const configuredOrder = new Map(props.services.map((service, index) => [service.definition.id, index]));
  const sorted = [...values];
  if (sortModeModel.value === "configured") return sorted;
  return sorted.sort((left, right) => {
    if (sortModeModel.value === "name") {
      return left.definition.name.localeCompare(right.definition.name, "zh-CN");
    }
    if (sortModeModel.value === "port") {
      const leftPort = Math.min(...left.endpoints.map((endpoint) => endpoint.port), Number.MAX_SAFE_INTEGER);
      const rightPort = Math.min(...right.endpoints.map((endpoint) => endpoint.port), Number.MAX_SAFE_INTEGER);
      return leftPort - rightPort
        || left.definition.name.localeCompare(right.definition.name, "zh-CN");
    }
    return statusPriority(left) - statusPriority(right)
      || (configuredOrder.get(left.definition.id) ?? 0) - (configuredOrder.get(right.definition.id) ?? 0);
  });
}

const visibleServices = computed(() => {
  const query = searchQueryModel.value.trim().toLocaleLowerCase("zh-CN");
  const filtered = query
    ? props.services.filter((service) => serviceMatchesQuery(service, query))
    : [...props.services];
  return sortServices(filtered);
});

interface ProfileGroup {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly runtimeSlot: string;
  readonly wingVersion?: string;
  readonly environmentKind?: ServiceEnvironmentKind;
  readonly deploymentMode?: "source-mounted" | "package-assembled";
  readonly lifecycleControl: boolean;
  readonly evidence?: ServiceRuntimeStatus["profileEvidence"];
  readonly services: readonly ServiceRuntimeStatus[];
}

interface SeriesGroup {
  readonly id: string;
  readonly name: string;
  readonly profiles: readonly ProfileGroup[];
  readonly services: readonly ServiceRuntimeStatus[];
}

type TableRow =
  | { readonly kind: "series"; readonly key: string; readonly series: SeriesGroup }
  | { readonly kind: "profile"; readonly key: string; readonly series: SeriesGroup; readonly profile: ProfileGroup }
  | { readonly kind: "service"; readonly key: string; readonly service: ServiceRuntimeStatus };

const groupedServices = computed<readonly SeriesGroup[]>(() => {
  const configuredSeriesOrder = new Map<string, number>();
  const configuredProfileOrder = new Map<string, number>();
  for (const [index, service] of props.services.entries()) {
    const sid = seriesId(service);
    if (!configuredSeriesOrder.has(sid)) configuredSeriesOrder.set(sid, index);
    const key = `${sid}/${profileId(service)}`;
    if (!configuredProfileOrder.has(key)) configuredProfileOrder.set(key, index);
  }
  const groups = new Map<string, { name: string; profiles: Map<string, ServiceRuntimeStatus[]> }>();
  for (const service of visibleServices.value) {
    const id = seriesId(service);
    const group = groups.get(id) ?? { name: seriesName(service), profiles: new Map() };
    const pid = profileId(service);
    group.profiles.set(pid, [...(group.profiles.get(pid) ?? []), service]);
    groups.set(id, group);
  }
  let result = [...groups.entries()].map(([id, group]): SeriesGroup => {
    let profiles = [...group.profiles.entries()].map(([pid, services]): ProfileGroup => ({
      id: pid,
      key: `${id}/${pid}`,
      name: profileName(services[0]!),
      runtimeSlot: services[0]?.definition.runtimeSlot ?? id,
      wingVersion: services[0]?.definition.profileMetadata?.wingVersion,
      environmentKind: services[0]?.definition.profilePolicy?.environmentKind,
      deploymentMode: services[0]?.definition.profilePolicy?.deploymentMode,
      lifecycleControl: services[0]?.definition.profilePolicy?.lifecycleControl !== false,
      evidence: services[0]?.profileEvidence,
      services: sortServices(services),
    }));
    profiles = profiles.sort((left, right) => (
      (configuredProfileOrder.get(left.key) ?? Number.MAX_SAFE_INTEGER)
        - (configuredProfileOrder.get(right.key) ?? Number.MAX_SAFE_INTEGER)
    ));
    return { id, name: group.name, profiles, services: profiles.flatMap((profile) => profile.services) };
  });
  return result.sort((left, right) => (
    (configuredSeriesOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (configuredSeriesOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  ));
});

const tableRows = computed<readonly TableRow[]>(() => {
  const searching = Boolean(searchQueryModel.value.trim());
  const rows: TableRow[] = [];
  for (const series of groupedServices.value) {
    rows.push({ kind: "series", key: `series:${series.id}`, series });
    if (!searching && props.collapsedSeriesIds.includes(series.id)) continue;
    if (series.profiles.length === 1) {
      rows.push(...series.profiles[0]!.services.map((service) => ({
        kind: "service" as const,
        key: `service:${service.definition.id}`,
        service,
      })));
      continue;
    }
    for (const profile of series.profiles) {
      rows.push({ kind: "profile", key: `profile:${profile.key}`, series, profile });
      if (!searching && props.collapsedProfileIds.includes(profile.key)) continue;
      rows.push(...profile.services.map((service) => ({
        kind: "service" as const,
        key: `service:${service.definition.id}`,
        service,
      })));
    }
  }
  return rows;
});

function toggleCollapsed(kind: "series" | "profile", id: string): void {
  const current = kind === "series" ? props.collapsedSeriesIds : props.collapsedProfileIds;
  const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
  if (kind === "series") emit("update:collapsedSeriesIds", next);
  else emit("update:collapsedProfileIds", next);
}

function setAllCollapsed(collapsed: boolean): void {
  emit("update:collapsedSeriesIds", collapsed ? groupedServices.value.map((series) => series.id) : []);
  emit("update:collapsedProfileIds", collapsed
    ? groupedServices.value.flatMap((series) => series.profiles.map((profile) => profile.key))
    : []);
}

function isActive(service: ServiceRuntimeStatus): boolean {
  return service.lifecycle !== "stopped";
}

function profileAction(profile: ProfileGroup): "start" | "stop" | "switch" | "readonly" | "blocked" {
  if (!profile.lifecycleControl) return "readonly";
  if (profile.services.some(isActive)) return "stop";
  if (profile.services.some((service) => service.definition.configurationErrors?.length)) return "blocked";
  if (profile.evidence?.database && profile.evidence.database.state !== "ready") return "blocked";
  const otherActive = props.services.some((service) => (
    service.definition.runtimeSlot === profile.runtimeSlot
    && profileId(service) !== profile.id
    && isActive(service)
  ));
  return otherActive ? "switch" : "start";
}

function runProfileAction(series: SeriesGroup, profile: ProfileGroup): void {
  const action = profileAction(profile);
  if (action === "readonly" || action === "blocked") return;
  emit("profile-action", { seriesId: series.id, profileId: profile.id, action });
}

function profileActionLabel(profile: ProfileGroup): string {
  const action = profileAction(profile);
  if (action === "readonly") return "只读监控";
  if (action === "blocked") {
    if (profile.services.some((service) => service.definition.configurationErrors?.length)) return "配置错误";
    if (profile.evidence?.database?.state === "missing") return "数据库缺失";
    if (profile.evidence?.database?.state === "uninitialized") return "数据库未初始化";
    return "数据库预检失败";
  }
  if (action === "stop") return "停止此实例";
  if (action === "switch") return "切换并启动";
  return "启动此实例";
}

function profileActionTitle(profile: ProfileGroup): string | undefined {
  if (profileAction(profile) === "readonly") {
    return "生产环境默认只读；生命周期操作需要独立 capability、维护窗口、可信备份、二次确认与审计";
  }
  const configurationErrors = profile.services.flatMap((service) => service.definition.configurationErrors ?? []);
  if (configurationErrors.length) return `配置错误：${configurationErrors.join("；")}`;
  return profile.evidence?.database?.message ?? profile.evidence?.message;
}

function serviceStartBlocked(service: ServiceRuntimeStatus): boolean {
  if (service.definition.configurationErrors?.length) return true;
  const database = service.profileEvidence?.database;
  return Boolean(database && database.state !== "ready");
}

function restartProfile(series: SeriesGroup, profile: ProfileGroup): void {
  emit("profile-action", { seriesId: series.id, profileId: profile.id, action: "restart" });
}

function profileSummary(profile: ProfileGroup): string {
  const active = profile.services.filter(isActive).length;
  const ready = profile.services.filter((service) => service.health === "ready").length;
  return active ? `${active} 活动 · ${ready}/${profile.services.length} 就绪` : `${profile.services.length} 个服务`;
}

const environmentLabels = {
  development: "开发联调",
  "release-validation": "发布验收 · 非正式",
  preproduction: "预生产",
  production: "生产 · 只读",
} as const;

function canOpen(service: ServiceRuntimeStatus): boolean {
  return service.endpoints.some((endpoint) => endpoint.openUrl && endpoint.reachable);
}

function endpointPosition(endpoint: ServiceEndpointDefinition): "api" | "other" | "web" {
  const identity = `${endpoint.id} ${endpoint.label}`.toLowerCase();
  if (/(^|\W)api(\W|$)/.test(identity)) return "api";
  if (/(^|\W)web(\W|$)/.test(identity)) return "web";
  return "other";
}

function positionedEndpoints(
  service: ServiceRuntimeStatus,
  position: "api" | "other" | "web",
) {
  return service.endpoints.filter((endpoint) => endpointPosition(endpoint) === position);
}

function chooseMenuAction(
  event: Event,
  action: "logs" | "terminal",
  serviceId: string,
): void {
  (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
  if (action === "logs") emit("logs", serviceId);
  else emit("terminal", serviceId);
}

function chooseProjectAction(event: Event, projectId: string): void {
  (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
  emit("configure", { projectId });
}

function chooseServiceConfigAction(event: Event, serviceId: string): void {
  (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
  emit("configure", { serviceId });
}
</script>

<template>
  <PnwPageLayout
    class="service-editor"
    title="服务进程"
    aria-label="开发服务列表"
  >
    <template #header>
      <PnwPageHeader title="服务进程" :presentation-detachable="false">
        <template #actions>
        <label class="search-control">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4" />
            <path d="m10 10 3 3" />
          </svg>
          <input v-model="searchQueryModel" type="search" placeholder="搜索服务、端口" aria-label="搜索服务和端口">
        </label>
        <select v-model="sortModeModel" class="sort-control" aria-label="服务排序方式" title="服务排序方式">
          <option value="name">按名称</option>
          <option value="status">状态优先</option>
          <option value="port">按端口</option>
          <option value="configured">配置顺序</option>
        </select>
        <div class="tree-actions" aria-label="分组折叠操作">
          <button type="button" title="全部展开" @click="setAllCollapsed(false)">展开</button>
          <button type="button" title="全部折叠" @click="setAllCollapsed(true)">折叠</button>
        </div>
        <span class="service-count">
          <template v-if="searchQueryModel.trim()">{{ visibleServices.length }} / {{ services.length }}</template>
          <template v-else>{{ services.length }}</template>
          个进程
        </span>
        <button type="button" class="add-project" @click="emit('configure')">
          <span aria-hidden="true">⚙</span>服务配置
        </button>
        </template>
      </PnwPageHeader>
    </template>

    <p class="page-intro">启动动作来自受控清单，不接受浏览器传入命令。</p>
    <div class="service-table-wrap">
      <div v-if="configurationErrors.length" class="configuration-alert" role="alert">
        <strong>服务配置错误</strong>
        <span v-for="error in configurationErrors" :key="error">{{ error }}</span>
        <small>Hub 已保持运行；请在“服务配置”中修正后重新启动 Hub。</small>
      </div>

      <table v-if="visibleServices.length" class="service-table">
        <colgroup>
          <col class="service-column">
          <col class="status-column">
          <col class="endpoint-column">
          <col class="pid-column">
          <col class="actions-column">
        </colgroup>
        <thead>
          <tr>
            <th>服务</th>
            <th>状态</th>
            <th>端点</th>
            <th>PID</th>
            <th class="actions-heading">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in tableRows"
            :key="row.key"
            :class="[
              `${row.kind}-row`,
              row.kind === 'service' && { selected: selectedId === row.service.definition.id },
            ]"
            @click="row.kind === 'service' && emit('select', row.service.definition.id)"
          >
            <td v-if="row.kind === 'series'" colspan="5" class="group-cell series-cell">
              <div class="group-cell-content">
                <button
                  type="button"
                  class="group-toggle"
                  :aria-expanded="!collapsedSeriesIds.includes(row.series.id)"
                  @click.stop="toggleCollapsed('series', row.series.id)"
                >
                  <span aria-hidden="true">{{ collapsedSeriesIds.includes(row.series.id) ? '›' : '⌄' }}</span>
                  <strong>{{ row.series.name }}</strong>
                  <em>{{ row.series.profiles.length }} 个实例 · {{ row.series.services.length }} 个服务</em>
                </button>
                <button
                  v-if="row.series.profiles.length === 1"
                  type="button"
                  class="profile-action"
                  :class="{ readonly: ['readonly', 'blocked'].includes(profileAction(row.series.profiles[0]!)) }"
                  :disabled="['readonly', 'blocked'].includes(profileAction(row.series.profiles[0]!))"
                  :title="profileActionTitle(row.series.profiles[0]!)"
                  @click.stop="runProfileAction(row.series, row.series.profiles[0]!)"
                >
                  {{ profileActionLabel(row.series.profiles[0]!).replace('此实例', '全部') }}
                </button>
              </div>
            </td>
            <td v-else-if="row.kind === 'profile'" colspan="5" class="group-cell profile-cell">
              <div class="group-cell-content">
                <button
                  type="button"
                  class="group-toggle"
                  :aria-expanded="!collapsedProfileIds.includes(row.profile.key)"
                  @click.stop="toggleCollapsed('profile', row.profile.key)"
                >
                  <span aria-hidden="true">{{ collapsedProfileIds.includes(row.profile.key) ? '›' : '⌄' }}</span>
                  <strong>{{ pdhServiceProfileDisplayName(row.profile.services[0]!.definition) }}</strong>
                  <i
                    v-if="row.profile.environmentKind"
                    class="environment-badge"
                    :data-environment="row.profile.environmentKind"
                  >{{ environmentLabels[row.profile.environmentKind] }}</i>
                  <i v-if="row.profile.deploymentMode" class="deployment-badge">
                    {{ row.profile.deploymentMode === 'source-mounted' ? 'source-mounted · DEV ONLY' : 'package-assembled' }}
                  </i>
                  <i v-if="row.profile.evidence?.wingVersion">
                    Wing {{ row.profile.evidence.wingSource === 'registry' ? 'Registry ' : '' }}{{ row.profile.evidence.wingVersion }}
                  </i>
                  <i v-else-if="row.profile.wingVersion">Wing {{ row.profile.wingVersion }}</i>
                  <i
                    v-if="row.profile.evidence?.database"
                    class="database-badge"
                    :data-state="row.profile.evidence.database.state"
                    :title="row.profile.evidence.database.message"
                  >{{ row.profile.evidence.database.state === 'ready' ? 'DB 就绪' : row.profile.evidence.database.state === 'missing' ? 'DB 缺失' : row.profile.evidence.database.state === 'uninitialized' ? (row.profile.evidence.database.requiredRelationsStatus === 'provisional' ? 'DB 基线待确认' : 'DB 未初始化') : 'DB 预检失败' }}</i>
                  <em>{{ profileSummary(row.profile) }}</em>
                </button>
                <div class="profile-actions">
                  <button
                    v-if="row.profile.evidence?.database?.state === 'missing' && row.profile.services[0]?.definition.profilePolicy?.database.preflight?.creation"
                    type="button"
                    class="profile-action"
                    :disabled="row.profile.services.some(isActive)"
                    :title="row.profile.services.some(isActive) ? '先停止该实例的全部服务' : row.profile.evidence.database.message"
                    @click.stop="emit('create-database', row.profile.services[0]!.definition.id)"
                  >创建隔离库</button>
                  <button
                    v-if="row.profile.services.some((service) => service.ownership === 'hub') && row.profile.lifecycleControl"
                    type="button"
                    class="profile-action"
                    @click.stop="restartProfile(row.series, row.profile)"
                  >重启此实例</button>
                  <button
                    type="button"
                    class="profile-action"
                    :class="{ readonly: ['readonly', 'blocked'].includes(profileAction(row.profile)) }"
                    :disabled="['readonly', 'blocked'].includes(profileAction(row.profile))"
                    :title="profileActionTitle(row.profile)"
                    @click.stop="runProfileAction(row.series, row.profile)"
                  >
                    {{ profileActionLabel(row.profile) }}
                  </button>
                </div>
              </div>
            </td>
            <template v-else>
            <td>
              <div class="service-title">
                <strong>{{ pdhServiceDisplayName(row.service.definition) }}</strong>
                <em
                  :data-source="row.service.definition.configurationSource ?? 'builtin'"
                  :title="row.service.definition.configurationOverridden ? '默认服务已有本机覆盖' : undefined"
                >
                  {{ row.service.definition.configurationSource === 'user' ? 'User' : row.service.definition.configurationOverridden ? '默认 · 已覆盖' : '默认' }}
                </em>
                <em
                  v-if="row.service.profileEvidence"
                  class="assembly-evidence"
                  :data-state="row.service.profileEvidence.state"
                  :title="`${row.service.profileEvidence.message} · DB ${row.service.profileEvidence.databaseName}${row.service.profileEvidence.wingIntegrity ? ` · ${row.service.profileEvidence.wingIntegrity}` : ''}`"
                >{{ row.service.profileEvidence.state === 'source-mounted' ? 'DEV ONLY' : row.service.profileEvidence.state === 'verified' ? 'PACKAGE VERIFIED' : row.service.profileEvidence.state.toUpperCase() }}</em>
                <em
                  v-if="row.service.definition.configurationErrors?.length"
                  class="configuration-error"
                  :title="row.service.definition.configurationErrors.join('；')"
                >配置错误</em>
              </div>
              <span>{{ row.service.definition.description }}</span>
            </td>
            <td>
              <span class="status" :data-state="row.service.lifecycle">
                <i />{{ lifecycleLabels[row.service.lifecycle] }}
              </span>
              <span class="ownership" :data-ownership="row.service.ownership">
                {{ ownershipLabels[row.service.ownership] }}
              </span>
              <span class="health" :data-health="pdhPresentedHealth(row.service).state">{{ pdhPresentedHealth(row.service).label }}</span>
              <small v-if="row.service.message">{{ row.service.message }}</small>
            </td>
            <td>
              <div class="endpoints">
                <div
                  v-for="position in endpointPositions"
                  :key="position"
                  class="endpoint-position"
                  :data-position="position"
                >
                  <span
                    v-for="endpoint in positionedEndpoints(row.service, position)"
                    :key="endpoint.id"
                    :class="{
                      healthy: pdhPresentedEndpoint(row.service, endpoint).state === 'healthy',
                      unverified: pdhPresentedEndpoint(row.service, endpoint).state === 'reachable-unverified',
                      unhealthy: pdhPresentedEndpoint(row.service, endpoint).state === 'unhealthy',
                      checking: pdhPresentedEndpoint(row.service, endpoint).state === 'checking',
                    }"
                    :title="`${endpoint.probeMessage}${endpoint.healthUrl ? ` · ${endpoint.healthUrl}` : ''}`"
                  >
                    {{ endpoint.label }} · {{ endpoint.port }}
                  </span>
                  <span v-if="position === 'other' && row.service.endpoints.length === 0">
                    无固定端口
                  </span>
                </div>
              </div>
            </td>
            <td class="pid-cell">
              {{ row.service.pid ?? (row.service.externalProcesses.map((item) => item.pid).join(", ") || "—") }}
            </td>
            <td>
              <div class="row-actions" @click.stop>
                <button
                  v-if="row.service.lifecycle === 'stopped'"
                  type="button"
                  class="primary-action icon-action"
                  :disabled="busyIds.has(row.service.definition.id) || row.service.definition.profilePolicy?.lifecycleControl === false || serviceStartBlocked(row.service)"
                  :aria-label="`启动 ${row.service.definition.name}`"
                  :title="row.service.definition.configurationErrors?.length ? `配置错误：${row.service.definition.configurationErrors.join('；')}` : serviceStartBlocked(row.service) ? row.service.profileEvidence?.database?.message : '启动'"
                  @click="emit('start', row.service.definition.id)"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m5 3 7 5-7 5Z" />
                  </svg>
                </button>
                <button
                  v-else-if="row.service.ownership === 'hub' || row.service.ownership === 'external'"
                  type="button"
                  class="danger-action icon-action"
                  :disabled="busyIds.has(row.service.definition.id) || row.service.definition.profilePolicy?.lifecycleControl === false"
                  :aria-label="`停止 ${row.service.definition.name}`"
                  :title="row.service.definition.profilePolicy?.lifecycleControl === false ? '生产环境默认只读，Hub 不执行停止操作' : '停止'"
                  @click="emit('stop', row.service.definition.id)"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="4" y="4" width="8" height="8" rx="1" />
                  </svg>
                </button>
                <button
                  v-else
                  type="button"
                  class="danger-action icon-action"
                  disabled
                  aria-label="端口冲突，不能停止"
                  title="端口冲突或身份不符，不能一键停止"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 3l10 10M13 3 3 13" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="icon-action"
                  :disabled="!canOpen(row.service)"
                  :aria-label="`打开 ${row.service.definition.name} 网站`"
                  title="打开网站"
                  @click="emit('open', row.service.definition.id)"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M9 3h4v4M13 3 7.5 8.5M12 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
                  </svg>
                </button>
                <details class="more-actions">
                  <summary :aria-label="`${row.service.definition.name} 更多操作`" title="更多操作">…</summary>
                  <div class="action-menu" role="menu">
                    <button
                      v-if="row.service.ownership === 'hub' && row.service.definition.profilePolicy?.lifecycleControl !== false"
                      type="button"
                      role="menuitem"
                      @click="emit('restart', row.service.definition.id)"
                    >
                      重启此服务
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      @click="chooseMenuAction($event, 'logs', row.service.definition.id)"
                    >
                      查看运行日志
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      :disabled="!systemTerminal.available || row.service.definition.profilePolicy?.lifecycleControl === false || Boolean(row.service.definition.configurationErrors?.length)"
                      :title="row.service.definition.configurationErrors?.length ? `配置错误：${row.service.definition.configurationErrors.join('；')}` : row.service.definition.profilePolicy?.lifecycleControl === false ? '生产环境默认只读，Hub 不打开运行目录终端' : systemTerminal.available ? `使用 ${systemTerminal.label} 打开服务目录` : systemTerminal.reason"
                      @click="chooseMenuAction($event, 'terminal', row.service.definition.id)"
                    >
                      打开系统终端
                    </button>
                    <button
                      v-if="row.service.definition.localProjectId"
                      type="button"
                      role="menuitem"
                      @click="chooseProjectAction($event, row.service.definition.localProjectId)"
                    >
                      编辑项目配置
                    </button>
                    <button
                      v-else
                      type="button"
                      role="menuitem"
                      @click="chooseServiceConfigAction($event, row.service.definition.id)"
                    >
                      编辑内置配置
                    </button>
                  </div>
                </details>
              </div>
            </td>
            </template>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-state">
        <template v-if="searchQueryModel.trim()">
          <strong>没有匹配的服务</strong>
          <span>换一个名称、模块或端口试试</span>
          <button type="button" @click="searchQueryModel = ''">清空搜索</button>
        </template>
        <template v-else>当前筛选下没有服务。</template>
      </div>
    </div>
  </PnwPageLayout>
</template>

<style scoped>
.service-editor { width: 100%; height: 100%; --pnw-page-main-block-padding: 20px; --pdh-header-control-height: calc(var(--pnw-workbench-view-header-height, 40px) - 8px); }
.page-intro { margin: 0; padding: var(--pnw-page-main-block-padding, var(--pnw-page-body-padding, 10px)) var(--pnw-page-main-block-padding, var(--pnw-page-body-padding, 10px)) 0; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 11px; line-height: 1.5; }
.search-control { width: clamp(150px, 16vw, 230px); height: var(--pdh-header-control-height); display: flex; align-items: center; gap: 6px; box-sizing: border-box; padding: 0 8px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #cbd5e1)); border-radius: 6px; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
.search-control:focus-within { border-color: var(--pnw-focus-ring, var(--pnw-workbench-default-focus, #2563eb)); box-shadow: 0 0 0 1px var(--pnw-focus-ring, var(--pnw-workbench-default-focus, #2563eb)); }
.search-control svg { width: 13px; height: 13px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
.search-control input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); font: inherit; font-size: 11px; }
.search-control input::placeholder { color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #94a3b8)); }
.search-control input::-webkit-search-cancel-button { cursor: pointer; }
.sort-control { height: var(--pdh-header-control-height); box-sizing: border-box; padding: 0 24px 0 8px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #cbd5e1)); border-radius: 6px; outline: 0; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); font: inherit; font-size: 11px; cursor: pointer; }
.sort-control:focus-visible { border-color: var(--pnw-focus-ring, var(--pnw-workbench-default-focus, #2563eb)); box-shadow: 0 0 0 1px var(--pnw-focus-ring, var(--pnw-workbench-default-focus, #2563eb)); }
.tree-actions { display: inline-flex; overflow: hidden; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #cbd5e1)); border-radius: 6px; }
.tree-actions button { min-height: var(--pdh-header-control-height); padding: 0 7px; border: 0; border-right: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #cbd5e1)); background: transparent; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font: inherit; font-size: 10px; cursor: pointer; }
.tree-actions button:last-child { border-right: 0; }
.tree-actions button:hover { background: var(--pnw-control-hover-bg, var(--pnw-workbench-default-hover-bg, rgba(59, 130, 246, .08))); color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); }
.service-count { padding: 6px 10px; border-radius: 999px; background: var(--pnw-control-active-bg, var(--pnw-workbench-default-active-bg, rgba(37, 99, 235, .1))); color: var(--pnw-control-active-text, var(--pnw-workbench-default-active-text, #2563eb)); font-size: 12px; font-weight: 700; }
.service-table-wrap { width: 100%; min-width: 0; min-height: 100%; overflow-x: auto; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 10px; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); box-shadow: 0 12px 34px rgba(15, 23, 42, .055); }
.service-table { width: 100%; min-width: 960px; table-layout: fixed; border-collapse: collapse; color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); }
.service-column { width: 36%; }
.status-column { width: 15%; }
.endpoint-column { width: 28%; }
.pid-column { width: 8%; }
.actions-column { width: 13%; }
.configuration-alert { display: grid; gap: 3px; padding: 9px 14px; border-bottom: 1px solid rgba(220, 38, 38, .34); background: rgba(220, 38, 38, .1); color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); font-size: 11px; }
.configuration-alert strong { color: #ef4444; font-size: 12px; }
.configuration-alert small { color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
th { padding: 10px 14px; text-align: left; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); background: var(--pnw-workbench-bg, var(--pnw-workbench-default-bg, rgba(148, 163, 184, .08))); border-bottom: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); }
td { padding: 12px 10px; border-bottom: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #e2e8f0)); vertical-align: middle; font-size: 12px; }
tbody tr { cursor: pointer; transition: background .15s ease; }
tbody tr:hover { background: var(--pnw-control-hover-bg, var(--pnw-workbench-default-hover-bg, rgba(59, 130, 246, .07))); }
tbody tr.selected { background: var(--pnw-control-active-bg, var(--pnw-workbench-default-active-bg, rgba(59, 130, 246, .09))); box-shadow: inset 3px 0 var(--pnw-focus-ring, var(--pnw-workbench-default-focus, #2563eb)); }
tbody tr:last-child td { border-bottom: 0; }
.group-cell { height: 38px; padding: 0 10px; background: var(--pnw-workbench-bg, var(--pnw-workbench-default-bg, rgba(148, 163, 184, .08))); cursor: default; }
.series-cell { border-top: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); }
tbody .series-row:first-child .series-cell { border-top: 0; }
.profile-cell { padding-left: 26px; background: color-mix(in srgb, var(--pnw-workbench-bg, var(--pnw-workbench-default-bg, #f8fafc)) 65%, transparent); }
.group-cell-content, .group-toggle { align-items: center; }
.group-cell-content { width: 100%; min-width: 0; display: flex; justify-content: space-between; gap: 8px; }
.group-toggle { min-width: 0; flex: 1 1 auto; min-height: 34px; display: flex; flex-wrap: wrap; gap: 4px 8px; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.group-toggle > span { width: 13px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 16px; }
.group-toggle strong { margin: 0; font-size: 12px; white-space: nowrap; }
.group-toggle em, .group-toggle i { color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 9px; font-style: normal; font-weight: 600; }
.group-toggle i { padding: 1px 5px; border-radius: 999px; background: rgba(37, 99, 235, .11); color: var(--pnw-control-active-text, #60a5fa); }
.group-toggle .environment-badge[data-environment="release-validation"] { background: rgba(245, 158, 11, .14); color: #b45309; }
.group-toggle .environment-badge[data-environment="preproduction"] { background: rgba(245, 158, 11, .14); color: #b45309; }
.group-toggle .environment-badge[data-environment="production"] { background: rgba(220, 38, 38, .16); color: #dc2626; }
.group-toggle .database-badge[data-state="ready"] { background: rgba(22, 163, 74, .12); color: #15803d; }
.group-toggle .database-badge[data-state="missing"],
.group-toggle .database-badge[data-state="uninitialized"],
.group-toggle .database-badge[data-state="unavailable"] { background: rgba(245, 158, 11, .14); color: #b45309; }
.group-toggle .deployment-badge { background: rgba(139, 92, 246, .12); color: #7c3aed; }
.configuration-error { padding: 1px 5px; border-radius: 999px; background: rgba(220, 38, 38, .14); color: #dc2626 !important; font-size: 9px !important; font-style: normal; font-weight: 700; }
.profile-actions { display: flex; align-items: center; gap: 5px; }
.profile-action { flex: 0 0 auto; min-height: 26px; padding: 0 8px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #cbd5e1)); border-radius: 5px; background: transparent; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font: inherit; font-size: 9px; font-weight: 700; cursor: pointer; }
.profile-action:hover { border-color: var(--pnw-focus-ring, #2563eb); color: var(--pnw-control-active-text, #60a5fa); }
.profile-action.readonly, .profile-action:disabled { cursor: not-allowed; opacity: .72; }
.service-row td:first-child { padding-left: 30px; }
td strong, td > span { display: block; }
td strong { font-size: 13px; margin-bottom: 3px; }
td > span { color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
.service-title { display: flex; align-items: center; gap: 6px; }
.service-title strong { margin-bottom: 0; }
.service-title em { padding: 1px 5px; border-radius: 999px; background: rgba(148, 163, 184, .14); color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 8px; font-style: normal; font-weight: 700; white-space: nowrap; }
.service-title em[data-source="user"] { background: rgba(139, 92, 246, .12); color: #8b5cf6; }
.service-title .assembly-evidence[data-state="source-mounted"] { background: rgba(245, 158, 11, .12); color: #b45309; }
.service-title .assembly-evidence[data-state="verified"] { background: rgba(22, 163, 74, .12); color: #15803d; }
.service-title .assembly-evidence[data-state="invalid"] { background: rgba(220, 38, 38, .14); color: #dc2626; }
.status { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; white-space: nowrap; color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #475569)); }
.status i { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 999px; background: #94a3b8; }
.status[data-state="running"] i { background: #16a34a; box-shadow: 0 0 0 4px rgba(22, 163, 74, .1); }
.status[data-state="starting"] i { background: #2563eb; }
.status[data-state="stopping"] i, .status[data-state="conflict"] i { background: #f59e0b; }
.status[data-state="external"] i { background: #8b5cf6; }
.ownership { display: inline-block; margin: 4px 0 0 5px; padding: 1px 5px; border-radius: 999px; background: rgba(148, 163, 184, .12); color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 9px; font-weight: 700; white-space: nowrap; }
.ownership[data-ownership="hub"] { background: rgba(37, 99, 235, .1); color: #2563eb; }
.ownership[data-ownership="external"] { background: rgba(139, 92, 246, .12); color: #7c3aed; }
.ownership[data-ownership="conflict"] { background: rgba(245, 158, 11, .14); color: #b45309; }
.health { display: inline-block; margin-top: 4px; padding: 1px 5px; border-radius: 999px; background: rgba(148, 163, 184, .12); color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 9px; white-space: nowrap; }
.health[data-health="ready"] { background: rgba(22, 163, 74, .1); color: #15803d; }
.health[data-health="reachable"] { background: rgba(37, 99, 235, .1); color: #2563eb; }
.health[data-health="checking"] { background: rgba(37, 99, 235, .1); color: #2563eb; }
.health[data-health="partial"] { background: rgba(245, 158, 11, .12); color: #b45309; }
.health[data-health="unhealthy"] { background: rgba(239, 68, 68, .1); color: #dc2626; }
td small { display: block; max-width: 220px; margin-top: 5px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
.endpoints { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 5px; min-width: 260px; }
.endpoint-position { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.endpoint-position[data-position="api"] { grid-column: 1; justify-self: start; justify-content: flex-start; }
.endpoint-position[data-position="other"] { grid-column: 2; justify-self: center; justify-content: center; }
.endpoint-position[data-position="web"] { grid-column: 3; justify-self: end; justify-content: flex-end; }
.endpoints span { padding: 3px 6px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, transparent)); border-radius: 5px; background: var(--pnw-workbench-bg, var(--pnw-workbench-default-bg, rgba(148, 163, 184, .12))); color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); white-space: nowrap; }
.endpoints span.healthy { background: rgba(22, 163, 74, .1); color: #15803d; }
.endpoints span.unverified { background: rgba(37, 99, 235, .1); color: #2563eb; }
.endpoints span.checking { background: rgba(37, 99, 235, .1); color: #2563eb; }
.endpoints span.unhealthy { background: rgba(245, 158, 11, .12); color: #b45309; }
.pid-cell { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
.actions-heading { text-align: right; }
.row-actions { min-width: 92px; display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
button { appearance: none; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #cbd5e1)); border-radius: 6px; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); color: inherit; padding: 6px 8px; font: inherit; cursor: pointer; }
.row-actions > button { width: 30px; height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0; white-space: nowrap; }
.row-actions svg { width: 13px; height: 13px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.row-actions .primary-action svg { fill: currentColor; stroke: none; }
button:hover:not(:disabled) { background: var(--pnw-control-hover-bg, var(--pnw-workbench-default-hover-bg, rgba(148, 163, 184, .08))); }
button:disabled { opacity: .42; cursor: not-allowed; }
button.primary-action { background: #2563eb; border-color: #2563eb; color: #fff; }
button.danger-action { color: #ef4444; border-color: rgba(239, 68, 68, .48); }
.add-project { width: auto; height: var(--pdh-header-control-height); display: inline-flex; align-items: center; gap: 4px; border-color: color-mix(in srgb, var(--pnw-control-active-text, #2563eb) 38%, transparent); color: var(--pnw-control-active-text, var(--pnw-workbench-default-active-text, #2563eb)); padding: 0 9px; line-height: 1; white-space: nowrap; }
.add-project span { font-size: 15px; line-height: 1; }
.more-actions { position: relative; }
.more-actions summary { display: grid; place-items: center; width: 30px; height: 28px; box-sizing: border-box; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #cbd5e1)); border-radius: 6px; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); color: inherit; cursor: pointer; font-size: 16px; line-height: 1; list-style: none; }
.more-actions summary::-webkit-details-marker { display: none; }
.more-actions summary:hover, .more-actions[open] summary { background: var(--pnw-control-hover-bg, var(--pnw-workbench-default-hover-bg, rgba(148, 163, 184, .08))); }
.action-menu { position: absolute; z-index: 30; top: calc(100% + 4px); right: 0; min-width: 132px; display: grid; gap: 2px; padding: 4px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #cbd5e1)); border-radius: 7px; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); box-shadow: 0 10px 28px rgba(15, 23, 42, .2); }
.action-menu button { width: 100%; display: flex; align-items: center; gap: 7px; border-color: transparent; text-align: left; }
.action-menu svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.empty-state { min-height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
.empty-state strong { color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); }
.empty-state button { margin-top: 4px; color: var(--pnw-control-active-text, var(--pnw-workbench-default-active-text, #2563eb)); }
@media (max-width: 920px) { .service-count { display: none; } .search-control { width: 150px; } }
@media (max-width: 720px) { .service-editor { --pnw-page-main-block-padding: 14px; } .sort-control { max-width: 94px; } .search-control { width: 132px; } }
</style>
