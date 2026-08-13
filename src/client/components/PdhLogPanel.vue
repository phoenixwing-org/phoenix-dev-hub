<script setup lang="ts">
import { ref } from "vue";
import type { LogEntry } from "@shared/contracts";
import { pdhDisplayLogText, pdhRuntimeLogClipboardText } from "../PdhRuntimeLogText";

defineOptions({ name: "PdhLogPanel" });
const props = defineProps<{
  entries: readonly LogEntry[];
  serviceName?: string;
  logTabCount: number;
  available?: boolean;
  retainedCount?: number;
  capacity?: number;
  totalWritten?: number;
  message?: string;
}>();
const copyFeedback = ref("");
const emit = defineEmits<{
  clear: [];
  close: [];
  closeAll: [];
}>();

async function copyLogs(): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(pdhRuntimeLogClipboardText(props.entries));
    copyFeedback.value = `已复制 ${props.entries.length} 条`;
  } catch {
    copyFeedback.value = "复制失败，请直接选择日志文本复制";
  }
}

function logTone(entry: LogEntry): "default" | "warning" | "error" {
  if (entry.stream !== "stderr") return "default";
  const text = pdhDisplayLogText(entry.text);
  if (/warning|deprecated|deprecation|browserslist|caniuse-lite|update-browserslist-db|trace-deprecation/i.test(text)) {
    return "warning";
  }
  return "error";
}
</script>

<template>
  <section class="log-panel">
    <div class="log-toolbar">
      <span>
        {{ serviceName ? `${serviceName} · 运行日志` : '未选择运行日志' }}
        <small v-if="serviceName && available">
          当前显示 {{ entries.length }} 条 · 服务端保留 {{ retainedCount ?? 0 }} / {{ capacity ?? 500 }} 条
          · 本代累计 {{ totalWritten ?? 0 }} 条
        </small>
        <small v-else-if="serviceName">仅健康监控</small>
      </span>
      <div v-if="serviceName" class="log-actions">
        <button type="button" :disabled="!entries.length" @click="copyLogs">复制当前日志</button>
        <button type="button" :disabled="!available" @click="emit('clear')">清空本次会话日志</button>
        <button type="button" @click="emit('close')">关闭日志</button>
        <button v-if="logTabCount > 1" type="button" @click="emit('closeAll')">关闭全部</button>
        <small role="status" aria-live="polite">{{ copyFeedback }}</small>
      </div>
    </div>
    <ol v-if="entries.length">
      <li
        v-for="entry in entries"
        :key="entry.sequence"
        :data-stream="entry.stream"
        :data-tone="logTone(entry)"
      >
        <time>{{ new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) }}</time>
        <b>{{ entry.stream }}</b>
        <span>{{ pdhDisplayLogText(entry.text) }}</span>
      </li>
    </ol>
    <p v-else class="empty-log">
      {{ message ?? '启动服务或选择“查看运行日志”后，这里会为每个服务保留一个日志 Tab。' }}
    </p>
  </section>
</template>

<style scoped>
.log-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
.log-toolbar { display: flex; justify-content: space-between; align-items: center; padding: 5px 9px; border-bottom: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
.log-toolbar > span { display: inline-flex; align-items: baseline; gap: 9px; }
.log-toolbar small { opacity: .82; font-size: 9px; }
.log-toolbar button { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.log-toolbar button:hover { color: var(--pnw-control-active-text, var(--pnw-workbench-default-active-text, #1d4ed8)); }
.log-toolbar button:disabled { opacity: .45; cursor: not-allowed; }
.log-actions { display: flex; align-items: center; gap: 10px; }
.log-actions small { min-width: 0; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
ol { flex: 1; overflow: auto; list-style: none; margin: 0; padding: 7px 9px; user-select: text; cursor: text; }
li { display: grid; grid-template-columns: 66px 48px minmax(0, 1fr); gap: 7px; white-space: pre-wrap; overflow-wrap: anywhere; }
li time { color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
li b { color: var(--pnw-control-active-text, var(--pnw-workbench-default-active-text, #1d4ed8)); font-weight: 600; }
li[data-stream="stderr"] b, li[data-stream="stderr"] span { color: #dc2626; }
li[data-tone="warning"] b, li[data-tone="warning"] span { color: #f59e0b; }
li[data-stream="system"] b { color: #7c3aed; }
.empty-log { margin: auto; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); }
</style>
