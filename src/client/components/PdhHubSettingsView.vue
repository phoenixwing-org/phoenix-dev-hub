<script setup lang="ts">
import { onMounted, ref } from "vue";
import PnwPageHeader from "phoenix-wing/layout/PnwPageHeader.vue";
import PnwPageLayout from "phoenix-wing/layout/PnwPageLayout.vue";
import type { AdminPluginWorkspaceSettings, HubRuntimeInfo } from "@shared/contracts";
import { devHubApi } from "../api";

defineOptions({ name: "PdhHubSettingsView" });
const emit = defineEmits<{
  error: [error: unknown];
  adminPluginSettingsChanged: [];
  openServiceSettings: [];
}>();

const info = ref<HubRuntimeInfo>();
const confirmingShutdown = ref(false);
const shuttingDown = ref(false);
const adminPluginSettings = ref<AdminPluginWorkspaceSettings>();
const adminPluginSettingsDraft = ref<AdminPluginWorkspaceSettings>();
const editingAdminPluginSettings = ref(false);
const savingAdminPluginSettings = ref(false);
const adminPluginSettingsError = ref("");

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "暂时无法读取 Phoenix Admin 开发设置";
}

async function refresh(): Promise<void> {
  try {
    info.value = await devHubApi.hubInfo();
  } catch (error) {
    emit("error", error);
  }
  try {
    const catalog = await devHubApi.adminPluginCatalog();
    adminPluginSettings.value = catalog.settings;
    adminPluginSettingsError.value = "";
    if (!editingAdminPluginSettings.value) adminPluginSettingsDraft.value = { ...catalog.settings };
  } catch (error) {
    adminPluginSettingsError.value = errorMessage(error);
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

function editAdminPluginSettings(): void {
  adminPluginSettingsDraft.value = adminPluginSettings.value && { ...adminPluginSettings.value };
  editingAdminPluginSettings.value = true;
}

function cancelAdminPluginSettings(): void {
  adminPluginSettingsDraft.value = adminPluginSettings.value && { ...adminPluginSettings.value };
  editingAdminPluginSettings.value = false;
}

async function saveAdminPluginSettings(): Promise<void> {
  if (!adminPluginSettingsDraft.value || savingAdminPluginSettings.value) return;
  savingAdminPluginSettings.value = true;
  try {
    const settings = await devHubApi.updateAdminPluginSettings(adminPluginSettingsDraft.value);
    adminPluginSettings.value = settings;
    adminPluginSettingsDraft.value = { ...settings };
    editingAdminPluginSettings.value = false;
    emit("adminPluginSettingsChanged");
  } catch (error) {
    emit("error", error);
  } finally {
    savingAdminPluginSettings.value = false;
  }
}

onMounted(() => void refresh());
</script>

<template>
  <PnwPageLayout
    class="hub-settings"
    title="Hub 设置"
  >
    <template #header>
      <PnwPageHeader title="Hub 设置" :presentation-detachable="false">
        <template #actions>
          <button type="button" class="refresh" title="刷新 Hub 信息" aria-label="刷新 Hub 信息" @click="refresh">↻</button>
        </template>
      </PnwPageHeader>
    </template>

    <p class="page-intro">管理 Dev Hub 自身；网站与 API 仍在“服务设置”中配置。</p>
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
        <div class="card-heading">
          <div>
            <h2>Phoenix Admin 开发支持</h2>
            <p>指定 Admin 插件“开发挂载”和“启动 Admin Host”使用的唯一 Web / API Host。本机设置保存在 <code>.runtime/admin-plugins.json</code>。</p>
          </div>
          <button v-if="!editingAdminPluginSettings" type="button" :disabled="!adminPluginSettings" @click="editAdminPluginSettings">编辑</button>
        </div>

        <dl v-if="adminPluginSettings && !editingAdminPluginSettings" class="admin-host-facts">
          <div><dt>Admin Vue 根目录</dt><dd>{{ adminPluginSettings.adminWebRoot }}</dd></div>
          <div><dt>Admin Node 根目录</dt><dd>{{ adminPluginSettings.adminNodeRoot }}</dd></div>
          <div><dt>Web 服务 ID</dt><dd>{{ adminPluginSettings.adminWebServiceId }}</dd></div>
          <div><dt>API 服务 ID</dt><dd>{{ adminPluginSettings.adminApiServiceId }}</dd></div>
        </dl>

        <div v-else-if="adminPluginSettingsDraft" class="admin-host-form">
          <label><span>Admin Vue 根目录</span><input v-model="adminPluginSettingsDraft.adminWebRoot" type="text"></label>
          <label><span>Admin Node 根目录</span><input v-model="adminPluginSettingsDraft.adminNodeRoot" type="text"></label>
          <label><span>Web 服务 ID</span><input v-model="adminPluginSettingsDraft.adminWebServiceId" type="text"></label>
          <label><span>API 服务 ID</span><input v-model="adminPluginSettingsDraft.adminApiServiceId" type="text"></label>
          <div class="form-actions">
            <button type="button" :disabled="savingAdminPluginSettings" @click="cancelAdminPluginSettings">取消</button>
            <button type="button" class="primary" :disabled="savingAdminPluginSettings" @click="saveAdminPluginSettings">{{ savingAdminPluginSettings ? '正在保存…' : '保存本机设置' }}</button>
          </div>
        </div>

        <p v-else class="settings-unavailable" role="status">
          未能读取 Phoenix Admin 开发设置；请确认 Hub 正在运行且本机配置可解析，然后点击右上角刷新。
          <small>{{ adminPluginSettingsError || '正在读取…' }}</small>
        </p>

        <p class="hint">保存时后端会验证两个目录均为 Git 根目录、服务 ID 合法；不会创建/移动插件链接，也不会启动服务、初始化数据库或修改服务清单。</p>
      </article>

      <article>
        <h2>服务配置</h2>
        <p>网站、端口、启动参数、干净验证 worktree 与 User 项目仍由“服务设置”管理；不要在这里复制一份服务定义。</p>
        <button type="button" @click="emit('openServiceSettings')">打开服务设置</button>
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
  </PnwPageLayout>
</template>

<style scoped>
.hub-settings { width: 100%; height: 100%; --pnw-page-main-block-padding: 24px 28px 40px; --pdh-header-control-height: calc(var(--pnw-workbench-view-header-height, 40px) - 8px); color: var(--pnw-workbench-text, var(--pnw-workbench-default-text, #0f172a)); }
.page-intro { margin: 0 0 14px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 11px; line-height: 1.5; }
article p, small { color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 11px; line-height: 1.65; }
.refresh { width: var(--pdh-header-control-height); height: var(--pdh-header-control-height); border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
article { padding: 17px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 9px; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); }
article h2 { margin: 0 0 9px; font-size: 14px; }
article p { margin: 0 0 13px; }
.wide-card { grid-column: 1 / -1; }
.card-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.card-heading h2 { margin-bottom: 5px; }
dl { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0; }
dl div.wide { grid-column: 1 / -1; }
.admin-host-facts { margin-top: 14px; }
dt { margin-bottom: 3px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 9px; text-transform: uppercase; }
dd { margin: 0; overflow-wrap: anywhere; font: 650 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
code { font: 650 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
.admin-host-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; margin-top: 14px; }
.admin-host-form label { display: grid; gap: 5px; min-width: 0; }
.admin-host-form label span { color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 9px; }
.admin-host-form input { box-sizing: border-box; min-width: 0; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 6px; padding: 7px 8px; background: var(--pnw-control-bg, var(--pnw-workbench-default-control-bg, #fff)); color: inherit; outline: none; }
.form-actions { display: flex; grid-column: 1 / -1; justify-content: flex-end; gap: 8px; }
.settings-unavailable { margin: 14px 0 0; padding: 10px 11px; border: 1px solid rgba(245,158,11,.45); border-radius: 6px; background: rgba(245,158,11,.08); color: #fbbf24; }
.settings-unavailable small { margin-top: 5px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); overflow-wrap: anywhere; }
.hint { margin-top: 12px; color: var(--pnw-workbench-muted, var(--pnw-workbench-default-muted, #64748b)); font-size: 10px; line-height: 1.6; }
button { min-height: 30px; padding: 0 11px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .5; }
button.primary { border-color: #2563eb; background: #2563eb; color: #fff; }
button.danger { border-color: rgba(239,68,68,.65); color: #ef4444; }
.danger-zone { border-color: rgba(239,68,68,.35); }
small { display: block; margin-top: 8px; }
.dialog-backdrop { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(2,6,23,.68); }
.dialog { width: min(470px, 100%); padding: 20px; border: 1px solid var(--pnw-workbench-border, var(--pnw-workbench-default-border, #dbe3ed)); border-radius: 10px; background: var(--pnw-workbench-surface, var(--pnw-workbench-default-surface, #fff)); box-shadow: 0 24px 70px rgba(0,0,0,.4); }
.dialog h2 { margin: 0 0 10px; font-size: 17px; }
.dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
@media (max-width: 720px) { .settings-grid,.admin-host-form { grid-template-columns: 1fr; } .wide-card { grid-column: auto; } .card-heading { align-items: stretch; flex-direction: column; } }
</style>
