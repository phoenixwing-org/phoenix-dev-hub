<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  AdminPluginCandidate,
  AdminPluginCatalogResponse,
  AdminPluginStatus,
  AdminPluginVerifyResponse,
  AdminPluginWorkspaceSettings,
} from "@shared/contracts";
import { devHubApi } from "../api";

defineOptions({ name: "PdhAdminPluginView" });
const props = defineProps<{
  catalog?: AdminPluginCatalogResponse;
  selectedId: string;
}>();
const emit = defineEmits<{
  changed: [pluginId?: string];
  select: [pluginId: string];
  error: [error: unknown];
  hostStarted: [];
}>();

const busy = ref("");
const verifyResult = ref<AdminPluginVerifyResponse>();
const editingSettings = ref(false);
const settingsDraft = ref<AdminPluginWorkspaceSettings>();
const repointing = ref(false);
const repointDirectory = ref("");
const repointCandidate = ref<AdminPluginCandidate>();
const selected = computed(() => props.catalog?.plugins.find((plugin) => plugin.registration.id === props.selectedId));

watch(() => props.catalog?.settings, (settings) => {
  if (settings && !editingSettings.value) settingsDraft.value = { ...settings };
}, { immediate: true, deep: true });
watch(() => props.selectedId, () => {
  repointing.value = false;
  repointDirectory.value = "";
  repointCandidate.value = undefined;
});

function mountStateLabel(status: AdminPluginStatus): string {
  return ({ mounted: "开发已挂载", unmounted: "尚未挂载", partial: "挂载不完整", conflict: "存在路径冲突", unavailable: "源目录不可用" })[status.mountState];
}

function linkStateLabel(value: AdminPluginStatus["mounts"][number]["linkState"]): string {
  return ({ mounted: "链接正确", missing: "未创建", occupied: "实体占用", "foreign-link": "外来链接", invalid: "无效" })[value];
}

async function perform(pluginId: string, action: "mount" | "unmount" | "remove"): Promise<void> {
  if (busy.value) return;
  if (action === "unmount" && !window.confirm("执行开发卸载？\n\n只移除两个开发 symlink 和本机 Git exclude marker；不会执行 Pah 数据卸载，也不会删除业务数据。")) return;
  if (action === "remove" && !window.confirm("从 Hub 的本机插件列表移除？\n\n必须已完成开发卸载；产品目录不会被删除。")) return;
  busy.value = action;
  try {
    if (action === "mount") await devHubApi.mountAdminPlugin(pluginId);
    else if (action === "unmount") await devHubApi.unmountAdminPlugin(pluginId);
    else await devHubApi.removeAdminPlugin(pluginId);
    emit("changed", action === "remove" ? undefined : pluginId);
  } catch (error) {
    emit("error", error);
  } finally {
    busy.value = "";
  }
}

async function inspectRepoint(): Promise<void> {
  if (!repointDirectory.value.trim() || busy.value) return;
  busy.value = "inspect-repoint";
  repointCandidate.value = undefined;
  try {
    repointCandidate.value = await devHubApi.inspectAdminPlugin(repointDirectory.value.trim());
  } catch (error) {
    emit("error", error);
  } finally {
    busy.value = "";
  }
}

async function repoint(): Promise<void> {
  if (!selected.value || !repointCandidate.value || busy.value) return;
  const oldModuleId = selected.value.identity.moduleId;
  if (oldModuleId && repointCandidate.value.manifest.moduleId !== oldModuleId) return;
  const targetModuleId = oldModuleId ?? repointCandidate.value.manifest.moduleId;
  if (!window.confirm(
    `将 ${targetModuleId} 的开发目录修改为：\n${repointCandidate.value.productRoot}\n\nHub 会复核旧登记身份，只更新开发登记、Vue/Node symlink 与 Git exclude；不会执行初始化、DDL、数据库或权限改动。`,
  )) return;
  busy.value = "repoint";
  try {
    await devHubApi.repointAdminPlugin(selected.value.registration.id, repointDirectory.value.trim());
    repointing.value = false;
    repointDirectory.value = "";
    repointCandidate.value = undefined;
    emit("changed", selected.value.registration.id);
  } catch (error) {
    emit("error", error);
  } finally {
    busy.value = "";
  }
}

async function startHost(): Promise<void> {
  if (busy.value) return;
  busy.value = "start";
  try {
    await devHubApi.startAdminPluginHost();
    emit("hostStarted");
  } catch (error) {
    emit("error", error);
  } finally {
    busy.value = "";
  }
}

async function verify(): Promise<void> {
  if (busy.value) return;
  busy.value = "verify";
  try {
    verifyResult.value = await devHubApi.verifyAdminPlugins();
  } catch (error) {
    emit("error", error);
  } finally {
    busy.value = "";
  }
}

async function saveSettings(): Promise<void> {
  if (!settingsDraft.value || busy.value) return;
  busy.value = "settings";
  try {
    await devHubApi.updateAdminPluginSettings(settingsDraft.value);
    editingSettings.value = false;
    emit("changed", props.selectedId || undefined);
  } catch (error) {
    emit("error", error);
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <main class="admin-plugin-view">
    <header class="view-header">
      <div>
        <span class="eyebrow">PHOENIX ADMIN DEVELOPMENT</span>
        <h1>Admin 插件</h1>
        <p>组合本机插件源码并挂载到同一套 Admin Host；插件本身不是可启动网站。</p>
      </div>
      <div class="header-actions">
        <button type="button" :disabled="!!busy" @click="startHost">启动 Admin Host</button>
        <button type="button" class="primary" :disabled="!!busy" @click="verify">{{ busy === 'verify' ? '核验中…' : '装配核验' }}</button>
      </div>
    </header>

    <section v-if="!selected" class="empty-state">
      <div class="empty-mark">◇</div>
      <h2>选择或加入一个 Admin 插件</h2>
      <p>在左侧选择产品根目录或 packages/admin-plugin 目录。Hub 会核验 Manifest v2、moduleId、Vue/Node 入口和 Pah 业务分组。</p>
    </section>

    <template v-else>
      <section class="plugin-heading panel">
        <div>
          <div class="title-line">
            <h2>{{ selected.identity.name }}</h2>
            <span class="state" :data-state="selected.mountState">{{ mountStateLabel(selected) }}</span>
            <span v-if="selected.candidate?.manifest.migrations.length" class="ddl">DDL {{ selected.candidate.manifest.migrations.length }}</span>
          </div>
          <p><code>{{ selected.identity.moduleId || 'moduleId 未保存' }}</code> · {{ selected.identity.version || '版本未知' }}</p>
          <small>{{ selected.candidate?.productRoot || selected.registration.productRoot }}</small>
        </div>
        <div class="plugin-actions">
          <button type="button" :disabled="!!busy || !selected.candidate || selected.mountState === 'mounted' || !selected.candidate.mountAllowed" @click="perform(selected.registration.id, 'mount')">开发挂载</button>
          <button type="button" :disabled="!!busy || !selected.candidate || selected.mountState === 'unmounted'" @click="perform(selected.registration.id, 'unmount')">开发卸载</button>
          <button type="button" :disabled="!!busy" @click="repointing = !repointing">{{ repointing ? '取消修改目录' : '修改目录' }}</button>
          <button type="button" class="danger" :disabled="!!busy || selected.mountState !== 'unmounted'" @click="perform(selected.registration.id, 'remove')">移除列表</button>
        </div>
      </section>

      <section v-if="selected.sourceState === 'unavailable'" class="panel source-unavailable" role="status">
        <strong>已登记的旧目录不可用</strong>
        <p>{{ selected.sourceError?.message }}</p>
        <small>登记仍保留；开发挂载/卸载已阻止。可使用“修改目录”选择同一 moduleId 的有效开发目录。</small>
      </section>

      <section v-if="repointing" class="panel repoint-panel">
        <div class="section-title"><div><h3>修改插件开发目录</h3><p>先检查新目录；后端会再次权威校验并以事务方式更新两端链接。</p></div></div>
        <div class="repoint-form">
          <label><span>新的产品或 admin-plugin 目录</span><input v-model="repointDirectory" type="text" placeholder="/本机/新的 Function worktree" @keyup.enter="inspectRepoint"></label>
          <div class="repoint-actions">
            <button type="button" :disabled="!!busy || !repointDirectory.trim()" @click="inspectRepoint">{{ busy === 'inspect-repoint' ? '检查中…' : '检查新目录' }}</button>
            <button type="button" class="primary" :disabled="!!busy || !repointCandidate || Boolean(selected.identity.moduleId && repointCandidate.manifest.moduleId !== selected.identity.moduleId) || !repointCandidate.mountAllowed" @click="repoint">确认修改目录</button>
          </div>
          <div v-if="repointCandidate" class="repoint-candidate">
            <strong>{{ repointCandidate.manifest.name }} · {{ repointCandidate.manifest.version }}</strong>
            <code>{{ repointCandidate.manifest.moduleId }}</code>
            <span :class="{ warning: Boolean(selected.identity.moduleId && repointCandidate.manifest.moduleId !== selected.identity.moduleId) }">{{ !selected.identity.moduleId ? '旧登记未保存 moduleId；后端将通过现有 Host 链接和 Git marker 复核身份' : repointCandidate.manifest.moduleId === selected.identity.moduleId ? 'moduleId 一致；可校验旧链接或认领已指向此目录的链接' : `moduleId 不一致；已登记 ${selected.identity.moduleId}` }}</span>
            <small>{{ repointCandidate.productRoot }}</small>
            <small v-for="warning in repointCandidate.validationWarnings" :key="warning" class="warning">{{ warning }}</small>
          </div>
          <p class="policy">边界：只更新 `.runtime/admin-plugins.json`、两个开发 symlink 与对应 `.git/info/exclude` marker；不执行 Pah register/install/enable、DDL、数据库或权限改动。</p>
        </div>
      </section>

      <section v-if="selected.candidate?.validationWarnings.length" class="panel policy-warnings">
        <strong>挂载前需要修正</strong>
        <p v-for="warning in selected.candidate.validationWarnings" :key="warning">{{ warning }}</p>
      </section>

      <section class="panel">
        <div class="section-title"><div><h3>开发挂载明细</h3><p>每条都由实时 lstat、readlink 与 Git 根目录检查得出；Git exclude 不控制工具扫描。</p></div></div>
        <div class="mount-grid">
          <article v-for="mount in selected.mounts" :key="mount.kind" class="mount-card">
            <div class="mount-title"><strong>{{ mount.label }}</strong><span :data-state="mount.linkState">{{ linkStateLabel(mount.linkState) }}</span></div>
            <dl>
              <div><dt>源目录</dt><dd><code>{{ mount.source }}</code></dd></div>
              <div><dt>Host 目标</dt><dd><code>{{ mount.target }}</code></dd></div>
              <div><dt>symlink</dt><dd>{{ mount.linkValue || '—' }}</dd></div>
              <div><dt>Git 排除</dt><dd><code>{{ mount.excludePath }}</code><br><code>{{ mount.excludePattern }}</code></dd></div>
            </dl>
            <p v-if="mount.detail" class="warning">{{ mount.detail }}</p>
          </article>
        </div>
      </section>

      <section v-if="selected.recentOperation" class="panel operation-panel">
        <div class="section-title"><div><h3>最近一次操作</h3><p>{{ selected.recentOperation.action === 'mount' ? '开发挂载' : selected.recentOperation.action === 'unmount' ? '开发卸载' : '重新指向' }} · {{ new Date(selected.recentOperation.completedAt).toLocaleString('zh-CN') }}</p></div></div>
        <ul>
          <li v-for="(change, index) in selected.recentOperation.changes" :key="`${change.path}-${index}`">
            <span>{{ change.kind === 'web' ? 'Vue' : 'Node' }}</span><strong>{{ change.action }}</strong><code>{{ change.path }}</code><small>{{ change.detail }}</small>
          </li>
        </ul>
      </section>

      <section v-if="selected.candidate">
        <article class="panel">
          <div class="section-title"><div><h3>Manifest 与路由</h3><p>导航固定由 manifest + Pah lifecycle 物化。</p></div></div>
          <dl class="facts">
            <div><dt>Source commit</dt><dd><code>{{ selected.candidate.sourceCommit?.slice(0, 12) || '未知' }}</code></dd></div>
            <div><dt>Manifest</dt><dd><code>{{ selected.candidate.manifestPath }}</code></dd></div>
            <div><dt>业务分组</dt><dd><code>{{ selected.candidate.manifest.preferredGroupId }}</code></dd></div>
            <div><dt>Artifacts</dt><dd><code>{{ selected.candidate.artifactsPath || '尚未生成' }}</code></dd></div>
          </dl>
          <ul class="route-list"><li v-for="route in selected.candidate.manifest.routes" :key="route.id"><code>{{ route.path }}</code><span>{{ route.title }}</span></li></ul>
        </article>
      </section>
    </template>

    <section v-if="verifyResult" class="panel verify-panel">
      <div class="section-title"><div><h3>{{ verifyResult.verificationBoundary.label }}</h3><p>{{ new Date(verifyResult.generatedAt).toLocaleString('zh-CN') }} · {{ verifyResult.ddlPolicy }}</p></div><button type="button" @click="verifyResult = undefined">关闭</button></div>
      <div class="verification-boundary">
        <strong>当前结果不能表示产品迁移完成</strong>
        <p>{{ verifyResult.verificationBoundary.gitExcludePolicy }}</p>
        <div class="gate-groups">
          <section>
            <h4>Host-owned</h4>
            <article v-for="owner in verifyResult.verificationBoundary.hostOwned" :key="owner.targetId">
              <span>{{ owner.label }}</span><code>{{ owner.candidateRoot }}</code>
              <small>{{ owner.gates.map((gate) => `${gate.tool}：未记录`).join(' · ') }}</small>
            </article>
          </section>
          <section>
            <h4>Plugin-owned</h4>
            <article v-for="owner in verifyResult.verificationBoundary.pluginOwned" :key="owner.targetId">
              <span>{{ owner.label }}</span><code>{{ owner.candidateRoot }}</code>
              <small>{{ owner.gates.map((gate) => `${gate.tool}：未记录`).join(' · ') }}</small>
            </article>
          </section>
        </div>
        <ul><li v-for="reason in verifyResult.verificationBoundary.blockingReasons" :key="reason">{{ reason }}</li></ul>
      </div>
      <article v-for="item in verifyResult.plugins" :key="item.plugin.registration.id">
        <strong>{{ item.plugin.identity.name }}</strong><span>{{ item.plugin.mountState }}</span><span>{{ item.lifecycle }}</span><code>{{ item.plugin.candidate?.sourceCommit?.slice(0, 12) || '源不可用' }}</code>
        <ul><li v-for="route in item.routes" :key="route.path" :class="{ ok: route.reachable }"><code>{{ route.path }}</code><span>{{ route.statusCode ?? '不可达' }}</span></li></ul>
      </article>
    </section>

    <section class="panel settings-panel">
      <div class="section-title"><div><h3>Admin Host 工作区</h3><p>这是本机私有配置；不会随项目归档。</p></div><button type="button" @click="editingSettings = !editingSettings">{{ editingSettings ? '取消' : '编辑' }}</button></div>
      <div v-if="settingsDraft" class="settings-grid">
        <label><span>Admin Vue 根目录</span><input v-model="settingsDraft.adminWebRoot" :readonly="!editingSettings"></label>
        <label><span>Admin Node 根目录</span><input v-model="settingsDraft.adminNodeRoot" :readonly="!editingSettings"></label>
        <label><span>Web / API 服务 ID</span><div class="inline"><input v-model="settingsDraft.adminWebServiceId" :readonly="!editingSettings"><input v-model="settingsDraft.adminApiServiceId" :readonly="!editingSettings"></div></label>
      </div>
      <div v-if="editingSettings" class="settings-actions"><button type="button" class="primary" :disabled="!!busy" @click="saveSettings">保存本机设置</button></div>
      <p class="recovery">退出 / 恢复：先停止 Admin Host → 对每个插件执行“开发卸载” → 再启动稳定 Host。数据库初始化与迁移由开发者在 Hub 之外处理。</p>
    </section>
  </main>
</template>

<style scoped>
.admin-plugin-view { height: 100%; box-sizing: border-box; overflow-y: auto; padding: 20px 24px 36px; color: var(--pnw-workbench-text, #e2e8f0); background: var(--pnw-workbench-bg, #0f172a); }
.view-header { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; margin-bottom: 16px; }.eyebrow { color: #3b82f6; font-size: 10px; font-weight: 900; letter-spacing: .22em; }.view-header h1 { margin: 4px 0 2px; font-size: 25px; }.view-header p,.section-title p,.plugin-heading p { margin: 0; color: var(--pnw-workbench-muted, #94a3b8); font-size: 11px; }.header-actions,.plugin-actions,.settings-actions { display: flex; gap: 8px; }
.plugin-actions { flex-wrap: wrap; justify-content: flex-end; }
button { border: 1px solid var(--pnw-workbench-border, #334155); border-radius: 6px; padding: 7px 10px; background: transparent; color: inherit; cursor: pointer; font-size: 11px; }button:hover { background: var(--pnw-control-hover-bg, rgba(59,130,246,.1)); }button:disabled { cursor: not-allowed; opacity: .42; }.primary { border-color: #2563eb; background: #2563eb; color: white; }.danger { color: #ef4444; }
.panel { margin-bottom: 12px; border: 1px solid var(--pnw-workbench-border, #28384c); border-radius: 9px; background: var(--pnw-workbench-surface, rgba(15,23,42,.56)); }.plugin-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 15px 17px; }.title-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }.title-line h2 { margin: 0; font-size: 18px; }.plugin-heading small { display: block; margin-top: 5px; color: var(--pnw-workbench-muted, #94a3b8); font-size: 9px; }.state,.ddl { padding: 3px 7px; border-radius: 999px; background: rgba(148,163,184,.13); color: #94a3b8; font-size: 9px; font-weight: 800; }.state[data-state="mounted"] { background: rgba(34,197,94,.13); color: #22c55e; }.state[data-state="partial"],.state[data-state="conflict"],.state[data-state="unavailable"],.ddl { background: rgba(245,158,11,.13); color: #f59e0b; }
.section-title { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 14px; border-bottom: 1px solid var(--pnw-workbench-border, #28384c); }.section-title h3 { margin: 0 0 2px; font-size: 12px; }.mount-grid,.two-column { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }.mount-grid { padding: 12px; }.mount-card { min-width: 0; padding: 11px; border: 1px solid var(--pnw-workbench-border, #28384c); border-radius: 7px; }.mount-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }.mount-title strong { font-size: 11px; }.mount-title span { color: var(--pnw-workbench-muted, #94a3b8); font-size: 9px; }.mount-title span[data-state="mounted"] { color: #22c55e; }.mount-title span[data-state="occupied"],.mount-title span[data-state="foreign-link"] { color: #f59e0b; }
.policy-warnings,.source-unavailable { padding: 11px 14px; border-color: rgba(245,158,11,.4); color: #f59e0b; font-size: 10px; }.policy-warnings p,.source-unavailable p { margin: 5px 0; }.source-unavailable small { color: var(--pnw-workbench-muted, #94a3b8); }.repoint-form { display: grid; gap: 9px; padding: 12px 14px; }.repoint-actions { display: flex; gap: 8px; }.repoint-candidate { display: grid; gap: 4px; padding: 9px; border: 1px solid var(--pnw-workbench-border, #334155); border-radius: 6px; font-size: 9px; }.repoint-candidate small { overflow-wrap: anywhere; color: var(--pnw-workbench-muted, #94a3b8); }.repoint-form .policy { margin: 0; }
dl { margin: 0; }dl div { display: grid; grid-template-columns: 70px minmax(0,1fr); gap: 8px; padding: 5px 0; border-top: 1px solid rgba(148,163,184,.08); font-size: 9px; }dt { color: var(--pnw-workbench-muted, #94a3b8); }dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: .96em; }.warning { color: #f59e0b; font-size: 9px; }
.operation-panel ul,.route-list,.verify-panel ul { list-style: none; margin: 0; padding: 10px 14px; }.operation-panel li { display: grid; grid-template-columns: 38px 100px minmax(0,1fr); gap: 5px 8px; padding: 5px 0; font-size: 9px; }.operation-panel li small { grid-column: 3; color: var(--pnw-workbench-muted, #94a3b8); }.two-column > .panel { margin-bottom: 12px; }.facts,.route-list,.token-field,.policy,.settings-grid,.recovery { margin: 12px 14px; }.route-list li { display: flex; justify-content: space-between; gap: 10px; padding: 5px 0; font-size: 9px; }.route-list span { color: var(--pnw-workbench-muted, #94a3b8); }
label { display: grid; gap: 5px; }label > span { color: var(--pnw-workbench-muted, #94a3b8); font-size: 9px; }input { min-width: 0; box-sizing: border-box; border: 1px solid var(--pnw-workbench-border, #334155); border-radius: 6px; padding: 7px 8px; background: var(--pnw-input-bg, rgba(15,23,42,.4)); color: inherit; outline: none; }input:read-only { border-color: transparent; padding-inline: 0; }.policy,.recovery { color: var(--pnw-workbench-muted, #94a3b8); font-size: 9px; line-height: 1.55; }.token-field + .policy + button { margin: 0 14px 12px; }pre { max-height: 240px; margin: 0 14px 14px; overflow: auto; padding: 10px; border-radius: 6px; background: rgba(2,6,23,.42); color: #cbd5e1; font-size: 9px; }
.verify-panel article { display: grid; grid-template-columns: minmax(140px,1fr) auto auto auto; gap: 8px; align-items: center; padding: 9px 14px; border-top: 1px solid rgba(148,163,184,.09); font-size: 9px; }.verify-panel article ul { grid-column: 1/-1; padding: 3px 0; }.verify-panel article li { display: flex; justify-content: space-between; color: #f59e0b; }.verify-panel article li.ok { color: #22c55e; }
.verification-boundary { margin: 12px 14px; padding: 11px; border: 1px solid rgba(245,158,11,.38); border-radius: 7px; background: rgba(245,158,11,.06); font-size: 9px; }.verification-boundary > strong { color: #f59e0b; }.verification-boundary > p { color: var(--pnw-workbench-muted, #94a3b8); }.gate-groups { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }.gate-groups h4 { margin: 0 0 5px; font-size: 10px; }.gate-groups article { display: grid; grid-template-columns: auto minmax(0,1fr); padding: 6px 0; border-top: 1px solid rgba(148,163,184,.09); }.gate-groups article code { overflow: hidden; color: var(--pnw-workbench-muted, #94a3b8); text-overflow: ellipsis; white-space: nowrap; }.gate-groups article small { grid-column: 1/-1; color: #f59e0b; }.verification-boundary > ul { margin: 9px 0 0; padding-left: 18px; color: #f59e0b; }
.settings-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px 14px; }.inline { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }.settings-actions { justify-content: flex-end; margin: 0 14px 12px; }.empty-state { display: grid; justify-items: center; align-content: center; min-height: 48vh; color: var(--pnw-workbench-muted, #94a3b8); text-align: center; }.empty-mark { font-size: 40px; color: #3b82f6; }.empty-state h2 { margin: 10px 0 4px; color: var(--pnw-workbench-text, #e2e8f0); font-size: 17px; }.empty-state p { max-width: 560px; font-size: 11px; line-height: 1.6; }
@media (max-width: 900px) { .view-header,.plugin-heading { align-items: stretch; flex-direction: column; }.mount-grid,.two-column,.settings-grid,.gate-groups { grid-template-columns: 1fr; }.verify-panel > article { grid-template-columns: 1fr auto; }.verify-panel > article span:nth-of-type(2),.verify-panel > article > code { display: none; } }
</style>
