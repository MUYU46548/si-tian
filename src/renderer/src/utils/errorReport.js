// P0.4: 全局错误上报 — 渲染层错误统一格式化 + 落盘（主进程 electron-log）+ 友好覆盖层
// 模态用纯 DOM 实现（不进 Vue 响应式，避免错误处理器自身再触发渲染循环）

let lastReportedMessage = '';
let lastReportedAt = 0;

function formatDetails(err, ctx) {
  const lines = [
    `时间: ${new Date().toLocaleString()}`,
    `消息: ${err?.message || String(err)}`,
    `组件: ${ctx?.component || '未知'}`,
    `钩子: ${ctx?.info || '未知'}`,
    `版本: ${window.sitianAPI?.version || '未知'}`,
    `平台: ${window.sitianAPI?.platform || navigator.platform}`,
  ];
  if (err?.stack) lines.push(`堆栈:\n${err.stack}`);
  return lines.join('\n');
}

function reportToMain(err, ctx) {
  // 同一分钟内相同消息只上报一次，避免错误风暴刷爆日志
  const message = err?.message || String(err);
  const now = Date.now();
  if (message === lastReportedMessage && now - lastReportedAt < 60_000) return;
  lastReportedMessage = message;
  lastReportedAt = now;
  window.sitianAPI?.reportError?.({
    message,
    stack: err?.stack || null,
    component: ctx?.component || null,
    info: ctx?.info || null,
  }).catch(() => {});
}

function showOverlay(err, ctx) {
  // 防止重复渲染错误面板
  if (document.getElementById('sitian-error-overlay')) return;

  const details = formatDetails(err, ctx);
  const overlay = document.createElement('div');
  overlay.id = 'sitian-error-overlay';
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(10,10,20,0.92);color:#e0e0e0;font-family:system-ui,sans-serif;padding:24px;box-sizing:border-box;">
      <div style="max-width:600px;width:100%;background:#1a1a2e;border:1px solid #444;border-radius:12px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
        <div style="font-size:22px;margin-bottom:12px;">⚠️ 应用遇到错误</div>
        <p style="color:#aaa;font-size:13px;line-height:1.6;margin-bottom:12px;">SiTian 遇到了一个内部错误，详细信息已记录到本地日志。您可以复制详情后提交反馈，或尝试重新加载应用。</p>
        <pre data-role="detail" style="background:#0d1117;border:1px solid #333;border-radius:6px;padding:12px;font-size:11.5px;color:#f97583;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;margin-bottom:16px;"></pre>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button data-role="reload" style="flex:1;min-width:120px;padding:10px;border:none;border-radius:6px;background:#4A90D9;color:#fff;cursor:pointer;font-size:13px;">重新加载应用</button>
          <button data-role="copy" style="flex:1;min-width:120px;padding:10px;border:1px solid #555;border-radius:6px;background:transparent;color:#ccc;cursor:pointer;font-size:13px;">复制详情</button>
          <button data-role="issue" style="flex:1;min-width:120px;padding:10px;border:1px solid #555;border-radius:6px;background:transparent;color:#ccc;cursor:pointer;font-size:13px;">提交反馈</button>
          <button data-role="dismiss" style="flex:1;min-width:120px;padding:10px;border:1px solid #555;border-radius:6px;background:transparent;color:#ccc;cursor:pointer;font-size:13px;">忽略并继续</button>
        </div>
        <p data-role="copied" style="display:none;color:#7ec699;font-size:12px;margin:10px 0 0;">✓ 已复制到剪贴板</p>
      </div>
    </div>
  `;
  overlay.querySelector('[data-role="detail"]').textContent = details;

  overlay.querySelector('[data-role="reload"]').addEventListener('click', () => location.reload());
  overlay.querySelector('[data-role="dismiss"]').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-role="copy"]').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(details);
      const tip = overlay.querySelector('[data-role="copied"]');
      tip.style.display = 'block';
      e.target.textContent = '✓ 已复制';
    } catch (_) { /* 剪贴板不可用时静默 */ }
  });
  overlay.querySelector('[data-role="issue"]').addEventListener('click', () => {
    window.sitianAPI?.openExternal?.('https://github.com/MUYU46548/si-tian/issues');
  });

  document.body.appendChild(overlay);
}

// Vue 渲染错误（模板/组合式函数抛出）
function installVueErrorHandler(app) {
  app.config.errorHandler = (err, instance, info) => {
    const ctx = {
      component: instance?.$options?.__name || '未知',
      info,
    };
    console.error('[SiTian Global Error]', err, '\nComponent:', ctx.component, '\nInfo:', info);
    reportToMain(err, ctx);
    showOverlay(err, ctx);
  };
}

// 事件回调 / Promise 等非渲染路径的未捕获异常
function installWindowHandlers() {
  window.addEventListener('error', (event) => {
    if (!event.error && event.message) return; // 资源加载失败不弹面板
    console.error('[SiTian Uncaught Error]', event.error || event.message);
    if (event.error) {
      reportToMain(event.error, { component: 'window.onerror' });
      showOverlay(event.error, { component: 'window.onerror' });
    }
  });
  window.addEventListener('unhandledrejection', (event) => {
    const err = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    console.error('[SiTian Unhandled Rejection]', err);
    reportToMain(err, { component: 'unhandledrejection' });
    // Promise 拒绝多为局部可恢复错误，仅落盘不弹面板
  });
}

export function installErrorBoundary(app) {
  installVueErrorHandler(app);
  installWindowHandlers();
}
