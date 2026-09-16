import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { installDevFallback } from './dev-standalone.js';

// 纯浏览器开发（npm run dev，无 Electron preload）兜底：避免 window.sitianAPI undefined 直接崩。
// DEV 分支在生产构建里被静态替换为 false → 整个模块作为死代码被摇掉（mock 红线：dist 不得含 mock）。
if (import.meta.env.DEV) installDevFallback();

// 启动进度上报（批次A10）：splash 定义在 index.html，无 splash 环境(如测试注入)下静默跳过
window.__sitianSplash?.set?.(30, '正在初始化界面…');

const app = createApp(App);
app.use(createPinia());

// B1 + P0.4: 全局错误边界（渲染异常/未捕获异常 → 落盘 + 友好错误面板，不白屏）
import { installErrorBoundary } from './utils/errorReport';
installErrorBoundary(app);

app.mount('#app');

// P0-2 标签样式预设：先读 localStorage 镜像（同步，立即可用），再异步拉 .sitian/config/label-presets.json
import { initLabelPresets } from './utils/labelStyles';
initLabelPresets();

// P1-4 标记类型注册表：同上（.sitian/config/marker-types.json）
import { initMarkerTypes } from './utils/markerTypes';
initMarkerTypes();

window.__sitianSplash?.set?.(55, '正在加载世界数据…');
