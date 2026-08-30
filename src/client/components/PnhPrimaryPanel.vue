<script setup lang="ts">
import PnwPrimaryPanel from "phoenix-wing/layout/PnwPrimaryPanel.vue";
import PnwPrimarySection from "phoenix-wing/layout/PnwPrimarySection.vue";
import type { ServiceRuntimeStatus } from "@shared/contracts";
import PnhPropertiesPanel from "./PnhPropertiesPanel.vue";

defineOptions({ name: "PnhPrimaryPanel" });
withDefaults(defineProps<{
  title?: string;
  services: readonly ServiceRuntimeStatus[];
  activeModule: string;
  selectedService?: ServiceRuntimeStatus;
}>(), {
  title: "服务进程",
});

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
  <PnwPrimaryPanel class="primary-panel" :title="title" :aria-label="`${title}导航与属性`">
    <template #summary>{{ services.length }} 个服务</template>

    <PnwPrimarySection title="网站模块">
      <template #suffix>{{ websiteModules(services).length }}</template>
      <div class="section-body module-list">
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
    </PnwPrimarySection>

    <PnwPrimarySection title="Properties">
      <div class="section-body">
        <PnhPropertiesPanel :service="selectedService" :show-title="false" />
      </div>
    </PnwPrimarySection>

    <PnwPrimarySection title="运行摘要">
      <div class="section-body">
        <dl>
          <div><dt>Hub 管理</dt><dd>{{ services.filter((item) => item.managed).length }}</dd></div>
          <div><dt>外部监控</dt><dd>{{ services.filter((item) => item.ownership === 'external').length }}</dd></div>
          <div><dt>部分/异常</dt><dd>{{ services.filter((item) => item.health === 'partial' || item.lifecycle === 'conflict').length }}</dd></div>
        </dl>
      </div>
    </PnwPrimarySection>
  </PnwPrimaryPanel>
</template>

<style scoped>
.primary-panel { width: 100%; height: 100%; }
.section-body { padding: 4px 5px; }
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
