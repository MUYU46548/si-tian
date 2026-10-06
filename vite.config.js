import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';
// UI 基座（试点，2026-10-06）：Tailwind 只出 utilities 层，配置见仓库根 tailwind.config.js
import tailwindcss from 'tailwindcss';

export default defineConfig({
  plugins: [vue()],
  // 🔴 这里显式给 Tailwind 指定配置文件**绝对路径**，不依赖 postcss-load-config 的
  //    向上查找（Vite 的 root 是 src/renderer，而配置在仓库根 —— 靠隐式查找太脆）。
  //    只用 utilities 层：入口 src/renderer/src/assets/tailwind.css 里没有 @tailwind base。
  css: {
    postcss: {
      plugins: [tailwindcss({ config: path.resolve(__dirname, 'tailwind.config.js') })],
    },
  },
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
