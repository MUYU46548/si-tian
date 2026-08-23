import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

// 启动进度上报（批次A10）：splash 定义在 index.html，无 splash 环境(如测试注入)下静默跳过
window.__sitianSplash?.set?.(30, '正在初始化界面…');

const app = createApp(App);
app.use(createPinia());

// B1: 全局错误边界（渲染异常捕获 → 友好错误面板，不白屏）
app.config.errorHandler = (err, instance, info) => {
  console.error('[SiTian Global Error]', err, '\nComponent:', instance?.$options?.__name || instance, '\nInfo:', info);

  // 防止重复渲染错误面板
  if (document.getElementById('sitian-error-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'sitian-error-overlay';
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(10,10,20,0.92);color:#e0e0e0;font-family:system-ui,sans-serif;padding:24px;box-sizing:border-box;">
      <div style="max-width:560px;width:100%;background:#1a1a2e;border:1px solid #444;border-radius:12px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
        <div style="font-size:24px;margin-bottom:12px;">⚠️ 界面渲染异常</div>
        <p style="color:#aaa;font-size:13px;line-height:1.6;margin-bottom:16px;">SiTian 在渲染过程中遇到了一个错误。以下是详细信息（已同步到控制台）：</p>
        <pre style="background:#0d1117;border:1px solid #333;border-radius:6px;padding:12px;font-size:11.5px;color:#f97583;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;margin-bottom:20px;">${err?.message || err}</pre>
        <p style="color:#888;font-size:11.5px;margin-bottom:16px;">组件：${instance?.$options?.__name || '未知'} · 位置：${info || '未知'}</p>
        <div style="display:flex;gap:10px;">
          <button onclick="location.reload()" style="flex:1;padding:10px;border:none;border-radius:6px;background:#4A90D9;color:#fff;cursor:pointer;font-size:13px;">重新加载应用</button>
          <button onclick="document.getElementById('sitian-error-overlay')?.remove()" style="flex:1;padding:10px;border:1px solid #555;border-radius:6px;background:transparent;color:#ccc;cursor:pointer;font-size:13px;">忽略并继续</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
};

app.mount('#app');

window.__sitianSplash?.set?.(55, '正在加载世界数据…');
