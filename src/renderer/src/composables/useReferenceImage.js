// src/renderer/src/composables/useReferenceImage.js
// 参考底图与两点校准状态管理

import { ref, computed, watch, reactive } from 'vue';

export function useReferenceImage({ store, props, emit, renderer, currentMapData }) {
  // ===== 参考图状态 =====
  const showRefImagePanel = ref(false);
  const refImageLoading = ref(false);
  const refDragMode = ref(false);
  const showExtraLayers = ref(false);
  const refOpacity = ref(0.5);
  const refScale = ref(1);
  const activeRefIndex = ref(0);
  const referenceImages = computed(() => currentMapData.value?.referenceImages || []);
  const referenceImage = computed(() => referenceImages.value[activeRefIndex.value] || null);
  const refImageObjs = reactive({});

  // ===== 两点校准 =====
  const calibrationMode = ref(false);
  const calibrationPoints = ref([]);
  const calibrationDist = ref(10);

  // 列表变化时校正选中索引 + 懒加载全部图的 Image
  watch(referenceImages, (list) => {
    if (activeRefIndex.value >= list.length) {
      activeRefIndex.value = Math.max(0, list.length - 1);
    }
    list.forEach(ref => {
      if (ref.dataUrl && refImageObjs[ref.id]?.src !== ref.dataUrl) {
        const img = new Image();
        img.onload = () => { refImageObjs[ref.id] = img; renderer.requestRender(); };
        img.src = ref.dataUrl;
      }
    });
  }, { deep: true, immediate: true });

  // 当前参考图变化时同步 opacity/scale
  watch(referenceImage, (refImg) => {
    if (refImg?.opacity !== undefined) refOpacity.value = refImg.opacity;
    if (refImg?.scale !== undefined) refScale.value = refImg.scale;
  }, { deep: true });

  // 加载参考图（Electron 主进程读取文件 → base64 dataURL）
  async function importReferenceImage() {
    if (!props.planet) return;
    refImageLoading.value = true;
    try {
      const result = await window.sitianAPI.selectReferenceImage();
      if (result?.success && result.dataUrl) {
        const img = new Image();
        img.onload = () => {
          const scale = 1200 / img.width;
          const cx = renderer.getViewTransform();
          const center = { x: -cx.x / cx.scale, y: -cx.y / cx.scale };
          const list = currentMapData.value.referenceImages || [];
          const refImage = {
            id: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            name: `底图 ${list.length + 1}`,
            dataUrl: result.dataUrl,
            opacity: refOpacity.value,
            locked: false,
            offsetX: center.x,
            offsetY: center.y,
            scale,
            width: img.width,
            height: img.height,
          };
          store.updateReferenceImage(props.planet.id, refImage);
          activeRefIndex.value = (currentMapData.value.referenceImages || []).length - 1;
          refImageObjs[refImage.id] = img;
          emit('dirty', true);
          refImageLoading.value = false;
        };
        img.onerror = () => {
          refImageLoading.value = false;
          alert('图片加载失败');
        };
        img.src = result.dataUrl;
      } else {
        refImageLoading.value = false;
      }
    } catch (e) {
      console.error('importReferenceImage failed:', e);
      refImageLoading.value = false;
    }
  }

  function updateRefOpacity() {
    if (!referenceImage.value) return;
    store.updateReferenceImage(props.planet.id, {
      ...referenceImage.value,
      opacity: refOpacity.value,
    });
    emit('dirty', true);
  }

  function updateRefScale() {
    if (!referenceImage.value) return;
    const s = Number(refScale.value);
    if (!Number.isFinite(s) || s <= 0) return;
    store.updateReferenceImage(props.planet.id, {
      ...referenceImage.value,
      scale: s,
    });
    emit('dirty', true);
  }

  function rotateRefImage() {
    if (!referenceImage.value) return;
    store.updateReferenceImage(props.planet.id, {
      ...referenceImage.value,
      rotation: ((referenceImage.value.rotation || 0) + 1) % 4,
    });
    emit('dirty', true);
  }

  function flipRefImageH() {
    if (!referenceImage.value) return;
    store.updateReferenceImage(props.planet.id, {
      ...referenceImage.value,
      flipH: !referenceImage.value.flipH,
    });
    emit('dirty', true);
  }

  function toggleRefLocked() {
    if (!referenceImage.value) return;
    store.updateReferenceImage(props.planet.id, {
      ...referenceImage.value,
      locked: !referenceImage.value.locked,
    });
    if (referenceImage.value.locked) refDragMode.value = false;
    emit('dirty', true);
  }

  function removeReferenceImage() {
    const ref = referenceImage.value;
    if (!ref) return;
    if (!confirm('确定移除该参考底图？')) return;
    store.removeReferenceImageById(props.planet.id, ref.id);
    delete refImageObjs[ref.id];
    refDragMode.value = false;
    emit('dirty', true);
  }

  function removeRefListItem(idx) {
    const ref = referenceImages.value[idx];
    if (!ref) return;
    if (!confirm(`删除底图「${ref.name || '底图 ' + (idx + 1)}」？`)) return;
    store.removeReferenceImageById(props.planet.id, ref.id);
    delete refImageObjs[ref.id];
    if (activeRefIndex.value >= referenceImages.value.length) {
      activeRefIndex.value = Math.max(0, referenceImages.value.length - 1);
    }
    refDragMode.value = false;
    emit('dirty', true);
  }

  // ===== 两点校准 =====
  function startCalibration() {
    if (!referenceImage.value) return;
    calibrationMode.value = !calibrationMode.value;
    calibrationPoints.value = [];
  }

  function handleCalibrationClick(worldX, worldY) {
    if (!calibrationMode.value) return false;
    calibrationPoints.value.push({ x: worldX, y: worldY });
    renderer.requestRender();
    if (calibrationPoints.value.length >= 2) {
      const p1 = calibrationPoints.value[0];
      const p2 = calibrationPoints.value[1];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const targetPxPerKm = 100;
      const targetScale = (calibrationDist.value * targetPxPerKm) / dist;

      const ref = referenceImage.value;
      const oldScale = ref.scale || 1;
      const newScale = oldScale * targetScale;

      const midWorldX = (p1.x + p2.x) / 2;
      const midWorldY = (p1.y + p2.y) / 2;
      const oldCx = ref.offsetX;
      const oldCy = ref.offsetY;

      store.updateReferenceImage(props.planet.id, {
        ...ref,
        scale: newScale,
        offsetX: oldCx + (midWorldX - oldCx) * (1 - targetScale),
        offsetY: oldCy + (midWorldY - oldCy) * (1 - targetScale),
        ppm: targetPxPerKm,
        calibrated: true,
      });

      calibrationMode.value = false;
      calibrationPoints.value = [];
      emit('dirty', true);
    }
    return true;
  }

  return {
    showRefImagePanel,
    refImageLoading,
    refDragMode,
    showExtraLayers,
    refOpacity,
    refScale,
    activeRefIndex,
    referenceImages,
    referenceImage,
    refImageObjs,
    calibrationMode,
    calibrationPoints,
    calibrationDist,
    importReferenceImage,
    updateRefOpacity,
    updateRefScale,
    rotateRefImage,
    flipRefImageH,
    toggleRefLocked,
    removeReferenceImage,
    removeRefListItem,
    startCalibration,
    handleCalibrationClick,
  };
}
