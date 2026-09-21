/**
 * dev-standalone.js — 纯浏览器开发模式（npm run dev，无 Electron preload）的最小兜底 API
 *
 * 为什么需要：
 *   `npm run dev` 只跑前端，浏览器里没有 preload → `window.sitianAPI === undefined`
 *   → App onMounted 的 `store.loadGeodata()` 抛 `Cannot read properties of undefined (reading 'getGeodata')`
 *   整个应用白屏/报错。历史上靠 index.html 里常驻一段 mock 脚本"糊"过去，结果被 git 提交进仓库、
 *   又被打进 dist（mock 红线，commit 09ef2a5 / d846929 两次踩坑）——本文件取代那种做法：
 *
 *   - 只在 `import.meta.env.DEV` 下动态 import（打包产物里是死代码，进不了 dist）
 *   - 只在 `window.sitianAPI` 缺失时安装（Electron 里 preload 已提供，此处直接返回）
 *   - 不内置任何假数据：真实数据来自可选的 `src/renderer/dev-data/*.json`
 *     （开发者自己把 .sitian 的两个 json 拷进去，该目录已 gitignore）
 *   - 所有写操作返回失败而非静默成功，避免"以为存住了"
 *
 * 需要真实数据 + 持久化 → 用 `npm run dev:watch`（Electron 完整环境）。
 */

const DEV_DATA = {
  geodata: '/dev-data/geodata.json',
  mapdata: '/dev-data/mapdata.json',
};

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

export function installDevFallback() {
  if (typeof window === 'undefined') return false;
  if (window.sitianAPI) return false; // Electron：preload 已就绪
  // 测试注入的 mock 会同步打上该标记（数据稍后就绪）→ 不要抢在它前面装兜底，否则数据恒为空
  if (window.__SITIAN_MOCK__) return false;

  const fail = async () => ({ success: false, error: 'browser-dev-mode（未落盘）' });
  const noopSub = () => () => {};

  let geodataCache = null;
  let mapdataCache = null;

  // 真实数据只读加载（文件不存在 → 明确失败，让 UI 走空状态）
  async function loadDevData() {
    if (geodataCache) return { geodata: geodataCache, mapdata: mapdataCache };
    const [g, m] = await Promise.all([
      fetchJson(DEV_DATA.geodata),
      fetchJson(DEV_DATA.mapdata).catch(() => ({})),
    ]);
    geodataCache = g;
    mapdataCache = m;
    return { geodata: g, mapdata: m };
  }

  const api = {
    platform: 'browser',
    version: 'dev-browser',

    getGeodata: async () => {
      try {
        const { geodata } = await loadDevData();
        return { success: true, data: geodata };
      } catch (e) {
        console.warn(`[SiTian dev] 读不到 ${DEV_DATA.geodata}：${e.message}。`
          + '把知识库 .sitian/ 目录下的 geodata.json + mapdata.json 复制到 '
          + 'src/renderer/dev-data/ 即可在浏览器里预览；需要写入请用 npm run dev:watch。');
        return { success: false, error: e.message };
      }
    },
    getMapData: async (planetId) => {
      try {
        const { mapdata } = await loadDevData();
        const data = mapdata?.[planetId] ?? mapdata?.[String(planetId).split('/').pop()] ?? null;
        return { success: true, data };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
    getVaultPath: async () => '（浏览器预览：只读 dev-data 副本）',

    // 写操作在纯浏览器下不可用 → 明确失败，不制造"已保存"的假象
    saveGeodata: fail,
    saveMapData: fail,
    saveScenarios: fail,
    loadScenarios: async () => ({ success: true, data: { version: 2, baseMaps: {}, scenarios: {} } }),
    reextractGeodata: fail,
    clearCoordinateCache: fail,
    backupSitianCache: fail,
    batchImportNotes: fail,
    selectVaultPath: async () => ({ success: false, canceled: true }),
    setVaultPath: async () => ({ success: false, canceled: true }),
    selectReferenceImage: async () => ({ success: false, canceled: true }),
    saveExportFile: async () => ({ success: false, canceled: true }),
    readObsidianNote: async () => ({ success: false, error: 'browser-dev-mode' }),
    revealInExplorer: fail,
    openExternal: async (url) => { window.open(url, '_blank', 'noopener'); return { success: true }; },

    // 订阅类必须返回「取消订阅函数」，不能返回 Promise
    onNodeUpdated: noopSub,
    onNodeRemoved: noopSub,
    onOpenSettings: noopSub,
    onMenuAction: noopSub,
  };

  // 未列出的方法一律兜底：调用即返回失败，杜绝"xxx is not a function"
  window.sitianAPI = new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'string' && key.startsWith('on')) return noopSub;
      return fail;
    },
  });

  console.info('[SiTian dev] 浏览器预览模式：检测不到 Electron preload，已安装只读兜底 API（不会写盘）。'
    + '需要真实数据 + 持久化请用 npm run dev:watch。');
  return true;
}
