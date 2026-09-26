import { ref, computed, onMounted, onUnmounted } from 'vue';

const STORAGE_KEY = 'sitian-bookmarks';
const MAX_BOOKMARKS = 20;

export function useBookmarks() {
  const bookmarks = ref([]);
  const currentIndex = ref(-1);

  function load() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        bookmarks.value = JSON.parse(data);
      }
    } catch (e) {
      console.error('[Bookmarks] 加载失败:', e);
      bookmarks.value = [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks.value));
    } catch (e) {
      console.error('[Bookmarks] 保存失败:', e);
    }
  }

  /**
   * 添加视口书签。
   * @param {string} name
   * @param {{x:number,y:number,scale:number}} viewTransform 相机（存的是 translate）
   * @param {string} viewLevel 记录时的视图层级
   * @param {object} layerState 图层可见性快照
   * @param {string[]|null} selectedNodeIds 预留
   * @param {string|null} anchorId **R5**：该视图此刻"站在"哪个实体上 ——
   *   跨层跳转全靠它（层级不同时先 focus 这个实体把视图切过去）。
   *   旧书签没有这个字段 → 跳转时给明确提示，而不是静默失败。
   */
  function addBookmark(name, viewTransform, viewLevel, layerState, selectedNodeIds, anchorId) {
    bookmarks.value.push({
      id: `bm_${Date.now()}`,
      name: name || `书签 ${bookmarks.value.length + 1}`,
      viewTransform: { ...viewTransform },
      viewLevel,
      layerState: layerState || {},
      selectedNodeIds: selectedNodeIds || [],
      anchorId: anchorId || null,
      createdAt: new Date().toISOString(),
    });
    if (bookmarks.value.length > MAX_BOOKMARKS) {
      bookmarks.value.shift();
    }
    save();
    return bookmarks.value[bookmarks.value.length - 1];
  }

  function removeBookmark(id) {
    bookmarks.value = bookmarks.value.filter(b => b.id !== id);
    save();
  }

  function clearAll() {
    bookmarks.value = [];
    save();
  }

  load();

  return {
    bookmarks,
    currentIndex,
    addBookmark,
    removeBookmark,
    clearAll,
  };
}
