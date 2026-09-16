import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  base: './',
  root: path.resolve(__dirname, 'src/renderer'),
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'pinia'],
        },
      },
    },
  },
  // P2-4：派生 worker（workers/deriveWorker.js，经 `?worker` 引入）。
  // 显式用 iife 而不是 'es' —— 打包后的应用是以 file:// 加载 dist/index.html 的，
  // file:// 页面构造「模块 worker」受 CORS 限制；经典 worker 无此问题。
  // 若某天要改成 'es'，必须先在真实打包（非 dev）里验一遍 worker 能否构造成功。
  worker: {
    format: 'iife',
  },
  server: {
    port: 5180,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer/src'),
    },
  },
});
