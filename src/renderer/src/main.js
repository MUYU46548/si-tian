import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

// 启动进度上报（批次A10）：splash 定义在 index.html，无 splash 环境(如测试注入)下静默跳过
window.__sitianSplash?.set?.(30, '正在初始化界面…');

const app = createApp(App);
app.use(createPinia());

// B1 + P0.4: 全局错误边界（渲染异常/未捕获异常 → 落盘 + 友好错误面板，不白屏）
import { installErrorBoundary } from './utils/errorReport';
installErrorBoundary(app);

app.mount('#app');

window.__sitianSplash?.set?.(55, '正在加载世界数据…');
