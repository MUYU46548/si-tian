/**
 * Tailwind 配置 —— 司天 UI 基座试点（2026-10-06，方案 A）
 *
 * 为什么这么配（每一条都对应 docs/PROPOSAL_DISCLAIMER_AND_UI.md §2.3 的风险项）：
 *
 *  1. `corePlugins.preflight = false` + CSS 入口只写 `@tailwind utilities`
 *     （见 src/renderer/src/assets/tailwind.css）—— **双保险地不出 base 层**。
 *     preflight 会带来 `html{line-height:1.5}`（R2：全仓本来没有全局 line-height，
 *     一引就整体漂移）和 `ol,ul{list-style:none}`（R1：`NodeDetailPanel` 的
 *     `.markdown-body ul/ol` 没写 list-style，靠浏览器默认渲染列表符号 → 会直接消失）。
 *
 *  2. 颜色**一律走 CSS 变量**（`--ui-*`），不写死色值 —— 这是 R7 的处置：
 *     shadcn 的默认体系是「`:root` 变量 + `html.dark`」，而司天的 token 挂在
 *     App 根元素（编译成 `.theme-dark[data-v-…]`）。两套不接通的后果是
 *     「组件走自己的调色板 → 观感割裂 + 切主题不跟着变」。
 *     所以这里把 shadcn 的语义色**映射到司天自己的板子上**，取值定义在
 *     tailwind.css 的 `.theme-dark` / `.theme-light` 里。
 *
 *  3. `content` 只扫真正的源码目录（`src/renderer`）。仓库根的 `index.html`
 *     是遗留 dev 产物（已进 .gitignore），不参与扫描，免得把旧 mock 里的
 *     类名当成真实用法生成样式。
 */
module.exports = {
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{vue,js}',
  ],
  corePlugins: {
    // 🔴 不要动：关掉 preflight 是本试点「零观感回归」的前提（R1/R2/R5/R6）
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        border: 'var(--ui-border)',
        input: 'var(--ui-input)',
        ring: 'var(--ui-ring)',
        background: 'var(--ui-background)',
        foreground: 'var(--ui-foreground)',
        primary: {
          DEFAULT: 'var(--ui-primary)',
          foreground: 'var(--ui-primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--ui-secondary)',
          foreground: 'var(--ui-secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--ui-muted)',
          foreground: 'var(--ui-muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--ui-accent)',
          foreground: 'var(--ui-accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--ui-destructive)',
          foreground: 'var(--ui-destructive-foreground)',
        },
        card: {
          DEFAULT: 'var(--ui-card)',
          foreground: 'var(--ui-card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--ui-popover)',
          foreground: 'var(--ui-popover-foreground)',
        },
      },
      borderRadius: {
        // 接司天既有圆角令牌（--radius-*，定义在 App.vue 的 .theme-* 块里）
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
    },
  },
  plugins: [],
};
