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
              <span :class="['gs-pill', hasToken ? 'ok' : 'warn']" data-testid="token-state">
                {{ hasToken ? '令牌已保存' : '未保存令牌' }}
              </span>
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
            <button class="gs-btn" :disabled="busy || !remoteUrl" data-testid="test-connection" @click="testConnection">{{ busy === 'test' ? '检查中…' : '测试连接' }}</button>
          </div>
          <div class="gs-dim gs-tip">
            地址里带了令牌（<code>https://token@github.com/…</code>）也没关系：保存时会自动抽出令牌、
            不在仓库配置里留明文。
          </div>
        </div>

        <!-- 令牌（折叠）：默认展开条件 = 还没保存令牌时 -->
        <details class="gs-adv" :open="!hasToken">
          <summary>需要登录？（私有仓库 / 提示需要令牌时填这里）</summary>
          <div class="gs-adv-body">
            <div class="gs-dim gs-token-state" data-testid="token-detail">
              {{ hasToken
                ? `已保存令牌${status && status.tokenUsername ? '（用户名 ' + status.tokenUsername + '）' : ''} —— 推送时直接使用，不需要再填`
                : '尚未保存令牌' }}
            </div>
            <div class="gs-label">用户名</div>
            <input v-model.trim="user" class="gs-input" type="text" spellcheck="false" placeholder="GitHub 用户名" />
            <div class="gs-label">访问令牌（不是密码）</div>
            <input
              v-model="token"
              class="gs-input"
              type="password"
              autocomplete="new-password"
              spellcheck="false"
              placeholder="粘贴 token，保存后本窗口不再显示"
              @keyup.enter="saveToken"
            />
            <div class="gs-row">
              <button class="gs-btn" :disabled="busy === 'token' || !token" @click="saveToken">
                {{ busy === 'token' ? '保存中…' : '保存令牌' }}
              </button>
              <button v-if="hasToken" class="gs-btn gs-btn-ghost" :disabled="busy === 'forget'" @click="forgetToken">清除令牌</button>
            </div>
            <div class="gs-dim gs-tip">
              GitHub 令牌在「Settings → Developer settings → Personal access tokens」生成：
              经典令牌勾 <b>repo</b>；细粒度令牌勾 <b>Contents: Read and write</b> 并把该仓库加入授权列表。
              令牌加密保存在本机、不回显、不写日志、不写进仓库配置。
            </div>
          </div>
        </details>

        <!-- 一键同步 -->
        <div class="gs-section">
          <button class="gs-btn gs-btn-primary gs-btn-lg" :disabled="busy || !canSync" @click="doSync">
            {{ busy === 'sync' ? '同步中…' : '立即同步' }}
          </button>
          <div class="gs-dim gs-tip">
            同步 = 把当前改动提交并推到远程。本地还有 <b>10 份滚动备份 + 1 份会话基线</b>，推送失败也不会丢数据。
          </div>
        </div>

        <!-- 从远程恢复（拉取）：破坏性操作，必须有警告 + 二次确认 -->
        <div class="gs-section gs-danger-section">
          <div class="gs-label gs-danger-label">从远程恢复（拉取）</div>
          <button class="gs-btn gs-btn-danger" :disabled="busy || !canSync" data-testid="pull-btn" @click="preparePull">
            {{ busy === 'pull' ? '处理中…' : '读取远程版本…' }}
          </button>
          <div class="gs-warn">
            ⚠️ 恢复会<b>把本地改成与远程一致</b>：本地未同步的改动会被远端版本覆盖。
            为防意外，司天会先自动（1）保存、（2）在本地留一个<b>带名字的快照</b>（只在本机、不会被推送）、
            （3）额外备份项目文件 —— 恢复完成的提示里会告诉你这个名字，内容随时可找回。
            两台设备同时改同一个项目时，先在这台同步再恢复。
          </div>

          <!-- 二次确认条（不用原生 confirm：headless 下测不到，且会打断用户） -->
          <div v-if="pullPlan" class="gs-confirm" data-testid="pull-confirm">
            <div class="gs-confirm-text">
              远程有 <b>{{ pullPlan.behind === null ? '一批' : pullPlan.behind }}</b> 项新内容
              <template v-if="pullPlan.dirty > 0">；本地还有 <b>{{ pullPlan.dirty }}</b> 项未同步改动（会被覆盖）</template>。
              确认恢复？
            </div>
            <div class="gs-row">
              <button class="gs-btn gs-btn-danger" :disabled="busy === 'pull'" @click="confirmPull">确认恢复</button>
              <button class="gs-btn gs-btn-ghost" @click="pullPlan = null">取消</button>
            </div>
          </div>
        </div>
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
/** 拉取的二次确认计划（非空 = 显示确认条） */
const pullPlan = ref(null);

const dir = computed(() => {
  // ⚠️ 没有打开的项目 = 没有可同步目录：不能只看 projectDir（它在关闭项目后仍保留上次的目录，
  //    会让面板误以为有东西可同步，用户点了同步才发现同步的是个空壳）
  if (!proj.isOpen) return '';
  if (proj.projectDir) return proj.projectDir;
  const fp = proj.filePath || '';
  return fp ? fp.replace(/[\\/][^\\/]+$/, '') : '';
});
const canSync = computed(() => !!(status.value && status.value.isRepo && status.value.remote));
/** 令牌是否已保存（主进程回答，渲染层只拿布尔值；令牌本身永不过界） */
const hasToken = computed(() => !!(status.value && status.value.hasToken));

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
  pullPlan.value = null;
  try {
    const res = await window.sitianAPI?.gitSyncConfigure?.({ dir: dir.value, remoteUrl: remoteUrl.value });
    if (res && res.success) {
      // 主进程会把地址里内嵌的凭据抽出来，所以我们显示的是干净地址
      if (res.remoteUrl) remoteUrl.value = res.remoteUrl;
      setTip(res.note ? `已保存仓库地址（${res.note}）` : '已保存仓库地址', 'ok');
    } else {
      setTip((res && res.error) || '保存失败', 'err');
    }
  } finally {
    busy.value = '';
    await refresh();
  }
}

/** 测试连接：立刻验证地址 + 令牌能不能用（用户最需要的确定性反馈） */
async function testConnection() {
  if (!dir.value) return;
  busy.value = 'test';
  setTip('正在访问远程仓库…', 'ok');
  try {
    const res = await window.sitianAPI?.gitSyncTest?.({ dir: dir.value, remoteUrl: remoteUrl.value });
    if (res && res.success) setTip(res.note || '连接成功', 'ok');
    else setTip((res && res.error) || '连接失败', 'err');
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
      dir: dir.value, remoteUrl: remoteUrl.value, username: user.value, token: token.value,
    });
    if (res && res.success) {
      token.value = '';           // 不回显：保存后立刻清空
      setTip(res.note || '令牌已保存', res.persistent === false ? 'err' : 'ok');
    } else {
      setTip((res && res.error) || '令牌保存失败', 'err');
    }
  } finally {
    busy.value = '';
    await refresh();
  }
}

async function forgetToken() {
  busy.value = 'forget';
  try {
    const res = await window.sitianAPI?.gitSyncForget?.({ remoteUrl: remoteUrl.value });
    setTip(res && res.success ? '已清除本机保存的令牌' : ((res && res.error) || '清除失败'), res && res.success ? 'ok' : 'err');
  } finally {
    busy.value = '';
    await refresh();
  }
}

/**
 * 第一步：只探测（主进程 fetch 后回报差异，不改工作区），拿到差异再给用户确认。
 */
async function preparePull() {
  if (!dir.value) return;
  busy.value = 'pull';
  setTip('正在读取远程版本…', 'ok');
  try {
    const res = await window.sitianAPI?.gitSyncPull?.({ dir: dir.value, confirm: false });
    if (res && res.success && res.pulled === false) {
      pullPlan.value = null;
      setTip(res.message || '远程没有新内容，本地不必恢复', 'ok');
    } else if (res && res.needsConfirm) {
      pullPlan.value = { behind: (res.behind === undefined ? null : res.behind), ahead: res.ahead || 0, dirty: res.dirty || 0 };
      setTip(res.error || '远程有新内容，请确认后恢复', 'err');
    } else {
      pullPlan.value = null;
      setTip((res && res.error) || '读取远程版本失败', 'err');
    }
  } finally {
    busy.value = '';
    await refresh();
  }
}

/**
 * 第二步（用户已确认）：真正恢复。
 * 🔴 顺序是安全的关键：
 *   ① flushSave —— 先把内存改动落盘（否则恢复后可能被内存里的旧状态写回）
 *   ② backupNow —— 项目文件额外留一份（`.backups/`，不进 git）
 *   ③ 主进程 reset --hard（主进程侧还会先把本地状态提交进 git 历史）
 *   ④ openProject(filePath) 重新装载 —— 必须做：否则画布上还是旧数据，下一次自动保存会把旧数据写回去
 */
async function confirmPull() {
  if (!dir.value) return;
  busy.value = 'pull';
  const filePath = proj.filePath;
  try {
    const flush = await proj.flushSave();
    if (flush && flush.success === false) {
      setTip(`本地还有改动没保存成功，已中止恢复：${flush.error}`, 'err');
      return;
    }
    try { await proj.backupNow(); } catch (e) { /* 额外备份失败不阻断（主进程 reset 前还会提交一次本地状态） */ }

    const res = await window.sitianAPI?.gitSyncPull?.({ dir: dir.value, confirm: true });
    if (!res || !res.success) {
      setTip((res && res.error) || '恢复失败', 'err');
      return;
    }
    const files = Array.isArray(res.changedFiles) ? res.changedFiles.length : 0;

    const reopened = filePath ? await proj.openProject(filePath) : null;
    if (filePath && (!reopened || reopened.success !== true)) {
      setTip(`已恢复到远程版本（更新 ${files} 个文件），但重新载入项目失败：`
        + `${(reopened && reopened.error) || '未知原因'}｜请在「项目」面板手动打开：${filePath}`, 'err');
    } else {
      const rescue = res.rescueBranch
        ? `；恢复前的本地内容已留底（本地快照 ${res.rescueBranch}，不会被推送上去）`
        : '';
      setTip(`已从远程恢复${files ? `（更新 ${files} 个文件）` : ''}${rescue}，项目已重新载入`, 'ok');
    }
    pullPlan.value = null;
  } finally {
    busy.value = '';
    await refresh();
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
  /* ⚠️ 面板底色是 PanelShell 的 var(--panel-bg)（暗色主题下是深色）→
     直接坐在面板底色上的文字必须用主题变量；写死的深色在暗色主题下 = 深底深字（用户实测"难以阅读"）。
     反之，自带浅色底的块（.gs-warn / .gs-tip-line / .gs-danger-section / .gs-pill）继续用深色字，两个主题都可读。 */
  color: var(--text-primary);
  font-size: 12.5px;
  line-height: 1.65;
}
.gs-lead {
  margin: 0 0 12px;
  color: var(--text-secondary);
}
.gs-lead b { color: var(--accent); }

.gs-empty {
  /* 自带浅色底：内部沿用深色字，两个主题都读得清 */
  border: 1px dashed #cfd6da;
  border-radius: 8px;
  padding: 14px;
  text-align: left;
  background: #f7f9fb;
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
  color: var(--accent);
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
.gs-dim { color: var(--text-secondary); font-size: 11.5px; }
.gs-last { margin-top: 4px; }

.gs-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--input-border, #d4dade);
  border-radius: 6px;
  padding: 7px 9px;
  font-size: 12.5px;
  color: var(--text-primary, #2d3436);
  background: var(--input-bg, #fff);
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
  color: var(--accent);
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

/* 从远程恢复（拉取）：破坏性操作用危险色独立成块，避免和「同步」混在一起误点 */
.gs-danger-section {
  margin-top: 4px;
  border: 1px solid #f3c8c3;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fdf7f6;
}
.gs-danger-label { color: #b3261e !important; }
.gs-btn-danger {
  background: #fff;
  border-color: #b3261e;
  color: #b3261e;
}
.gs-btn-danger:hover:not(:disabled) { background: #fdecea; }
.gs-warn {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.65;
  color: #8a4b45;
  background: #fdecea;
  border-radius: 6px;
  padding: 7px 9px;
}
.gs-warn b { color: #b3261e; }
.gs-confirm {
  margin-top: 9px;
  border-top: 1px dashed #e2b3ae;
  padding-top: 9px;
}
.gs-confirm-text { font-size: 12px; color: #8a4b45; margin-bottom: 7px; }
.gs-confirm-text b { color: #b3261e; }
.gs-token-state { margin-bottom: 8px; }
.gs-tip code {
  font-family: Consolas, Menlo, monospace;
  font-size: 11px;
  /* ⚠️ 这枚 code 自带浅色底 → 文字必须是深色：用主题变量（暗色下是浅色字）会变成浅底浅字（实测对比度 1.4） */
  color: #2d3436;
  background: #f1f4f7;
  border-radius: 3px;
  padding: 0 3px;
}
</style>
