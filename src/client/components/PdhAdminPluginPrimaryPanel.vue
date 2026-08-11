<script setup lang="ts">
import { computed, ref } from "vue";
import PnwPrimaryPanel from "phoenix-wing/layout/PnwPrimaryPanel.vue";
import PnwPrimarySection from "phoenix-wing/layout/PnwPrimarySection.vue";
import type { AdminPluginCandidate, AdminPluginStatus } from "@shared/contracts";
import { ApiError, devHubApi } from "../api";

defineOptions({ name: "PdhAdminPluginPrimaryPanel" });
const props = defineProps<{
  plugins: readonly AdminPluginStatus[];
  selectedId: string;
}>();
const emit = defineEmits<{
  select: [pluginId: string];
  changed: [pluginId?: string];
  error: [error: unknown];
}>();

const search = ref("");
const adding = ref(false);
const directory = ref("");
const candidate = ref<AdminPluginCandidate>();
const busy = ref(false);
const filtered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase("zh-CN");
  if (!query) return props.plugins;
  return props.plugins.filter((plugin) => [
    plugin.identity.name,
    plugin.identity.moduleId,
    plugin.identity.version,
    plugin.registration.productRoot,
  ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(query)));
});

function stateLabel(state: AdminPluginStatus["mountState"]): string {
  return ({ mounted: "已挂载", unmounted: "未挂载", partial: "不完整", conflict: "冲突", unavailable: "源不可用" })[state];
}

async function inspect(): Promise<void> {
  if (!directory.value.trim() || busy.value) return;
  busy.value = true;
  candidate.value = undefined;
  try {
    candidate.value = await devHubApi.inspectAdminPlugin(directory.value.trim());
  } catch (error) {
    emit("error", error);
  } finally {
    busy.value = false;
  }
}

async function add(): Promise<void> {
  if (!candidate.value || busy.value) return;
  busy.value = true;
  try {
    const added = await devHubApi.addAdminPlugin(directory.value.trim());
    adding.value = false;
    directory.value = "";
    candidate.value = undefined;
    emit("changed", added.registration.id);
  } catch (error) {
    emit("error", error instanceof ApiError ? error : new Error(String(error)));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PnwPrimaryPanel class="plugin-primary" title="Admin 插件" aria-label="Admin 插件导航与操作">
    <template #suffix><span class="primary-count">{{ plugins.length }}</span></template>
    <template #actions>
      <button type="button" class="primary-add" title="选择本机目录加入" aria-label="选择本机目录加入" @click="adding = !adding">＋</button>
    </template>

    <PnwPrimarySection v-if="adding" title="加入插件" :collapsible="false">
      <div class="plugin-section">
        <div class="add-card">
          <label>
            <span>产品或 admin-plugin 目录</span>
            <input v-model="directory" type="text" placeholder="/本机/项目目录" @keyup.enter="inspect">
          </label>
          <div class="add-actions">
            <button type="button" :disabled="busy || !directory.trim()" @click="inspect">检查目录</button>
            <button type="button" class="primary" :disabled="busy || !candidate || candidate.configured" @click="add">加入</button>
          </div>
          <div v-if="candidate" class="candidate">
            <strong>{{ candidate.manifest.name }}</strong>
            <span>{{ candidate.manifest.moduleId }} · {{ candidate.manifest.version }}</span>
            <small>{{ candidate.configured ? "已经加入列表" : candidate.mountAllowed ? "Manifest v2 与 Vue/Node 入口有效" : "已识别；有策略警告，加入后暂不可挂载" }}</small>
            <small v-for="warning in candidate.validationWarnings" :key="warning" class="warning">{{ warning }}</small>
          </div>
        </div>
      </div>
    </PnwPrimarySection>

    <PnwPrimarySection title="插件列表" :collapsible="false">
      <div class="plugin-section plugin-list-section">
        <div class="search"><span>⌕</span><input v-model="search" type="search" placeholder="搜索插件、版本或目录"></div>
        <div class="plugin-list">
          <button
            v-for="plugin in filtered"
            :key="plugin.registration.id"
            type="button"
            :class="{ active: plugin.registration.id === selectedId }"
            @click="emit('select', plugin.registration.id)"
          >
            <span class="plugin-name">{{ plugin.identity.name }}</span>
            <span class="plugin-meta">{{ plugin.identity.version || '版本未知' }}</span>
            <span class="plugin-state" :data-state="plugin.mountState">{{ stateLabel(plugin.mountState) }}</span>
          </button>
          <div v-if="filtered.length === 0" class="empty-list">
            {{ plugins.length ? "没有匹配的插件" : "尚未加入 Admin 插件" }}
          </div>
        </div>
      </div>
    </PnwPrimarySection>

    <PnwPrimarySection title="开发组合说明">
      <p class="hint">Issue、Function、BOM 等插件可来自不同本机目录。插件本身不启动；挂载完成后统一启动 Admin Host。</p>
    </PnwPrimarySection>
  </PnwPrimaryPanel>
</template>

<style scoped>
.plugin-primary { width: 100%; height: 100%; color: var(--pnw-workbench-text, #dbeafe); }
.primary-count { min-width: 20px; display: inline-block; padding: 1px 5px; border-radius: 999px; background: rgba(148,163,184,.14); color: var(--pnw-workbench-muted, #94a3b8); font-size: 10px; text-align: center; }
.plugin-section { padding: 8px; }
.plugin-list-section { display: grid; gap: 8px; }
button { border: 1px solid var(--pnw-workbench-border, #2b3b50); background: transparent; color: inherit; cursor: pointer; }
button:hover { background: var(--pnw-control-hover-bg, rgba(59,130,246,.09)); }
button:disabled { cursor: not-allowed; opacity: .45; }
.primary-add { width: 28px; height: 26px; padding: 0; border-radius: 6px; font-size: 18px; line-height: 1; }
.add-card { display: grid; gap: 7px; padding: 9px; border: 1px solid var(--pnw-workbench-border, #2b3b50); border-radius: 8px; background: var(--pnw-workbench-surface, rgba(15,23,42,.5)); }
label { display: grid; gap: 4px; }
label span { color: var(--pnw-workbench-muted, #94a3b8); font-size: 10px; }
input { min-width: 0; box-sizing: border-box; border: 1px solid var(--pnw-workbench-border, #334155); border-radius: 6px; padding: 7px 8px; background: var(--pnw-input-bg, rgba(15,23,42,.4)); color: inherit; outline: none; }
input:focus { border-color: #3b82f6; }
.add-actions { display: flex; gap: 6px; }
.add-actions button { flex: 1; border-radius: 6px; padding: 6px; font-size: 10px; }
.add-actions .primary { border-color: #2563eb; background: #2563eb; color: #fff; }
.candidate { display: grid; gap: 2px; min-width: 0; padding-top: 2px; }
.candidate strong, .candidate span, .candidate small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.candidate strong { font-size: 11px; }.candidate span,.candidate small { color: var(--pnw-workbench-muted, #94a3b8); font-size: 9px; }
.candidate .warning { color: #f59e0b; white-space: normal; }
.search { display: flex; align-items: center; gap: 5px; padding: 0 2px; }.search input { width: 100%; border-radius: 5px; padding: 6px; font-size: 10px; }.search span { color: var(--pnw-workbench-muted, #94a3b8); }
.plugin-list { max-height: min(48vh, 420px); min-height: 80px; overflow-y: auto; scrollbar-width: thin; }
.plugin-list > button { position: relative; width: 100%; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 2px 7px; margin-bottom: 3px; padding: 8px 9px; border-color: transparent; border-radius: 6px; text-align: left; }
.plugin-list > button.active { border-color: rgba(59,130,246,.35); background: var(--pnw-control-active-bg, rgba(37,99,235,.15)); }
.plugin-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 750; }.plugin-meta { color: var(--pnw-workbench-muted, #94a3b8); font-family: ui-monospace,monospace; font-size: 9px; }
.plugin-state { grid-column: 1 / -1; justify-self: start; padding: 1px 5px; border-radius: 999px; background: rgba(148,163,184,.12); color: var(--pnw-workbench-muted, #94a3b8); font-size: 9px; }.plugin-state[data-state="mounted"] { background: rgba(34,197,94,.12); color: #22c55e; }.plugin-state[data-state="partial"],.plugin-state[data-state="conflict"],.plugin-state[data-state="unavailable"] { background: rgba(245,158,11,.13); color: #f59e0b; }
.empty-list { padding: 20px 8px; color: var(--pnw-workbench-muted, #94a3b8); font-size: 10px; text-align: center; }
.hint { margin: 0; padding: 9px 10px; color: var(--pnw-workbench-muted, #94a3b8); font-size: 9px; line-height: 1.55; }
</style>
