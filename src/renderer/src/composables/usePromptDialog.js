/**
 * composables/usePromptDialog.js — 模态输入对话框（批次D1）
 *
 * 替代 window.prompt：Electron 渲染进程不支持 window.prompt（抛
 * "prompt() is and will not be supported"），此前的「＋ 天体」等入口
 * 在 Electron 内全部静默失效。
 *
 * 单例状态 + Promise 接口，语义与 window.prompt 对齐（取消返回 null）：
 *   const { askText, askChoice } = usePromptDialog();
 *   const name = await askText({ title: '名称', defaultValue: '新行星' });
 *   const type = await askChoice({ title: '类型', options: [{ key, label, icon }] });
 * PromptDialog.vue 挂载在 App.vue 根部，全应用共用一份状态。
 */
import { reactive } from 'vue';

const state = reactive({
  open: false,
  mode: 'text',        // 'text' | 'choice'
  title: '',
  label: '',
  value: '',
  placeholder: '',
  options: [],         // choice 模式：[{ key, label, icon? }]
  resolve: null,
});

function settle(result) {
  state.open = false;
  const resolve = state.resolve;
  state.resolve = null;
  resolve?.(result);
}

export function usePromptDialog() {
  /** 单行文本输入；确定返回 trim 后字符串，取消返回 null */
  function askText({ title, label = '', defaultValue = '', placeholder = '' }) {
    return new Promise((resolve) => {
      Object.assign(state, {
        open: true, mode: 'text', title, label,
        value: defaultValue, placeholder, options: [], resolve,
      });
    });
  }

  /** 选项列表（按钮式，替代「输入数字 1/2/3」）；点选即返回该 option，取消返回 null */
  function askChoice({ title, label = '', options = [] }) {
    return new Promise((resolve) => {
      Object.assign(state, {
        open: true, mode: 'choice', title, label,
        value: '', placeholder: '', options, resolve,
      });
    });
  }

  return {
    state,
    askText,
    askChoice,
    submitText: () => settle(String(state.value ?? '').trim()),
    choose: (opt) => settle(opt),
    cancel: () => settle(null),
  };
}
