<script setup lang="ts">
import type { ServiceRuntimeStatus } from "@shared/contracts";
import PdhPropertiesPanel from "./PdhPropertiesPanel.vue";

defineOptions({ name: "PdhPrimaryPanel" });
defineProps<{
  services: readonly ServiceRuntimeStatus[];
  activeModule: string;
  selectedService?: ServiceRuntimeStatus;
}>();

const emit = defineEmits<{
  filter: [moduleId: string];
}>();

function websiteModules(services: readonly ServiceRuntimeStatus[]) {
  const modules = new Map<string, { name: string; serviceCount: number }>();
  for (const service of services) {
    const current = modules.get(service.definition.moduleId);
    modules.set(service.definition.moduleId, {
      name: service.definition.moduleName,
      serviceCount: (current?.serviceCount ?? 0) + 1,
    });
  }
  return [...modules.entries()];
}
</script>

<template>
  <aside class="primary-panel">
    <details class="primary-block" open>
      <summary class="block-title">
        <span>网站模块</span><i aria-hidden="true">›</i>
      </summary>
      <div class="block-body module-list">
        <button :class="{ active: activeModule === 'all' }" @click="emit('filter', 'all')">
          <span>全部网站</span><b>{{ websiteModules(services).length }}</b>
        </button>
        <button
          v-for="[moduleId, module] in websiteModules(services)"
          :key="moduleId"
          :class="{ active: activeModule === moduleId }"
          @click="emit('filter', moduleId)"
        >
          <span>{{ module.name }}</span><b>{{ module.serviceCount }}</b>
        </button>
      </div>
    </details>

    <details class="primary-block" open>
      <summary class="block-title">
        <span>Properties</span><i aria-hidden="true">›</i>
      </summary>
      <div class="block-body">
        <PdhPropertiesPanel :service="selectedService" :show-title="false" />
      </div>
    </details>

    <details class="primary-block" open>
      <summary class="block-title">
        <span>运行摘要</span><i aria-hidden="true">›</i>
      </summary>
      <div class="block-body">
        <dl>
          <div><dt>Dev Hub 管理</dt><dd>{{ services.filter((item) => item.managed).length }}</dd></div>
          <div><dt>外部监控</dt><dd>{{ services.filter((item) => item.ownership === 'external').length }}</dd></div>
          <div><dt>部分/异常</dt><dd>{{ services.filter((item) => item.health === 'partial' || item.lifecycle === 'conflict').length }}</dd></div>
        </dl>
      </div>
    </details>

  </aside>
</template>

<style scoped>
.primary-panel { height: 100%; padding: 8px 0 12px; box-sizing: border-box; overflow-y: auto; }
.primary-block { width: 100%; margin-inline: 0; }
.primary-block + .primary-block { margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); }
.block-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 12px; border-radius: 0; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); cursor: pointer; font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; list-style: none; user-select: none; }
.block-title::-webkit-details-marker { display: none; }
.block-title:hover { background: var(--pnw-control-hover-bg, var(--pnw-workbench-default-hover-bg, rgba(59, 130, 246, .07))); color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); }
.block-title:focus-visible { outline: 1px solid var(--pnw-focus-ring, var(--pnw-workbench-default-focus, #2563eb)); outline-offset: 1px; }
.block-title i { font-size: 17px; font-style: normal; font-weight: 500; line-height: 1; transform: rotate(0deg); transition: transform .14s ease; }
.primary-block[open] > .block-title i { transform: rotate(90deg); }
.block-body { padding: 4px 5px 0; }
.module-list { max-height: min(28vh, 230px); overflow-y: auto; scrollbar-width: thin; }
button { width: 100%; display: flex; justify-content: space-between; align-items: center; border: 0; border-radius: 7px; padding: 8px 9px; background: transparent; color: inherit; cursor: pointer; text-align: left; }
button:hover, button.active { background: var(--pnw-control-active-bg, var(--pnw-workbench-default-active-bg, rgba(37, 99, 235, .1))); color: var(--pnw-control-active-text, var(--pnw-workbench-default-active-text, #1d4ed8)); }
button b { min-width: 22px; padding: 2px 5px; border-radius: 999px; background: rgba(148, 163, 184, .15); font-size: 10px; text-align: center; }
:deep(.properties-panel) { padding: 5px 7px 0; }
dl { margin: 0; }
dl div { display: flex; justify-content: space-between; padding: 6px 7px; font-size: 11px; }
dt { color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
dd { margin: 0; font-weight: 800; }
</style>
