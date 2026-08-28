// E1: 克隆/复制粘贴共享工具
// id 生成用序列计数器（红线 1：禁止 Math.random；Date.now 同帧多对象会撞，加序列后缀）

let serial = 0;

export function nextCloneSerial() {
  serial = (serial + 1) % 10000;
  return `${Date.now()}_${serial}`;
}

// 模块级内部剪贴板：{ kind, items, sourceView }
// kind: 'places'（geodata 节点）| 'markers' | 'textLabels' | 'areaMarkers' | 'areaTextLabels'
// 不污染系统剪贴板，不写 Markdown（红线 2）
const clipboard = { kind: null, items: null, sourceView: null };

export function setClipboard(kind, items, sourceView) {
  clipboard.kind = kind;
  clipboard.items = items.map((item) => JSON.parse(JSON.stringify(item))); // 深拷贝快照
  clipboard.sourceView = sourceView;
}

export function getClipboard() {
  if (!clipboard.kind || !clipboard.items?.length) return null;
  return { kind: clipboard.kind, items: clipboard.items, sourceView: clipboard.sourceView };
}

export function clearClipboard() {
  clipboard.kind = null;
  clipboard.items = null;
  clipboard.sourceView = null;
}

// 深拷贝单个对象并生成新 id；deltaX/Y 为粘贴偏移（画布坐标）
export function cloneItem(item, deltaX = 0, deltaY = 0) {
  const copy = JSON.parse(JSON.stringify(item));
  copy.id = `${copy.id}_c${nextCloneSerial()}`;
  if (typeof copy.x === 'number') {
    copy.x += deltaX;
    copy.y += deltaY;
  } else if (copy.coordinate) {
    copy.coordinate = { ...copy.coordinate, x: copy.coordinate.x + deltaX, y: copy.coordinate.y + deltaY };
  }
  return copy;
}
