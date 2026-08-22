import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

// 启动进度上报（批次A10）：splash 定义在 index.html，无 splash 环境(如测试注入)下静默跳过
window.__sitianSplash?.set?.(30, '正在初始化界面…');

const app = createApp(App);
app.use(createPinia());
app.mount('#app');

window.__sitianSplash?.set?.(55, '正在加载世界数据…');
