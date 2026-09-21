<template>
  <PanelShell
    class="git-sync-panel"
    title="同步到远程仓库"
    :collapsible="true"
    :stop-mouse-down="true"
    @close="$emit('close')"
  >
    <template #title><Icon name="cloud" :size="15" style="margin-right:6px" />同步到远程仓库</template>

    <div class="gs-body">
      <p class="gs-lead">
        把你司天项目所在目录推到你的远程仓库（GitHub / Gitee / 自建 git 都行）。
        <b>不需要敲任何 git 命令</b>：填一次地址 → 以后只点「立即同步」。
      </p>

      <!-- 无项目：先说清去哪儿建 -->
      <div v-if="!dir" class="gs-empty">
        <div class="gs-empty-title">还没有可同步的目录</div>
        <div class="gs-empty-body">
          同步的对象是<b>项目文件所在目录</b>。请先在「项目」面板里新建或打开一个项目，再回到这里。
        </div>
        <button class="gs-btn gs-btn-ghost" @click="$emit('open-project')">去项目面板</button>
      </div>

      <template v-else>
        <!-- 目标目录 + 状态 -->
        <div class="gs-section">
          <div class="gs-label">同步目录</div>
          <div class="gs-path" :title="dir">{{ dir }}</div>
          <div class="gs-status">
            <span v-if="loading">读取状态…</span>
            <template v-else-if="status && status.isRepo">
              <span :class="['gs-pill', status.remote ? 'ok' : 'warn']">
                {{ status.remote ? '已连接远程仓库' : '还没填仓库地址' }}
              </span>
              <span class="gs-dim">分支 {{ status.branch || 'main' }}</span>
              <span class="gs-dim">待同步 {{ status.dirty }} 项</span>
            </template>
            <span v-else class="gs-dim">这个目录还没建成仓库（第一次同步会自动建）</span>
          </div>
          <div v-if="status && status.lastCommit" class="gs-dim gs-last">
            上次同步：{{ fmtTime(status.lastCommitAt) }} · {{ status.lastCommit }}
          </div>
        </div>

        <!-- 仓库地址 -->
        <div class="gs-section">
          <div class="gs-label">远程仓库地址</div>
          <input
            ref="urlInput"
            v-model.trim="remoteUrl"
            class="gs-input"
            type="text"
            spellcheck="false"
            placeholder="https://github.com/你的用户名/你的仓库.git"
            @keyup.enter="saveRemote"
          />
          <div class="gs-row">
            <button class="gs-btn" :disabled="busy || !remoteUrl" @click="saveRemote">{{ busy === 'save' ? '保存中…' : '保存并连接' }}</button>
            <span class="gs-dim">私有仓库也能用（填一次令牌，见下方）</span>
          </div>
        </div>

        <!-- 一键同步 -->
        <div class="gs-section">
          <button class="gs-btn gs-btn-primary gs-btn-lg" :disabled="busy || !canSync" @click="doSync">
            {{ busy === 'sync' ? '同步中…' : '立即同步' }}
          </button>
          <div class="gs-dim gs-tip">
            同步 = 把当前改动提交并推到远程。本地还有 <b>10 份滚动备份 + 1 份会话基线</b>，推送失败也不会丢数据。
          </div>
        </div>

        <!-- 令牌（折叠） -->
        <details class="gs-adv">
          <summary>需要登录？（私有仓库 / 提示需要令牌时填这里）</summary>
          <div class="gs-adv-body">
            <div class="gs-label">用户名</div>
            <input v-model.trim="user" class="gs-input" type="text" spellcheck="false" placeholder="GitHub 用户名" />
            <div class="gs-label">访问令牌（不是密码）</div>
            <input
              v-model="token"
              class="gs-input"
              type="password"
              spellcheck="false"
              placeholder="粘贴 token，保存后本窗口不再显示"
              @keyup.enter="saveToken"
            />
            <div class="gs-row">
              <button class="gs-btn" :disabled="busy === 'token' || !token" @click="saveToken">
                {{ busy === 'token' ? '保存中…' : '保存令牌' }}
              </button>
              <span class="gs-dim">存进系统凭据管理器，不写进仓库配置文件</span>
            </div>
            <div class="gs-dim gs-tip">
              GitHub 令牌在「Settings → Developer settings → Personal access tokens」生成，
              勾 <b>repo</b> 权限即可。司天只把它交给系统凭据管理器，不会回显、不会写日志。
            </div>
          </div>
        </details>
      </template>

      <div v-if="tipText" :class="['gs-tip-line', tipKind]">{{ tipText }}</div>
    </div>
  </PanelShell>
</template>

<script setup>
/**
 * GitSyncPanel —— 「傻瓜式」远程同步面板（用户需求 2026-09-21）。
 *
 * 设计原则：
 *   · 用户只需要两件事：填一次仓库地址 → 点「立即同步」。不出现 push/branch/commit 这些词。
 *   · 同步目录 = 当前项目的目录（projectDir / 项目文件所在目录），面板只读展示，不给用户选路径的负担。
 *   · 令牌是可选的进阶项，默认折叠；面板**不回显**令牌（保存即清空输入框）。
 *   · 所有错误文案来自主进程的人话化处理（gitSyncHandler.humanize），面板只负责显示。
 *
 * 与 ProjectPanel 的关系：本面板只依赖 projectStore（拿同步目录）+ sitianAPI（git 通道），
 * 不 import geodata、不改项目数据 —— 与面板/向导的既有约束一致。
 */
import { ref, computed, onMounted, nextTick } from 'vue';
import PanelShell from './PanelShell.vue';
import Icon from './Icon.vue';
import { useProjectStore } from '../store/projectStore';

const emit = defineEmits(['close', 'open-project']);

const proj = useProjectStore();
const urlInput = ref(null);
const remoteUrl = ref('');
const user = ref('');
const token = ref('');
const status = ref(null);
const loading = ref(false);
const busy = ref('');
const tipText = ref('');
const tipKind = ref('ok');

const dir = computed(() => {
  // ⚠️ 没有打开的项目 = 没有可同步目录：不能只看 projectDir（它在关闭项目后仍保留上次的目录，
  //    会让面板误以为有东西可同步，用户点了同步才发现同步的是个空壳）
  if (!proj.isOpen) return '';
  if (proj.projectDir) return proj.projectDir;
  const fp = proj.filePath || '';
  return fp ? fp.replace(/[\\/][^\\/]+$/, '') : '';
});
const canSync = computed(() => !!(status.value && status.value.isRepo && status.value.remote));

function setTip(text, kind = 'ok') {
  tipText.value = text;
  tipKind.value = kind;
}

function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN');
  } catch (e) {
    return iso;
  }
}

async function refresh() {
  if (!dir.value) {
    status.value = null;
    return;
  }
  loading.value = true;
  try {
    const res = await window.sitianAPI?.gitSyncStatus?.(dir.value);
    status.value = res && res.success !== false ? res : null;
    if (res && res.remote && !remoteUrl.value) remoteUrl.value = res.remote;
  } catch (e) {
    status.value = null;
  } finally {
    loading.value = false;
  }
}

async function saveRemote() {
  if (!dir.value || !remoteUrl.value) return;
  busy.value = 'save';
  try {
    const res = await window.sitianAPI?.gitSyncConfigure?.({ dir: dir.value, remoteUrl: remoteUrl.value });
    if (res && res.success) setTip('已保存仓库地址', 'ok');
    else setTip((res && res.error) || '保存失败', 'err');
  } finally {
    busy.value = '';
    await refresh();
  }
}

async function doSync() {
  if (!dir.value) return;
  busy.value = 'sync';
  setTip('正在同步…', 'ok');
  try {
    const res = await window.sitianAPI?.gitSyncNow?.({ dir: dir.value });
    if (res && res.success) {
      setTip(res.changed > 0 ? `已同步（${res.changed} 项改动）` : '已是最新，无需同步', 'ok');
    } else {
      setTip((res && res.error) || '同步失败', 'err');
    }
  } finally {
    busy.value = '';
    await refresh();
  }
}

async function saveToken() {
  if (!token.value) return;
  busy.value = 'token';
  try {
    const res = await window.sitianAPI?.gitSyncCredential?.({
      remoteUrl: remoteUrl.value, username: user.value, token: token.value,
    });
    if (res && res.success) {
      token.value = '';           // 不回显：保存后立刻清空
      setTip('令牌已保存到系统凭据管理器', 'ok');
    } else {
      setTip((res && res.error) || '令牌保存失败', 'err');
    }
  } finally {
    busy.value = '';
  }
}

onMounted(async () => {
  await refresh();
  // 输入框可用性（§130.2 同款教训）：面板是异步挂载的，先给焦点，用户不必「点得准」
  await nextTick();
  if (!remoteUrl.value) urlInput.value?.focus?.();
});
</script>

<style scoped>
/* 面板是浅色卡面（--planet-editor-bg 两套主题都是白）→ 强调色必须用深色，否则白底上看不见 */
.git-sync-panel {
  position: absolute;
  top: 60px;
  right: 20px;
  width: 390px;
  max-height: calc(100% - 110px);
  z-index: 200;
  display: flex;
  flex-direction: column;
}
.gs-body {
  padding: 12px 14px 16px;
  overflow-y: auto;
  color: #2d3436;
  font-size: 12.5px;
  line-height: 1.65;
}
.gs-lead {
  margin: 0 0 12px;
  color: #4a5257;
}
.gs-lead b { color: #1c4fa1; }

.gs-empty {
  border: 1px dashed #cfd6da;
  border-radius: 8px;
  padding: 14px;
  text-align: left;
}
.gs-empty-title { font-weight: 600; color: #b3261e; margin-bottom: 6px; }
.gs-empty-body { color: #4a5257; margin-bottom: 10px; }

.gs-section {
  border-top: 1px solid #eef1f3;
  padding: 10px 0;
}
.gs-section:first-of-type { border-top: none; }
.gs-label {
  font-weight: 600;
  color: #1c4fa1;
  margin-bottom: 5px;
}
.gs-path {
  font-family: Consolas, Menlo, monospace;
  font-size: 11.5px;
  color: #2d3436;
  background: #f4f6f8;
  border: 1px solid #e6eaee;
  border-radius: 6px;
  padding: 5px 7px;
  word-break: break-all;
}
.gs-status { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 7px; }
.gs-pill {
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11.5px;
  font-weight: 600;
}
.gs-pill.ok { background: #e7f4ec; color: #1b6b3a; }
.gs-pill.warn { background: #fdf1e7; color: #b3261e; }
.gs-dim { color: #6b7378; font-size: 11.5px; }
.gs-last { margin-top: 4px; }

.gs-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #d4dade;
  border-radius: 6px;
  padding: 7px 9px;
  font-size: 12.5px;
  color: #2d3436;
  background: #fff;
  outline: none;
}
.gs-input:focus { border-color: #1c4fa1; box-shadow: 0 0 0 2px rgba(28, 79, 161, 0.15); }

.gs-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 7px; }

.gs-btn {
  border: 1px solid #c8d0d6;
  background: #fff;
  color: #1c4fa1;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.gs-btn:hover:not(:disabled) { background: #f2f6fb; }
.gs-btn:disabled { opacity: 0.5; cursor: default; }
.gs-btn-primary { background: #1c4fa1; border-color: #1c4fa1; color: #fff; }
.gs-btn-primary:hover:not(:disabled) { background: #163f82; }
.gs-btn-lg { width: 100%; padding: 10px; font-size: 13.5px; }
.gs-btn-ghost { color: #2f5fd0; }

.gs-tip { margin-top: 7px; }

.gs-adv {
  border-top: 1px solid #eef1f3;
  padding: 10px 0 0;
}
.gs-adv summary {
  cursor: pointer;
  color: #2f5fd0;
  font-weight: 600;
}
.gs-adv-body { padding-top: 8px; }
.gs-adv-body .gs-label { margin-top: 8px; }

.gs-tip-line {
  margin-top: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
}
.gs-tip-line.ok { background: #e7f4ec; color: #1b6b3a; }
.gs-tip-line.err { background: #fdecea; color: #b3261e; }
</style>
