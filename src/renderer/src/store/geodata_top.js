import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { execute, undo as undoCmd, redo as redoCmd, canUndo as undoCanUndo, canRedo as undoCanRedo } from './undo';

const MAX_HISTORY = 50;
const AUTO_SAVE_DELAY = 800;

export const useGeodataStore = defineStore('geodata', () => {
  const nodes = ref([]);
  const hyperlanes = ref([]);
  const currentWorld = ref(null);
  const currentDomain = ref(null);
  const currentSystem = ref(null);
  const currentPlanet = ref(null);
  const viewLevel = ref('world');
  const selectedNode = ref(null);

  // ===== 历史栈（旧快照系统，用于坐标拖拽和航道编辑） =====
  const history = ref([]);
  const future = ref([]);
  let isUndoRedo = false;
  let autoSaveTimer = null;
  const autoSaveEnabled = ref(true);

  // ===== 地图数据 =====
  const mapData = ref({});

  // ===== 计算属性（旧栈 + 新栈合并） =====
  const canUndo = computed(() => history.value.length > 0 || undoCanUndo.value);
  const canRedo = computed(() => future.value.length > 0 || undoCanRedo.value);

  function snapshot() {
    if (isUndoRedo) return;
    history.value.push({
      nodes: JSON.parse(JSON.stringify(nodes.value)),
      hyperlanes: JSON.parse(JSON.stringify(hyperlanes.value)),
    });
    if (history.value.length > MAX_HISTORY) {
      history.value.shift();
    }
    future.value = [];
  }

  function undo() {
    if (history.value.length > 0) {
      isUndoRedo = true;
      const prev = history.value.pop();
      future.value.push({
        nodes: JSON.parse(JSON.stringify(nodes.value)),
        hyperlanes: JSON.parse(JSON.stringify(hyperlanes.value)),
      });
      nodes.value = prev.nodes;
      hyperlanes.value = prev.hyperlanes;
      isUndoRedo = false;
    } else if (undoCanUndo.value) {
      undoCmd();
    }
  }

  function redo() {
    if (future.value.length > 0) {
      isUndoRedo = true;
      const next = future.value.pop();
      history.value.push({
        nodes: JSON.parse(JSON.stringify(nodes.value)),
        hyperlanes: JSON.parse(JSON.stringify(hyperlanes.value)),
      });
      nodes.value = next.nodes;
      hyperlanes.value = next.hyperlanes;
      isUndoRedo = false;
    } else if (undoCanRedo.value) {
      redoCmd();
    }
  }

  // ===== 搜索状态 =====