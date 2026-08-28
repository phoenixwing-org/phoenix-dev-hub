<script setup lang="ts">
import { computed, ref, watch } from "vue";
import PnwPageHeader from "phoenix-wing/layout/PnwPageHeader.vue";
import type {
  BuiltinServiceConfigCatalogResponse,
  BuiltinServiceConfigEntry,
  BuiltinServiceSeriesConfigEntry,
  DevHubConfigurationDocument,
  LocalNodeProject,
  LocalNodeProjectCandidate,
  LocalProjectCatalogResponse,
  LocalProjectTransferDocument,
  ServiceDefinition,
  ServiceRuntimeStatus,
  ServiceSeriesSource,
} from "@shared/contracts";
import { devHubApi } from "../api";

defineOptions({ name: "PdhServiceConfigView" });
const props = defineProps<{
  open: boolean;
  embedded?: boolean;
  initialProjectId?: string;
  initialServiceId?: string;
  services?: readonly ServiceRuntimeStatus[];
}>();
const emit = defineEmits<{
  close: [];
  changed: [serviceId?: string];
  error: [error: unknown];
}>();

type DialogView = "list" | "form" | "service" | "series" | "import";
type ConfigEditorTab = "form" | "json" | "effective";
const catalog = ref<LocalProjectCatalogResponse>();
const builtinCatalog = ref<BuiltinServiceConfigCatalogResponse>();
const view = ref<DialogView>("list");
const editingProjectId = ref("");
const editingServiceId = ref("");
const serviceJson = ref("");
const serviceDraft = ref<ServiceDefinition>();
const serviceFormName = ref("");
const serviceFormDescription = ref("");
const serviceFormCwd = ref("");
const serviceFormExecutable = ref("");
const serviceFormArgs = ref("");
const editingSeriesId = ref("");
const seriesJson = ref("");
const seriesDraft = ref<ServiceSeriesSource>();
const seriesFormName = ref("");
const editorTab = ref<ConfigEditorTab>("form");
const editorError = ref("");
const selectedDirectory = ref("");
const manualDirectory = ref("");
const candidate = ref<LocalNodeProjectCandidate>();
const displayName = ref("");
const script = ref("");
const loading = ref(false);
const saving = ref(false);
const deletingProjectId = ref("");
const deletingServiceId = ref("");
const resetConfirmation = ref(false);
const importDocument = ref<LocalProjectTransferDocument | DevHubConfigurationDocument>();
const importFileName = ref("");
const notice = ref("");

const projects = computed(() => catalog.value?.projects ?? []);
const builtinServices = computed(() => builtinCatalog.value?.services ?? []);
const builtinSeries = computed(() => builtinCatalog.value?.series ?? []);
const activeBuiltinCount = computed(() => builtinServices.value.filter(
  (entry) => !entry.removed && !isServiceMutable(entry.id),
).length);
const availableCandidates = computed(
  () => catalog.value?.candidates.filter((item) => !item.configured) ?? [],
);
const formTitle = computed(() => editingProjectId.value ? "编辑 Node.js 项目" : "添加 Node.js 项目");
const viewTitle = computed(() => {
  if (view.value === "list") return "服务设置";
  if (view.value === "import") return "导入服务配置";
  if (view.value === "series") return "编辑产品系列";
  if (view.value === "service") return "编辑默认服务";
  return formTitle.value;
});
const viewHint = computed(() => {
  if (view.value === "list") return "管理产品系列、默认服务与 User 项目";
  if (view.value === "import") return "校验并合并本机 JSON 配置";
  if (view.value === "series") return "编辑模板、版本实例与服务覆盖项";
  if (view.value === "service") return "修改当前机器使用的默认服务覆盖";
  return editingProjectId.value ? "修改本机 Node.js 项目的显示名称与启动脚本" : "从本地目录加入受控启动列表";
});
const subviewPrimaryLabel = computed(() => {
  if (saving.value) return view.value === "import" ? "导入中…" : "保存中…";
  if (view.value === "form") return editingProjectId.value ? "保存修改" : "加入启动列表";
  if (view.value === "service") return "保存本机覆盖";
  if (view.value === "series") return "保存系列配置";
  return "校验并合并";
});
const subviewPrimaryDisabled = computed(() => {
  if (saving.value) return true;
  if (view.value === "form") return !candidate.value || !script.value || !displayName.value.trim();
  if (view.value === "service") return !serviceJson.value.trim();
  if (view.value === "series") return Boolean(editorError.value) || !seriesFormName.value.trim();
  if (view.value === "import") return !importDocument.value;
  return true;
});
const effectiveEditorJson = computed(() => {
  if (view.value === "series") {
    const entry = builtinSeries.value.find((item) => item.id === editingSeriesId.value);
    return JSON.stringify({
      source: seriesDraft.value,
      resolvedServices: entry?.services ?? [],
    }, null, 2);
  }
  return JSON.stringify(serviceDraft.value, null, 2);
});

function isServiceMutable(serviceId: string): boolean {
  const status = props.services?.find((service) => service.definition.id === serviceId);
  return !status || status.lifecycle === "stopped";
}

function portableServiceDefinition(definition: ServiceDefinition): ServiceDefinition {
  const {
    configurationSource: _configurationSource,
    configurationOverridden: _configurationOverridden,
    localProjectId: _localProjectId,
    ...portable
  } = definition;
  return portable;
}

function cloneConfiguration<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function useCandidate(next?: LocalNodeProjectCandidate, resetName = true): void {
  candidate.value = next;
  selectedDirectory.value = next?.directory ?? "";
  manualDirectory.value = next?.directory ?? manualDirectory.value;
  if (resetName) displayName.value = next?.name ?? "";
  script.value = next?.scripts.includes(script.value) ? script.value : (next?.scripts[0] ?? "");
}

function resetForm(): void {
  editingProjectId.value = "";
  editingServiceId.value = "";
  serviceJson.value = "";
  serviceDraft.value = undefined;
  editingSeriesId.value = "";
  seriesJson.value = "";
  seriesDraft.value = undefined;
  editorTab.value = "form";
  editorError.value = "";
  selectedDirectory.value = "";
  manualDirectory.value = "";
  candidate.value = undefined;
  displayName.value = "";
  script.value = "";
}

function showList(): void {
  view.value = "list";
  deletingProjectId.value = "";
  deletingServiceId.value = "";
  resetConfirmation.value = false;
  importDocument.value = undefined;
  importFileName.value = "";
  resetForm();
}

function dismissSubview(): void {
  if (props.embedded && view.value !== "list") {
    showList();
    return;
  }
  if (!props.embedded) emit("close");
}

async function loadCatalog(): Promise<void> {
  loading.value = true;
  try {
    [catalog.value, builtinCatalog.value] = await Promise.all([
      devHubApi.projectCatalog(),
      devHubApi.builtinServiceConfig(),
    ]);
    const requested = projects.value.find((project) => project.id === props.initialProjectId);
    const requestedService = builtinServices.value.find((entry) => entry.id === props.initialServiceId);
    if (requested) await startEdit(requested);
    else if (requestedService) startEditService(requestedService);
    else showList();
  } catch (error) {
    emit("error", error);
  } finally {
    loading.value = false;
  }
}

function startEditService(entry: BuiltinServiceConfigEntry): void {
  notice.value = "";
  view.value = "service";
  editingServiceId.value = entry.id;
  const definition = portableServiceDefinition(entry.definition ?? entry.baseline);
  serviceDraft.value = definition;
  serviceJson.value = JSON.stringify(definition, null, 2);
  serviceFormName.value = definition.name;
  serviceFormDescription.value = definition.description ?? "";
  serviceFormCwd.value = definition.cwd;
  serviceFormExecutable.value = definition.command.executable;
  serviceFormArgs.value = definition.command.args.join("\n");
  editorTab.value = "form";
}

function isSeriesMutable(entry: BuiltinServiceSeriesConfigEntry): boolean {
  return entry.services.every((service) => isServiceMutable(service.id));
}

function startEditSeries(entry: BuiltinServiceSeriesConfigEntry): void {
  notice.value = "";
  view.value = "series";
  editingSeriesId.value = entry.id;
  seriesDraft.value = cloneConfiguration(entry.definition);
  seriesJson.value = JSON.stringify(entry.definition, null, 2);
  seriesFormName.value = entry.definition.name;
  editorTab.value = "form";
  editorError.value = "";
}

function jsonErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const position = /position\s+(\d+)/i.exec(error.message)?.[1];
  if (!position) return error.message;
  const source = view.value === "series" ? seriesJson.value : serviceJson.value;
  const before = source.slice(0, Number(position));
  const line = before.split("\n").length;
  const column = Number(position) - before.lastIndexOf("\n");
  return `第 ${line} 行、第 ${column} 列：${error.message}`;
}

function applyServiceForm(): ServiceDefinition | undefined {
  if (!serviceDraft.value) return undefined;
  const next: ServiceDefinition = {
    ...serviceDraft.value,
    name: serviceFormName.value.trim(),
    description: serviceFormDescription.value.trim() || undefined,
    cwd: serviceFormCwd.value.trim(),
    command: {
      ...serviceDraft.value.command,
      executable: serviceFormExecutable.value.trim(),
      args: serviceFormArgs.value.split("\n").map((item) => item.trim()).filter(Boolean),
    },
  };
  serviceDraft.value = next;
  serviceJson.value = JSON.stringify(next, null, 2);
  return next;
}

function parseEditorJson(): boolean {
  try {
    if (view.value === "series") {
      const parsed = JSON.parse(seriesJson.value) as ServiceSeriesSource;
      seriesDraft.value = parsed;
      seriesFormName.value = parsed.name ?? "";
    } else {
      const parsed = JSON.parse(serviceJson.value) as ServiceDefinition;
      serviceDraft.value = parsed;
      serviceFormName.value = parsed.name ?? "";
      serviceFormDescription.value = parsed.description ?? "";
      serviceFormCwd.value = parsed.cwd ?? "";
      serviceFormExecutable.value = parsed.command?.executable ?? "";
      serviceFormArgs.value = parsed.command?.args?.join("\n") ?? "";
    }
    editorError.value = "";
    return true;
  } catch (error) {
    editorError.value = jsonErrorMessage(error);
    return false;
  }
}

function switchEditorTab(next: ConfigEditorTab): void {
  if (editorTab.value === "json" && !parseEditorJson()) return;
  if (editorTab.value === "form") {
    if (view.value === "series" && seriesDraft.value) {
      seriesDraft.value = { ...seriesDraft.value, name: seriesFormName.value.trim() };
      seriesJson.value = JSON.stringify(seriesDraft.value, null, 2);
    } else {
      applyServiceForm();
    }
  }
  editorTab.value = next;
}

function formatEditorJson(): void {
  if (!parseEditorJson()) return;
  if (view.value === "series") seriesJson.value = JSON.stringify(seriesDraft.value, null, 2);
  else serviceJson.value = JSON.stringify(serviceDraft.value, null, 2);
}

function updateSeriesProfile(
  profileIndex: number,
  field: "name" | "runtimeSlot" | "wingVersion",
  value: string,
): void {
  if (!seriesDraft.value) return;
  const profiles = seriesDraft.value.profiles.map((profile, index) => {
    if (index !== profileIndex) return profile;
    if (field === "name") return { ...profile, name: value };
    if (field === "runtimeSlot") return { ...profile, runtimeSlot: value.trim() || undefined };
    return {
      ...profile,
      metadata: { ...profile.metadata, wingVersion: value.trim() || undefined },
    };
  });
  seriesDraft.value = { ...seriesDraft.value, profiles };
  seriesJson.value = JSON.stringify(seriesDraft.value, null, 2);
}

function cloneSeriesProfile(profileIndex: number): void {
  if (!seriesDraft.value) return;
  const source = seriesDraft.value.profiles[profileIndex];
  if (!source) return;
  let sequence = seriesDraft.value.profiles.length + 1;
  let id = `version-${sequence}`;
  const ids = new Set(seriesDraft.value.profiles.map((profile) => profile.id));
  while (ids.has(id)) id = `version-${++sequence}`;
  const services = Object.fromEntries(Object.entries(cloneConfiguration(source.services)).map(([role, service]) => {
    if (service === false || !service.id) return [role, service];
    return [role, { ...service, id: `${service.id}-${id}`.slice(0, 64) }];
  }));
  const profile = {
    ...cloneConfiguration(source),
    id,
    name: `新版本 ${sequence}`,
    services,
  };
  seriesDraft.value = { ...seriesDraft.value, profiles: [...seriesDraft.value.profiles, profile] };
  seriesJson.value = JSON.stringify(seriesDraft.value, null, 2);
}

function removeSeriesProfile(profileIndex: number): void {
  if (!seriesDraft.value || seriesDraft.value.profiles.length <= 1) return;
  seriesDraft.value = {
    ...seriesDraft.value,
    profiles: seriesDraft.value.profiles.filter((_, index) => index !== profileIndex),
  };
  seriesJson.value = JSON.stringify(seriesDraft.value, null, 2);
}

function startAdd(): void {
  notice.value = "";
  resetForm();
  view.value = "form";
  useCandidate(availableCandidates.value[0]);
}

async function startEdit(project: LocalNodeProject): Promise<void> {
  notice.value = "";
  view.value = "form";
  editingProjectId.value = project.id;
  manualDirectory.value = project.directory;
  displayName.value = project.name;
  script.value = project.script;
  loading.value = true;
  try {
    useCandidate(await devHubApi.inspectProject(project.directory), false);
    script.value = project.script;
  } catch (error) {
    emit("error", error);
  } finally {
    loading.value = false;
  }
}

function selectDiscovered(directory: string): void {
  useCandidate(catalog.value?.candidates.find((item) => item.directory === directory));
}

async function inspectManual(): Promise<void> {
  if (!manualDirectory.value.trim()) return;
  loading.value = true;
  try {
    useCandidate(
      await devHubApi.inspectProject(manualDirectory.value.trim()),
      !editingProjectId.value,
    );
  } catch (error) {
    emit("error", error);
  } finally {
    loading.value = false;
  }
}

async function saveProject(): Promise<void> {
  if (!candidate.value || !script.value || !displayName.value.trim()) return;
  saving.value = true;
  try {
    const input = {
      directory: candidate.value.directory,
      script: script.value,
      name: displayName.value.trim(),
    };
    const result = editingProjectId.value
      ? await devHubApi.updateProject(editingProjectId.value, input)
      : await devHubApi.addProject(input);
    notice.value = editingProjectId.value ? "项目配置已更新" : "项目已加入启动列表";
    emit("changed", result.project.serviceId);
    catalog.value = await devHubApi.projectCatalog();
    showList();
  } catch (error) {
    emit("error", error);
  } finally {
    saving.value = false;
  }
}

async function deleteProject(project: LocalNodeProject): Promise<void> {
  saving.value = true;
  try {
    await devHubApi.deleteProject(project.id);
    notice.value = `已将 ${project.name} 移出 Hub；磁盘目录未删除`;
    deletingProjectId.value = "";
    catalog.value = await devHubApi.projectCatalog();
    emit("changed");
  } catch (error) {
    emit("error", error);
  } finally {
    saving.value = false;
  }
}

async function saveBuiltinService(): Promise<void> {
  if (!editingServiceId.value || !serviceJson.value.trim()) return;
  saving.value = true;
  try {
    const definition = editorTab.value === "json"
      ? (parseEditorJson() ? serviceDraft.value : undefined)
      : applyServiceForm();
    if (!definition) return;
    const service = await devHubApi.updateBuiltinService(editingServiceId.value, definition);
    notice.value = `已更新默认服务 ${service.definition.name}`;
    emit("changed", service.definition.id);
    [catalog.value, builtinCatalog.value] = await Promise.all([
      devHubApi.projectCatalog(),
      devHubApi.builtinServiceConfig(),
    ]);
    showList();
  } catch (error) {
    emit("error", error);
  } finally {
    saving.value = false;
  }
}

async function saveBuiltinSeries(): Promise<void> {
  if (!editingSeriesId.value) return;
  if (editorTab.value === "json" && !parseEditorJson()) return;
  if (editorTab.value === "form" && seriesDraft.value) {
    seriesDraft.value = { ...seriesDraft.value, name: seriesFormName.value.trim() };
  }
  if (!seriesDraft.value) return;
  saving.value = true;
  try {
    const entry = await devHubApi.updateBuiltinSeries(editingSeriesId.value, seriesDraft.value);
    notice.value = `已更新产品系列 ${entry.definition.name}`;
    emit("changed", entry.services[0]?.id);
    builtinCatalog.value = await devHubApi.builtinServiceConfig();
    showList();
  } catch (error) {
    emit("error", error);
  } finally {
    saving.value = false;
  }
}

async function deleteBuiltinService(entry: BuiltinServiceConfigEntry): Promise<void> {
  saving.value = true;
  try {
    await devHubApi.deleteBuiltinService(entry.id);
    notice.value = `已隐藏默认服务 ${entry.definition?.name ?? entry.baseline.name}；可随时单条显示`;
    deletingServiceId.value = "";
    builtinCatalog.value = await devHubApi.builtinServiceConfig();
    emit("changed");
  } catch (error) {
    emit("error", error);
  } finally {
    saving.value = false;
  }
}

async function restoreBuiltinService(entry: BuiltinServiceConfigEntry): Promise<void> {
  saving.value = true;
  try {
    const service = await devHubApi.restoreBuiltinService(entry.id);
    notice.value = `已显示默认服务 ${service.definition.name}`;
    builtinCatalog.value = await devHubApi.builtinServiceConfig();
    emit("changed", service.definition.id);
  } catch (error) {
    emit("error", error);
  } finally {
    saving.value = false;
  }
}

async function resetBuiltinServices(): Promise<void> {
  saving.value = true;
  try {
    builtinCatalog.value = await devHubApi.resetBuiltinServices();
    notice.value = "全部默认服务已恢复到用户配置基线";
    resetConfirmation.value = false;
    emit("changed");
  } catch (error) {
    emit("error", error);
  } finally {
    saving.value = false;
  }
}

async function exportConfiguration(target?: {
  readonly project?: LocalNodeProject;
  readonly service?: BuiltinServiceConfigEntry;
  readonly series?: BuiltinServiceSeriesConfigEntry;
}): Promise<void> {
  try {
    const all = await devHubApi.exportConfiguration();
    let document: DevHubConfigurationDocument = all;
    if (target?.project) {
      const project = target.project;
      document = all.version === 2
        ? { ...all, series: [], hiddenServiceIds: [], projects: all.projects.filter((item) => item.directory === project.directory) }
        : { ...all, services: [], projects: all.projects.filter((item) => item.directory === project.directory) };
    } else if (target?.service) {
      document = {
        format: "phoenix-dev-hub-config",
        version: 1,
        services: [portableServiceDefinition(target.service.definition ?? target.service.baseline)],
        projects: [],
      };
    } else if (target?.series && all.version === 2) {
      const serviceIds = new Set(target.series.services.map((service) => service.id));
      document = {
        ...all,
        series: [target.series.definition],
        hiddenServiceIds: all.hiddenServiceIds.filter((id) => serviceIds.has(id)),
        projects: [],
      };
    }
    const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = target?.project
      ? `phoenix-dev-hub-${target.project.id}.json`
      : target?.service
        ? `phoenix-dev-hub-${target.service.id}.json`
        : target?.series
          ? `phoenix-dev-hub-${target.series.id}.json`
        : "phoenix-dev-hub-config.json";
    anchor.click();
    URL.revokeObjectURL(url);
    notice.value = target?.project
      ? `已导出 User 项目 ${target.project.name}`
      : target?.service
        ? `已导出默认服务 ${target.service.definition?.name ?? target.service.baseline.name}`
        : target?.series
          ? `已导出产品系列 ${target.series.definition.name}`
          : `已导出 ${document.version === 2 ? document.series.length : document.services.length} 个配置分组与 ${document.projects.length} 个 User 项目`;
  } catch (error) {
    emit("error", error);
  }
}

async function selectImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text()) as LocalProjectTransferDocument | DevHubConfigurationDocument;
    const validProjects = parsed.format === "phoenix-dev-hub-projects"
      && parsed.version === 1
      && Array.isArray(parsed.projects);
    const validConfig = parsed.format === "phoenix-dev-hub-config"
      && Array.isArray(parsed.projects)
      && (
        (parsed.version === 1 && Array.isArray(parsed.services))
        || (parsed.version === 2 && Array.isArray(parsed.series) && Array.isArray(parsed.hiddenServiceIds))
      );
    if (!validProjects && !validConfig) {
      throw new Error("请选择 Phoenix Dev Hub 导出的 version=1 或 version=2 配置 JSON");
    }
    importDocument.value = parsed;
    importFileName.value = file.name;
  } catch (error) {
    importDocument.value = undefined;
    importFileName.value = "";
    emit("error", error);
  } finally {
    input.value = "";
  }
}

async function importProjects(): Promise<void> {
  if (!importDocument.value) return;
  saving.value = true;
  try {
    const firstServiceId = importDocument.value.format === "phoenix-dev-hub-config"
      ? await devHubApi.importConfiguration(importDocument.value).then((result) => {
          notice.value = `导入完成：默认服务 ${result.builtinUpdated} 个，User 新增 ${result.projectsAdded} 个、更新 ${result.projectsUpdated} 个`;
          return result.services[0]?.definition.id;
        })
      : await devHubApi.importProjects(importDocument.value).then((result) => {
          notice.value = `导入完成：User 新增 ${result.added} 个、更新 ${result.updated} 个`;
          return result.services[0]?.definition.id;
        });
    [catalog.value, builtinCatalog.value] = await Promise.all([
      devHubApi.projectCatalog(),
      devHubApi.builtinServiceConfig(),
    ]);
    emit("changed", firstServiceId);
    showList();
  } catch (error) {
    emit("error", error);
  } finally {
    saving.value = false;
  }
}

async function submitSubview(): Promise<void> {
  if (view.value === "form") await saveProject();
  else if (view.value === "service") await saveBuiltinService();
  else if (view.value === "series") await saveBuiltinSeries();
  else if (view.value === "import") await importProjects();
}

watch(
  () => props.open,
  (open) => {
    if (open) void loadCatalog();
  },
  { immediate: true },
);
</script>

<template>
  <div
    v-if="open"
    :class="embedded ? 'settings-view' : 'dialog-backdrop'"
    role="presentation"
    @mousedown.self="dismissSubview"
  >
    <section
      :class="['project-dialog', { embedded, subview: embedded && view !== 'list' }]"
      :role="embedded ? 'region' : 'dialog'"
      :aria-modal="embedded ? undefined : 'true'"
      :aria-label="viewTitle"
    >
      <PnwPageHeader
        :title="viewTitle"
        :presentation-detachable="false"
      >
        <template #actions>
          <template v-if="view !== 'list'">
            <button type="button" @click="showList">返回</button>
            <button
              type="button"
              class="primary"
              :disabled="subviewPrimaryDisabled"
              @click="submitSubview"
            >{{ subviewPrimaryLabel }}</button>
          </template>
          <button v-else-if="!embedded" type="button" @click="emit('close')">完成</button>
        </template>
      </PnwPageHeader>

      <p class="page-intro">{{ viewHint }}</p>
      <div v-if="view === 'list'" class="dialog-content project-list-view">
        <div class="management-toolbar">
          <button type="button" class="primary compact" @click="startAdd">＋ 添加 User 项目</button>
          <button type="button" class="compact" @click="view = 'import'; notice = ''">导入 JSON</button>
          <button type="button" class="compact" @click="exportConfiguration()">导出全部</button>
          <button
            v-if="!resetConfirmation"
            type="button"
            class="compact"
            :disabled="activeBuiltinCount > 0"
            :title="activeBuiltinCount ? `有 ${activeBuiltinCount} 个默认服务仍在活动，请先停止` : '恢复仓库默认服务'"
            @click="resetConfirmation = true"
          >
            重置默认
          </button>
        </div>

        <div v-if="resetConfirmation" class="reset-confirm">
          <span>恢复仓库默认服务，清除本机覆盖与隐藏状态；不会影响 User 项目。确定？</span>
          <button type="button" @click="resetConfirmation = false">取消</button>
          <button type="button" class="danger" :disabled="saving" @click="resetBuiltinServices">
            {{ saving ? '重置中…' : '确定重置' }}
          </button>
        </div>

        <p v-if="notice" class="notice" role="status">{{ notice }}</p>
        <p v-if="loading" class="empty-projects">正在读取本机服务配置…</p>

        <template v-if="!loading">
          <section class="config-section">
            <div class="section-heading">
              <h3>产品系列</h3>
              <span>{{ builtinSeries.length }} 组</span>
            </div>
            <ul class="configured-projects series-config-list">
              <li v-for="entry in builtinSeries" :key="entry.id">
                <div class="project-copy">
                  <div class="item-title">
                    <strong>{{ entry.definition.name }}</strong>
                    <span class="source-badge builtin">Series</span>
                    <span v-if="entry.overridden" class="source-badge overridden">已覆盖</span>
                  </div>
                  <code>{{ entry.id }}</code>
                  <span>
                    {{ entry.definition.profiles.length }} 个版本实例 · {{ entry.services.length }} 个服务
                  </span>
                </div>
                <div class="project-actions">
                  <button type="button" @click="exportConfiguration({ series: entry })">导出</button>
                  <button
                    type="button"
                    :disabled="!isSeriesMutable(entry)"
                    :title="isSeriesMutable(entry) ? '编辑模板、版本实例与覆盖项' : '该系列仍有服务在活动，请先停止'"
                    @click="startEditSeries(entry)"
                  >编辑系列</button>
                </div>
              </li>
            </ul>
          </section>

          <section class="config-section">
            <div class="section-heading">
              <h3>默认服务</h3>
              <span>{{ builtinServices.length }} 项</span>
            </div>
            <ul class="configured-projects">
              <li v-for="entry in builtinServices" :key="entry.id" :class="{ removed: entry.removed }">
                <div class="project-copy">
                  <div class="item-title">
                    <strong>{{ entry.definition?.name ?? entry.baseline.name }}</strong>
                    <span class="source-badge builtin">默认</span>
                    <span v-if="entry.overridden" class="source-badge overridden">已覆盖</span>
                    <span v-if="entry.removed" class="source-badge removed-badge">已隐藏</span>
                  </div>
                  <code>{{ entry.id }}</code>
                  <span v-if="entry.removed">当前不显示在服务总览；可随时显示</span>
                  <span v-else :title="entry.definition?.cwd">
                    {{ entry.definition?.moduleName }} · {{ entry.definition?.command.executable }}
                    {{ entry.definition?.command.args.join(' ') }}
                  </span>
                </div>
                <div v-if="deletingServiceId !== entry.id" class="project-actions">
                  <button type="button" @click="exportConfiguration({ service: entry })">导出</button>
                  <button
                    v-if="entry.removed"
                    type="button"
                    class="restore"
                    :disabled="saving"
                    @click="restoreBuiltinService(entry)"
                  >显示</button>
                  <button
                    v-if="!entry.removed"
                    type="button"
                    :disabled="!isServiceMutable(entry.id)"
                    :title="isServiceMutable(entry.id) ? '编辑本机覆盖' : '服务仍在活动，请先停止'"
                    @click="startEditService(entry)"
                  >编辑</button>
                  <button
                    v-if="!entry.removed"
                    type="button"
                    class="danger"
                    :disabled="!isServiceMutable(entry.id)"
                    :title="isServiceMutable(entry.id) ? '从服务总览隐藏，可随时显示' : '服务仍在活动，请先停止'"
                    @click="deletingServiceId = entry.id"
                  >
                    隐藏
                  </button>
                </div>
                <div v-else class="delete-confirm">
                  <span>只从服务总览隐藏，配置仍保留并可随时显示。确定？</span>
                  <button type="button" @click="deletingServiceId = ''">取消</button>
                  <button type="button" class="danger" :disabled="saving" @click="deleteBuiltinService(entry)">
                    确定隐藏
                  </button>
                </div>
              </li>
            </ul>
          </section>

          <section class="config-section">
            <div class="section-heading">
              <h3>User 项目</h3>
              <span>{{ projects.length }} 项</span>
            </div>
            <p v-if="projects.length === 0" class="empty-projects">
              还没有 User 项目，可从 Hub 同级目录或其他本地目录添加。
            </p>
            <ul v-else class="configured-projects">
              <li v-for="project in projects" :key="project.id">
                <div class="project-copy">
                  <div class="item-title">
                    <strong>{{ project.name }}</strong>
                    <span class="source-badge user">User</span>
                  </div>
                  <code :title="project.directory">{{ project.directory }}</code>
                  <span>{{ project.packageManager }} · {{ project.script }}</span>
                </div>
                <div v-if="deletingProjectId !== project.id" class="project-actions">
                  <button type="button" @click="exportConfiguration({ project })">导出</button>
                  <button
                    type="button"
                    :disabled="!isServiceMutable(project.serviceId)"
                    :title="isServiceMutable(project.serviceId) ? '编辑 User 项目' : '项目仍在活动，请先停止'"
                    @click="startEdit(project)"
                  >编辑</button>
                  <button
                    type="button"
                    class="danger"
                    :disabled="!isServiceMutable(project.serviceId)"
                    :title="isServiceMutable(project.serviceId) ? '只移出 Hub，不删除目录' : '项目仍在活动，请先停止'"
                    @click="deletingProjectId = project.id"
                  >移除</button>
                </div>
                <div v-else class="delete-confirm">
                  <span>只移出 Hub，不删除目录。确定？</span>
                  <button type="button" @click="deletingProjectId = ''">取消</button>
                  <button type="button" class="danger" :disabled="saving" @click="deleteProject(project)">确定移除</button>
                </div>
              </li>
            </ul>
          </section>
        </template>

        <p class="privacy-note">
          “默认”来自 <code>config/services.user.json</code> 用户基线，本机覆盖保存在 <code>.runtime/services.json</code>；“User”保存在
          <code>.runtime/projects.json</code>。运行中的默认服务必须先停止，才能编辑、隐藏或重置。
        </p>
      </div>

      <div v-else-if="view === 'form'" class="dialog-content editor-view project-editor">
        <label v-if="!editingProjectId">
          <span>Hub 同级项目</span>
          <select
            :value="selectedDirectory"
            :disabled="loading || availableCandidates.length === 0"
            @change="selectDiscovered(($event.target as HTMLSelectElement).value)"
          >
            <option v-if="availableCandidates.length === 0" value="">没有发现尚未配置的 Node.js 项目</option>
            <option v-for="item in availableCandidates" :key="item.directory" :value="item.directory">
              {{ item.name }}
            </option>
          </select>
        </label>

        <div v-if="!editingProjectId" class="divider"><span>或检查其他本地目录</span></div>

        <label>
          <span>项目目录</span>
          <div class="directory-row">
            <input
              v-model="manualDirectory"
              type="text"
              :placeholder="catalog?.defaultRoot ?? '本机绝对路径'"
              @keydown.enter.prevent="inspectManual"
            >
            <button type="button" :disabled="loading || !manualDirectory.trim()" @click="inspectManual">
              {{ loading ? '检查中…' : '检查' }}
            </button>
          </div>
        </label>

        <div v-if="candidate" class="project-summary">
          <strong>{{ candidate.name }}</strong>
          <code>{{ candidate.directory }}</code>
          <span>包管理器：{{ candidate.packageManager }}</span>
        </div>

        <label>
          <span>显示名称</span>
          <input v-model="displayName" type="text" maxlength="120" :disabled="!candidate">
        </label>

        <label>
          <span>启动脚本</span>
          <select v-model="script" :disabled="!candidate">
            <option v-for="item in candidate?.scripts ?? []" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>

        <p class="privacy-note">
          后端会重新读取 <code>package.json</code> 并生成固定命令；页面不能提交 executable、参数或环境变量。
          修改运行中的项目会被拒绝。
        </p>
      </div>

      <div v-else-if="view === 'service' || view === 'series'" class="dialog-content editor-view service-editor">
        <nav class="editor-tabs" aria-label="配置编辑方式">
          <button
            v-for="tab in ([['form', '表单'], ['json', 'JSON'], ['effective', '最终配置']] as const)"
            :key="tab[0]"
            type="button"
            :class="{ active: editorTab === tab[0] }"
            @click="switchEditorTab(tab[0])"
          >{{ tab[1] }}</button>
        </nav>

        <template v-if="editorTab === 'form' && view === 'service'">
          <p class="privacy-note">
            普通字段可直接编辑；端点、环境变量和身份探测请切换到 JSON。服务 <code>id</code> 不可修改。
          </p>
          <div class="form-grid">
            <label><span>服务名称</span><input v-model="serviceFormName" type="text"></label>
            <label><span>工作目录</span><input v-model="serviceFormCwd" type="text"></label>
            <label class="full"><span>说明</span><input v-model="serviceFormDescription" type="text"></label>
            <label><span>启动程序</span><input v-model="serviceFormExecutable" type="text"></label>
            <label class="full">
              <span>启动参数（每行一个参数）</span>
              <textarea v-model="serviceFormArgs" rows="6" spellcheck="false"></textarea>
            </label>
          </div>
        </template>

        <template v-else-if="editorTab === 'form' && view === 'series'">
          <label><span>产品系列名称</span><input v-model="seriesFormName" type="text"></label>
          <div class="profile-form-list">
            <article v-for="(profile, profileIndex) in seriesDraft?.profiles ?? []" :key="profile.id">
              <header>
                <div><strong>{{ profile.name }}</strong><code>{{ profile.id }}</code></div>
                <div class="profile-form-actions">
                  <button type="button" @click="cloneSeriesProfile(profileIndex)">复制为新版本</button>
                  <button
                    type="button"
                    class="danger"
                    :disabled="(seriesDraft?.profiles.length ?? 0) <= 1"
                    @click="removeSeriesProfile(profileIndex)"
                  >移除版本</button>
                </div>
              </header>
              <div class="form-grid">
                <label>
                  <span>版本名称</span>
                  <input :value="profile.name" type="text" @input="updateSeriesProfile(profileIndex, 'name', ($event.target as HTMLInputElement).value)">
                </label>
                <label>
                  <span>运行槽（留空继承）</span>
                  <input :value="profile.runtimeSlot ?? ''" type="text" @input="updateSeriesProfile(profileIndex, 'runtimeSlot', ($event.target as HTMLInputElement).value)">
                </label>
                <label>
                  <span>Wing 版本</span>
                  <input :value="profile.metadata?.wingVersion ?? ''" type="text" @input="updateSeriesProfile(profileIndex, 'wingVersion', ($event.target as HTMLInputElement).value)">
                </label>
                <div class="profile-services-summary">
                  {{ Object.keys(profile.services).length }} 个服务覆盖；目录、script 与端点可在单服务表单或 JSON 中调整。
                </div>
              </div>
            </article>
          </div>
          <p class="privacy-note">
            只有一个版本实例时，服务总览会自动隐藏 Profile 中间层。复制第二个版本后才显示完整二级树。
          </p>
        </template>

        <template v-else-if="editorTab === 'json'">
          <div class="json-toolbar">
            <span>{{ view === 'series' ? '编辑模板、Profile 与服务覆盖项' : '编辑完整服务定义' }}</span>
            <button type="button" @click="formatEditorJson">格式化 JSON</button>
          </div>
          <textarea
            v-if="view === 'series'"
            v-model="seriesJson"
            class="json-editor"
            rows="22"
            spellcheck="false"
            @input="editorError = ''"
          ></textarea>
          <textarea
            v-else
            v-model="serviceJson"
            class="json-editor"
            rows="22"
            spellcheck="false"
            @input="editorError = ''"
          ></textarea>
          <p v-if="editorError" class="editor-error" role="alert">{{ editorError }}</p>
        </template>

        <template v-else>
          <p class="privacy-note">只读展示保存后将解析得到的有效配置；最终配置不能直接编辑。</p>
          <pre class="effective-json">{{ effectiveEditorJson }}</pre>
        </template>

        <p class="privacy-note warning-note">
          保存后仍由后端校验工作目录、固定端口、本机 URL、稳定 ID、命令与环境变量；不允许 shell executable。
        </p>
      </div>

      <div v-else class="dialog-content editor-view import-view">
        <label class="file-picker">
          <span>选择 JSON 文件</span>
          <input type="file" accept="application/json,.json" @change="selectImportFile">
        </label>
        <div v-if="importDocument" class="import-summary">
          <strong>{{ importFileName }}</strong>
          <span v-if="importDocument.format === 'phoenix-dev-hub-config'">
            {{ importDocument.version === 2 ? importDocument.series.length : importDocument.services.length }} 个配置分组、{{ importDocument.projects.length }} 个 User 项目待校验
          </span>
          <span v-else>{{ importDocument.projects.length }} 个 User 项目待校验</span>
        </div>
        <p class="privacy-note warning-note">
          导入采用合并模式：默认服务按稳定 ID 覆盖；User 项目按真实目录更新或新增；不会删除未包含的配置。
          JSON 可能包含本机绝对路径，换机器后请先编辑路径。全部内容都会由后端重新验证。
        </p>
      </div>

    </section>
  </div>
</template>

<style scoped>
.dialog-backdrop { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(15, 23, 42, .42); backdrop-filter: blur(2px); }
.settings-view { width: 100%; height: 100%; min-height: 0; padding: 0; box-sizing: border-box; overflow: hidden; background: var(--pnw-workbench-bg, var(--pnw-workbench-default-bg, #f8fafc)); }
.project-dialog { width: min(760px, 100%); max-height: min(820px, calc(100vh - 48px)); --pdh-header-control-height: calc(var(--pnw-workbench-view-header-height, 40px) - 8px); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 14px; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); box-shadow: 0 24px 80px rgba(15, 23, 42, .28); }
.project-dialog.embedded { width: 100%; height: 100%; max-height: none; min-height: 0; margin: 0; border: 0; border-radius: 0; box-shadow: none; }
.project-dialog.embedded.subview { width: 100%; height: 100%; max-height: none; min-height: 0; border: 0; border-radius: 0; box-shadow: none; }
.profile-form-list article > header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.page-intro { flex: 0 0 auto; margin: 0; padding: 10px 18px 0; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 11px; line-height: 1.5; }
:deep(.pnw-head-actions > button) { min-height: var(--pdh-header-control-height); }
h2 { margin: 0; font-size: 18px; }
.dialog-content { min-height: 0; flex: 1 1 auto; display: grid; gap: 14px; overflow-y: auto; padding: 18px; box-sizing: border-box; }
.dialog-content.editor-view { width: min(1040px, calc(100% - 32px)); margin: 0 auto; padding: 20px 0 36px; }
.project-dialog:not(.embedded) .dialog-content.editor-view { width: 100%; margin: 0; padding: 18px; }
.project-list-view, .import-view, .service-editor { align-content: start; }
.editor-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); }
.editor-tabs button { min-height: 32px; padding: 0 13px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); cursor: pointer; }
.editor-tabs button.active { border-bottom-color: var(--pnw-focus-ring, #2563eb); color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); font-weight: 800; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.form-grid .full { grid-column: 1 / -1; }
.json-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; }
.json-toolbar button { min-height: 28px; padding: 0 9px; cursor: pointer; }
.json-editor, .effective-json { min-height: 330px; tab-size: 2; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.55; }
.json-editor { resize: vertical; }
.effective-json { overflow: auto; margin: 0; padding: 12px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 7px; background: var(--pnw-workbench-bg, var(--pnw-workbench-default-bg, rgba(148, 163, 184, .08))); white-space: pre; }
.editor-error { margin: -8px 0 0; color: #ef4444; font-size: 10px; }
.profile-form-list { display: grid; gap: 10px; }
.profile-form-list article { overflow: hidden; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 8px; }
.profile-form-list article > header { padding: 9px 11px; background: var(--pnw-workbench-bg, var(--pnw-workbench-default-bg, rgba(148, 163, 184, .08))); }
.profile-form-list article > header div:first-child { display: flex; align-items: center; gap: 8px; }
.profile-form-list article > .form-grid { padding: 12px; }
.profile-form-actions { display: flex; gap: 6px; }
.profile-form-actions button { min-height: 27px; padding: 0 8px; cursor: pointer; }
.profile-services-summary { align-self: end; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; }
.series-config-list li { background: color-mix(in srgb, var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)) 94%, #2563eb 6%); }
label { display: grid; gap: 6px; font-size: 11px; font-weight: 700; }
input, select, textarea, button { min-height: 34px; box-sizing: border-box; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #cbd5e1)); border-radius: 7px; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); color: inherit; font: inherit; }
input, select, textarea { width: 100%; padding: 7px 9px; }
textarea { resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; tab-size: 2; }
button { padding: 6px 12px; cursor: pointer; }
button:hover:not(:disabled) { background: var(--pnw-control-hover-bg, var(--pnw-workbench-default-hover-bg, rgba(59, 130, 246, .08))); }
button:disabled { cursor: not-allowed; opacity: .48; }
button.primary { border-color: #2563eb; background: #2563eb; color: #fff; }
button.danger { border-color: rgba(239, 68, 68, .42); color: #ef4444; }
button.restore { border-color: rgba(34, 197, 94, .4); color: #22c55e; }
.management-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.management-toolbar .compact { min-height: 30px; padding: 4px 10px; }
.directory-row { display: grid; grid-template-columns: 1fr auto; gap: 7px; }
.divider { display: flex; align-items: center; gap: 10px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; }
.divider::before, .divider::after { content: ""; height: 1px; flex: 1; background: var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); }
.project-summary, .import-summary { display: grid; gap: 5px; padding: 11px; border-radius: 8px; background: var(--pnw-workbench-bg, var(--pnw-workbench-default-bg, rgba(148, 163, 184, .1))); font-size: 11px; }
.project-summary code { overflow: hidden; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); text-overflow: ellipsis; }
.notice { margin: 0; padding: 8px 10px; border-radius: 7px; background: rgba(22, 163, 74, .1); color: #16a34a; font-size: 11px; }
.empty-projects { min-height: 80px; display: grid; place-items: center; margin: 0; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
.config-section { display: grid; gap: 8px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
.section-heading h3 { margin: 0; color: inherit; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
.section-heading span { font-size: 10px; }
.configured-projects { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.configured-projects li { display: flex; align-items: center; gap: 12px; padding: 10px 11px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 9px; background: var(--pnw-workbench-bg, var(--pnw-workbench-default-bg, rgba(148, 163, 184, .05))); }
.configured-projects li.removed { opacity: .7; }
.project-copy { min-width: 0; flex: 1; display: grid; gap: 3px; }
.item-title { min-width: 0; display: flex; align-items: center; gap: 6px; }
.item-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-badge { flex: 0 0 auto; padding: 1px 5px; border-radius: 999px; font-size: 8px; font-weight: 800; letter-spacing: .03em; }
.source-badge.builtin { background: rgba(59, 130, 246, .13); color: #60a5fa; }
.source-badge.user { background: rgba(16, 185, 129, .13); color: #34d399; }
.source-badge.overridden { background: rgba(245, 158, 11, .13); color: #f59e0b; }
.source-badge.removed-badge { background: rgba(239, 68, 68, .12); color: #ef4444; }
.project-copy code { overflow: hidden; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.project-copy span { color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; }
.project-actions, .delete-confirm { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
.delete-confirm span { max-width: 190px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; }
.reset-confirm { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border: 1px solid rgba(245, 158, 11, .3); border-radius: 8px; background: rgba(245, 158, 11, .07); }
.reset-confirm span { min-width: 0; flex: 1; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; }
.privacy-note { margin: 0; padding: 10px 11px; border-left: 3px solid #2563eb; background: rgba(37, 99, 235, .07); color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; line-height: 1.55; }
.warning-note { border-left-color: #f59e0b; background: rgba(245, 158, 11, .08); }
.file-picker { padding: 18px; border: 1px dashed var(--pnw-workbench-border, var(--pnw-workbench-default-border, #cbd5e1)); border-radius: 9px; text-align: center; }
.file-picker input { padding: 7px; }
@media (max-width: 620px) { .dialog-content.editor-view { width: calc(100% - 20px); padding-top: 12px; } .configured-projects li, .delete-confirm, .reset-confirm { align-items: stretch; flex-direction: column; } .project-actions { align-self: flex-end; } }
</style>
