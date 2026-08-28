// E3: 多选对齐与分布 — 纯函数计算，不触碰响应式状态，由调用方负责 undo
// item 形如 { id, x, y }（调用方把节点坐标展开为该结构）

// bbox: { minX, minY, maxX, maxY }
export function getBBox(items) {
  if (!items.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x);
    maxY = Math.max(maxY, it.y);
  }
  return { minX, minY, maxX, maxY };
}

// mode: left | hcenter | right | top | vcenter | bottom
// 返回 [{ id, x, y }] 目标位置数组；原地对齐（bbox 由选中集自身决定）
export function alignItems(items, mode) {
  const bbox = getBBox(items);
  if (!bbox || items.length < 2) return [];
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const xFor = (it) =>
    mode === 'left' ? bbox.minX
    : mode === 'right' ? bbox.maxX
    : mode === 'hcenter' ? cx - (it.w ? it.w / 2 : 0)
    : it.x;
  const yFor = (it) =>
    mode === 'top' ? bbox.minY
    : mode === 'bottom' ? bbox.maxY
    : mode === 'vcenter' ? cy - (it.h ? it.h / 2 : 0)
    : it.y;
  return items.map((it) => ({ id: it.id, x: xFor(it), y: yFor(it) }));
}

// axis: 'h' | 'v' — 选中集两端固定，中间等间距
export function distributeItems(items, axis) {
  if (items.length < 3) return [];
  const sorted = [...items].sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = axis === 'h' ? last.x - first.x : last.y - first.y;
  const step = span / (sorted.length - 1);
  return sorted.map((it, i) => (
    axis === 'h'
      ? { id: it.id, x: first.x + step * i, y: it.y }
      : { id: it.id, x: it.x, y: first.y + step * i }
  ));
}

// 应用目标位置，返回变更列表 [{ id, fromX, fromY, toX, toY }]
export function diffPositions(items, targets) {
  const map = new Map(items.map((it) => [it.id, it]));
  return targets
    .map((t) => {
      const it = map.get(t.id);
      if (!it) return null;
      if (it.x === t.x && it.y === t.y) return null;
      return { id: t.id, fromX: it.x, fromY: it.y, toX: t.x, toY: t.y };
    })
    .filter(Boolean);
}
