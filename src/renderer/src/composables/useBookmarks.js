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

  function addBookmark(name, viewTransform, viewLevel, layerState, selectedNodeIds) {
    bookmarks.value.push({
      id: `bm_${Date.now()}`,
      name: name || `书签 ${bookmarks.value.length + 1}`,
      viewTransform: { ...viewTransform },
      viewLevel,
      layerState: layerState || {},
      selectedNodeIds: selectedNodeIds || [],
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
