// 主题管理
import { ref, onMounted, onUnmounted } from 'vue';

const currentTheme = ref('dark');
const THEME_KEY = 'sitian-theme';

export function useTheme() {
  function setTheme(theme) {
    currentTheme.value = theme;
    document.documentElement.classList.remove('theme-dark', 'theme-light');
    document.documentElement.classList.add(`theme-${theme}`);
    localStorage.setItem(THEME_KEY, theme);
  }

  function toggleTheme() {
    setTheme(currentTheme.value === 'dark' ? 'light' : 'dark');
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) {
      currentTheme.value = saved;
      document.documentElement.classList.add(`theme-${saved}`);
    } else {
      document.documentElement.classList.add('theme-dark');
    }
  }

  return {
    currentTheme,
    setTheme,
    toggleTheme,
    initTheme,
  };
}
