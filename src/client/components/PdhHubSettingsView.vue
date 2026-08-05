<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { HubRuntimeInfo } from "@shared/contracts";
import { devHubApi } from "../api";

defineOptions({ name: "PdhHubSettingsView" });
const emit = defineEmits<{ error: [error: unknown] }>();

const info = ref<HubRuntimeInfo>();
const confirmingShutdown = ref(false);
const shuttingDown = ref(false);

async function refresh(): Promise<void> {
  try {
    info.value = await devHubApi.hubInfo();
  } catch (error) {
    emit("error", error);
  }
}

async function openTerminal(): Promise<void> {
  try {
    await devHubApi.openHubTerminal();
  } catch (error) {
    emit("error", error);
  }
}

async function shutdown(): Promise<void> {
  shuttingDown.value = true;
  try {
    await devHubApi.shutdownHub();
    confirmingShutdown.value = false;
  } catch (error) {
    shuttingDown.value = false;
    emit("error", error);
  }
}

onMounted(() => void refresh());
</script>

<template>
  <section class="hub-settings">
    <header>
      <div>
        <p>PHOENIX DEV HUB</p>
        <h1>Hub 设置</h1>
        <span>管理 Dev Hub 自身；网站与 API 仍在“服务设置”中配置。</span>
      </div>
      <button type="button" class="refresh" title="刷新 Hub 信息" @click="refresh">↻</button>
    </header>

    <div class="settings-grid">
      <article>
        <h2>运行信息</h2>
        <dl>
          <div><dt>版本</dt><dd>{{ info?.version ?? '读取中…' }}</dd></div>
          <div><dt>地址</dt><dd>{{ info?.address ?? 'http://127.0.0.1:42100' }}</dd></div>
          <div class="wide"><dt>项目目录</dt><dd>{{ info?.projectRoot ?? '读取中…' }}</dd></div>
        </dl>
      </article>

      <article>
        <h2>系统终端</h2>
        <p>打开一个停留在 Hub 项目目录的系统终端，不自动执行命令。关闭 Hub 后可在此运行 <code>pnpm dev</code>。</p>
        <button
          type="button"
          class="primary"
          :disabled="!info?.systemTerminal.available"
          :title="info?.systemTerminal.reason"
          @click="openTerminal"
        >
          打开 Hub 终端
        </button>
        <small v-if="info && !info.systemTerminal.available">{{ info.systemTerminal.reason }}</small>
      </article>

      <article class="wide-card">
        <h2>重启边界</h2>
        <p>{{ info?.restartMessage ?? '检测中…' }}</p>
      </article>

      <article class="danger-zone wide-card">
        <h2>危险操作</h2>
        <p>关闭时会先精确停止所有 Hub-owned 服务，再退出 Hub。外部监控进程不会被自动关闭，当前网页会断开。</p>
        <button type="button" class="danger" @click="confirmingShutdown = true">关闭 Hub</button>
      </article>
    </div>

    <div v-if="confirmingShutdown" class="dialog-backdrop" role="presentation" @mousedown.self="confirmingShutdown = false">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="hub-shutdown-title">
        <h2 id="hub-shutdown-title">确认关闭 Phoenix Dev Hub？</h2>
        <p>Hub 将先停止自己拥有的服务进程组，然后关闭 42100 端口。页面随后断开；外部进程不受影响。</p>
        <p>建议先点击“打开 Hub 终端”，以便随后运行 <code>pnpm dev</code>。</p>
        <footer>
          <button type="button" :disabled="shuttingDown" @click="confirmingShutdown = false">取消</button>
          <button type="button" class="danger" :disabled="shuttingDown" @click="shutdown">
            {{ shuttingDown ? '正在关闭…' : '确认关闭' }}
          </button>
        </footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.hub-settings { min-height: 100%; padding: 24px 28px 40px; color: var(--pnw-workbench-fg, #dbeafe); }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
header p { margin: 0 0 5px; color: #3b82f6; font-size: 10px; font-weight: 900; letter-spacing: .18em; }
h1 { margin: 0 0 5px; font-size: 24px; }
header span, article p, small { color: var(--pnw-workbench-muted, #94a3b8); font-size: 11px; line-height: 1.65; }
.refresh { width: 30px; height: 28px; border: 1px solid var(--pnw-workbench-border, #28384c); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
article { padding: 17px; border: 1px solid var(--pnw-workbench-border, #28384c); border-radius: 9px; background: var(--pnw-workbench-surface, rgba(15,23,42,.56)); }
article h2 { margin: 0 0 9px; font-size: 14px; }
article p { margin: 0 0 13px; }
.wide-card { grid-column: 1 / -1; }
dl { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0; }
dl div.wide { grid-column: 1 / -1; }
dt { margin-bottom: 3px; color: var(--pnw-workbench-muted, #94a3b8); font-size: 9px; text-transform: uppercase; }
dd { margin: 0; overflow-wrap: anywhere; font: 650 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
code { font: 650 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
button { min-height: 30px; padding: 0 11px; border: 1px solid var(--pnw-workbench-border, #28384c); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .5; }
button.primary { border-color: #2563eb; background: #2563eb; color: #fff; }
button.danger { border-color: rgba(239,68,68,.65); color: #ef4444; }
.danger-zone { border-color: rgba(239,68,68,.35); }
small { display: block; margin-top: 8px; }
.dialog-backdrop { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(2,6,23,.68); }
.dialog { width: min(470px, 100%); padding: 20px; border: 1px solid var(--pnw-workbench-border, #334155); border-radius: 10px; background: var(--pnw-workbench-surface, #111827); box-shadow: 0 24px 70px rgba(0,0,0,.4); }
.dialog h2 { margin: 0 0 10px; font-size: 17px; }
.dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
@media (max-width: 720px) { .settings-grid { grid-template-columns: 1fr; } .wide-card { grid-column: auto; } }
</style>
