<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import {
  PnwOverlayThemeProvider,
  type PnwColorScheme,
} from "phoenix-wing";
import type { StopTargetDetails } from "@shared/contracts";
import { pnhProcessStopConfirmationText } from "../PnhProcessStopConfirmation";

const props = defineProps<{
  readonly details: StopTargetDetails;
  readonly force: boolean;
  readonly colorScheme: PnwColorScheme;
}>();

const emit = defineEmits<{
  cancel: [];
  confirm: [];
}>();

const cancelButton = ref<HTMLButtonElement>();
const copyFeedback = ref("");

onMounted(() => {
  void nextTick(() => cancelButton.value?.focus());
});

async function copyDetails(): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(pnhProcessStopConfirmationText(props.details, props.force));
    copyFeedback.value = "详情已复制";
  } catch {
    copyFeedback.value = "复制失败，请直接选择上方文本复制";
  }
}
</script>

<template>
  <Teleport to="body">
    <PnwOverlayThemeProvider :color-scheme="colorScheme">
      <div
        class="process-confirm-backdrop"
        role="presentation"
        @mousedown.self="emit('cancel')"
        @keydown.esc.stop.prevent="emit('cancel')"
      >
        <section
          class="process-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="process-confirm-title"
          aria-describedby="process-confirm-description"
        >
          <header>
          <div>
            <small>{{ force ? 'PROCESS FORCE STOP' : 'EXTERNAL PROCESS' }}</small>
            <h2 id="process-confirm-title">
              {{ force ? '确认强制终止？' : '确认关闭外部进程？' }}
            </h2>
          </div>
          <button type="button" class="icon-button" aria-label="取消并关闭" @click="emit('cancel')">×</button>
          </header>

          <div id="process-confirm-description" class="process-confirm-body">
          <p class="warning">
            {{ force
              ? '优雅停止已超时。强制终止可能丢失未保存数据。'
              : '该服务并非由当前 Hub 会话启动。确认前请核对下面的精确目标。' }}
          </p>

          <dl class="summary-grid">
            <div><dt>服务</dt><dd>{{ details.serviceId }}</dd></div>
            <div><dt>端口</dt><dd>{{ details.ports.join(', ') || '未配置' }}</dd></div>
            <div><dt>进程组</dt><dd>{{ details.processGroupIds.join(', ') || '不可用' }}</dd></div>
            <div class="wide"><dt>配置 cwd</dt><dd>{{ details.cwd }}</dd></div>
            <div class="wide"><dt>配置 command</dt><dd>{{ details.command }}</dd></div>
          </dl>

          <div class="process-list" aria-label="已复核进程列表">
            <article v-for="process in details.processes" :key="process.pid">
              <strong>PID {{ process.pid }}</strong>
              <dl>
                <div><dt>PID</dt><dd>{{ process.pid }}</dd></div>
                <div><dt>PPID</dt><dd>{{ process.parentPid ?? '不可用' }}</dd></div>
                <div><dt>PGID</dt><dd>{{ process.processGroupId }}</dd></div>
                <div class="wide"><dt>cwd</dt><dd>{{ process.cwd ?? '不可用' }}</dd></div>
                <div class="wide"><dt>command</dt><dd>{{ process.command ?? '不可用' }}</dd></div>
              </dl>
            </article>
          </div>

          <p class="impact">{{ details.impact }}</p>
          <p class="safety">
            {{ force
              ? '仅在身份再次复核通过后向以上精确进程组发送 SIGKILL。'
              : '确认后仍会重新核验 PID、PGID、启动时间、cwd 与端口所有者；身份变化将自动取消。' }}
          </p>
          </div>

          <footer>
          <div class="copy-area">
            <button type="button" class="secondary" @click="copyDetails">复制全部详情</button>
            <span role="status" aria-live="polite">{{ copyFeedback }}</span>
          </div>
          <div class="decision-actions">
            <button ref="cancelButton" type="button" class="secondary" @click="emit('cancel')">取消</button>
            <button type="button" class="danger" @click="emit('confirm')">
              {{ force ? '强制终止' : '确认关闭' }}
            </button>
          </div>
          </footer>
        </section>
      </div>
    </PnwOverlayThemeProvider>
  </Teleport>
</template>

<style scoped>
.process-confirm-backdrop { position: fixed; z-index: 10000; inset: 0; display: grid; place-items: center; padding: 18px; background: rgba(2, 6, 23, .62); }
.process-confirm { display: flex; flex-direction: column; width: min(760px, 100%); max-height: min(760px, calc(100dvh - 36px)); overflow: hidden; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 12px; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); box-shadow: 0 24px 70px rgba(2, 6, 23, .42); }
header, footer { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 18px; }
header { border-bottom: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); }
header small { color: #ef4444; font-size: 10px; font-weight: 800; letter-spacing: .16em; }
h2 { margin: 3px 0 0; font-size: 18px; }
.icon-button { width: 30px; height: 30px; padding: 0; border: 0; background: transparent; color: inherit; font-size: 25px; cursor: pointer; }
.process-confirm-body { min-height: 0; overflow: auto; padding: 16px 18px; user-select: text; }
.warning, .impact, .safety { margin: 0 0 14px; padding: 10px 12px; border-radius: 7px; line-height: 1.55; }
.warning { background: rgba(239, 68, 68, .11); color: #f87171; }
.impact { margin-top: 14px; background: rgba(245, 158, 11, .1); color: #f59e0b; }
.safety { margin-bottom: 0; background: rgba(59, 130, 246, .1); color: #60a5fa; }
dl { margin: 0; }
.summary-grid, article dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 14px; }
.summary-grid > div, article dl > div { min-width: 0; }
.wide { grid-column: 1 / -1; }
dt { margin-bottom: 2px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; font-weight: 700; text-transform: uppercase; }
dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; }
.process-list { display: grid; gap: 10px; margin-top: 14px; }
article { min-width: 0; padding: 12px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 8px; background: var(--pnw-workbench-bg, var(--pnw-workbench-default-bg, #f8fafc)); }
article strong { display: block; margin-bottom: 9px; font-size: 12px; }
footer { border-top: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); }
.copy-area, .decision-actions { display: flex; align-items: center; gap: 8px; }
.copy-area span { color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 11px; }
button.secondary, button.danger { min-height: 34px; padding: 0 13px; border-radius: 7px; font: inherit; cursor: pointer; }
button.secondary { border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); background: transparent; color: inherit; }
button.danger { border: 1px solid #dc2626; background: #dc2626; color: #fff; }
button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }

@media (max-width: 560px) {
  .process-confirm-backdrop { padding: 8px; }
  .process-confirm { max-height: calc(100dvh - 16px); }
  header, footer, .process-confirm-body { padding: 12px; }
  .summary-grid, article dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  footer { align-items: stretch; flex-direction: column; }
  .copy-area, .decision-actions { justify-content: space-between; }
  .decision-actions button { flex: 1; }
}
</style>
