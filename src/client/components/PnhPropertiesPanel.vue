<script setup lang="ts">
import type { ServiceRuntimeStatus } from "@shared/contracts";
import {
  pnhPresentedEndpoint,
  pnhPresentedHealth,
} from "../PnhServiceHealthPresentation";

defineOptions({ name: "PnhPropertiesPanel" });
withDefaults(defineProps<{
  service?: ServiceRuntimeStatus;
  showTitle?: boolean;
}>(), {
  showTitle: true,
});

const ownershipLabels: Readonly<Record<ServiceRuntimeStatus["ownership"], string>> = {
  hub: "Hub 管理",
  external: "外部监控",
  none: "未运行",
  conflict: "身份冲突",
};
const lifecycleLabels: Readonly<Record<ServiceRuntimeStatus["lifecycle"], string>> = {
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  external: "外部监控",
  conflict: "端口冲突",
};
const buildLabels: Readonly<Record<ServiceRuntimeStatus["build"]["state"], string>> = {
  unknown: "未报告",
  building: "构建中",
  ready: "构建通过",
  failed: "构建失败",
};
const environmentLabels = {
  development: "开发联调",
  "release-validation": "发布验收（非正式）",
  preproduction: "预生产",
  production: "生产（只读）",
} as const;

</script>

<template>
  <section class="properties-panel">
    <template v-if="service">
      <p v-if="showTitle" class="panel-label">Properties</p>
      <h2>{{ service.definition.name }}</h2>
      <p class="description">{{ service.definition.description }}</p>
      <dl>
        <div><dt>ID</dt><dd>{{ service.definition.id }}</dd></div>
        <div><dt>网站模块</dt><dd>{{ service.definition.moduleName }}</dd></div>
        <div><dt>来源</dt><dd>{{ ownershipLabels[service.ownership] }}</dd></div>
        <div><dt>生命周期</dt><dd>{{ lifecycleLabels[service.lifecycle] }}</dd></div>
        <div><dt>健康度</dt><dd>{{ pnhPresentedHealth(service).label }}</dd></div>
        <div v-if="service.definition.profilePolicy"><dt>环境</dt><dd>{{ environmentLabels[service.definition.profilePolicy.environmentKind] }}</dd></div>
        <div v-if="service.profileEvidence"><dt>装配</dt><dd>{{ service.profileEvidence.deploymentMode }} / {{ service.profileEvidence.state }}</dd></div>
        <div v-if="service.profileEvidence"><dt>数据库</dt><dd>{{ service.profileEvidence.databaseName }}<template v-if="service.profileEvidence.database"> · {{ service.profileEvidence.database.state }}</template></dd></div>
        <div v-if="service.profileEvidence?.database?.missingRelations?.length"><dt>缺少基线</dt><dd>{{ service.profileEvidence.database.missingRelations.join('、') }}</dd></div>
        <div v-if="service.profileEvidence?.database?.requiredRelationsStatus"><dt>关系清单</dt><dd>{{ service.profileEvidence.database.requiredRelationsStatus }}</dd></div>
        <div v-if="service.profileEvidence?.wingVersion"><dt>Wing</dt><dd>{{ service.profileEvidence.wingSource }} {{ service.profileEvidence.wingVersion }}</dd></div>
        <div v-if="service.definition.profileMetadata?.sourceBaseline" class="wide"><dt>源码基线</dt><dd>{{ service.definition.profileMetadata.sourceBaseline }}</dd></div>
        <div v-if="service.definition.profileMetadata?.testGuide" class="wide"><dt>联调帮助</dt><dd class="test-guide">{{ service.definition.profileMetadata.testGuide }}</dd></div>
        <div><dt>当前构建</dt><dd>{{ buildLabels[service.build.state] }}</dd></div>
        <div><dt>PID</dt><dd>{{ service.pid ?? (service.externalProcesses.map((item) => item.pid).join(', ') || '—') }}</dd></div>
        <div><dt>PGID</dt><dd>{{ service.processGroupId ?? (service.externalProcesses.map((item) => item.processGroupId).join(', ') || '—') }}</dd></div>
        <div><dt>日志</dt><dd>{{ service.logSource === 'captured' ? 'Hub 捕获' : service.logSource === 'recovered-ownership' ? '恢复归属；日志不可用' : '仅健康监控' }}</dd></div>
        <div class="wide"><dt>工作目录</dt><dd>{{ service.definition.cwd }}</dd></div>
        <div class="wide"><dt>受控命令</dt><dd>{{ service.definition.command.executable }} {{ service.definition.command.args.join(' ') }}</dd></div>
      </dl>
      <p class="panel-label endpoints-label">Endpoints</p>
      <ul>
        <li v-for="endpoint in service.endpoints" :key="endpoint.id">
          <span>{{ endpoint.label }}</span>
          <code>127.0.0.1:{{ endpoint.port }}</code>
          <b :class="{ ok: pnhPresentedEndpoint(service, endpoint).state === 'healthy', listen: ['reachable-unverified', 'checking'].includes(pnhPresentedEndpoint(service, endpoint).state), bad: pnhPresentedEndpoint(service, endpoint).state === 'unhealthy' }">{{ pnhPresentedEndpoint(service, endpoint).label }}</b>
          <small>{{ endpoint.probeMessage }}</small>
        </li>
      </ul>
    </template>
    <p v-else class="no-selection">选择一个服务查看属性。</p>
  </section>
</template>

<style scoped>
.properties-panel { padding: 15px; overflow-wrap: anywhere; }
.panel-label { margin: 2px 0 8px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
h2 { margin: 0 0 5px; font-size: 16px; }
.description { margin: 0 0 17px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 11px; line-height: 1.5; }
dl { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
dl div { min-width: 0; }
dl div.wide { grid-column: 1 / -1; }
dt { margin-bottom: 3px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 9px; text-transform: uppercase; letter-spacing: .06em; }
dd { margin: 0; font-size: 11px; font-weight: 650; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
dd.test-guide { font-family: inherit; font-weight: 500; line-height: 1.55; }
.endpoints-label { margin-top: 20px; }
ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
li { display: grid; grid-template-columns: 1fr auto; gap: 3px 8px; padding: 8px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, transparent)); border-radius: 7px; background: var(--pnw-workbench-bg, var(--pnw-workbench-default-bg, rgba(148, 163, 184, .08))); }
li span { font-size: 11px; font-weight: 700; }
li code { grid-column: 1; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; }
li small { grid-column: 1 / -1; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 9px; }
li b { grid-column: 2; grid-row: 1 / 3; align-self: center; color: #94a3b8; font-size: 9px; }
li b.ok { color: #16a34a; }
li b.listen { color: #2563eb; }
li b.bad { color: #dc2626; }
.no-selection { display: grid; place-items: center; min-height: 72px; margin: 0; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 12px; }
</style>
