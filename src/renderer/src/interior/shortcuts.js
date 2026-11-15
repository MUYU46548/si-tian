/**
 * 建筑内部的快捷键表（2026-11-15，台账 A27）。
 *
 * ## 为什么要有这张表
 *
 * 以前快捷键散在 `handleKeydown` 的 if 链里：Del / R / 方向键 / Esc 各写一段，谁也说不全
 * "这里到底有哪些键"。用户问"有没有快捷键"时，我只能去数代码。
 *
 * 现在：**表是唯一事实源**。`?` 打开的帮助浮层直接读它，新增键只改表 + 在组件里挂一个 action，
 * 不会出现"帮助里写了、实际没绑"（表驱动）或"实际能按、帮助里没有"（同一份数据）。
 *
 * ## 不变的纪律
 *
 * · 只做**增量**：已经验证过的那几个键（Del / R / 方向键 / Esc 分层）继续留在原处，
 *   本表只收新键 —— 不为了"统一"去重写一条已经跑绿的路径（那是拿稳定性换整洁）。
 * · 输入框里一律不触发：由调用方用 `isEditingInput` 拦住，本模块只负责匹配。
 */

/**
 * 快捷键定义。
 *
 * 字段：
 *   id       —— 组件里 dispatch 用的键（`ACTIONS[id]`）
 *   group    —— 帮助浮层的分组标题
 *   label    —— 帮助里显示的名字
 *   hint     —— 一句话说明（写人话，不写"执行 action"）
 *   keys     —— 展示用的按键数组，如 `['Ctrl', 'Z']`
 *   match    —— 匹配规则：key（小写比较）+ 修饰键开关
 *   when     —— 可选的可用条件说明（帮助里灰字显示）
 */
export const INTERIOR_SHORTCUTS = Object.freeze([
  // ── 撤销 / 重做 ──
  {
    id: 'undo', group: '编辑', label: '撤销', keys: ['Ctrl', 'Z'],
    hint: '退回上一步（改墙、放家具、改房间名都算一步）',
    match: { key: 'z', mod: true, shift: false },
  },
  {
    id: 'redo', group: '编辑', label: '重做', keys: ['Ctrl', 'Shift', 'Z'],
    hint: '把撤销掉的那一步再做回来',
    match: { key: 'z', mod: true, shift: true },
  },
  {
    id: 'redo', group: '编辑', label: '重做（另一种按法）', keys: ['Ctrl', 'Y'],
    hint: '有些键盘习惯用 Y，两个都认',
    match: { key: 'y', mod: true, shift: false },
  },

  // ── 工具 ──
  {
    id: 'tool:pan', group: '工具', label: '选择 / 拖动', keys: ['1'],
    hint: '点选家具、拖墙角（默认状态）',
    match: { key: '1', mod: false, shift: false },
  },
  {
    id: 'tool:add_wall', group: '工具', label: '画墙', keys: ['2'],
    hint: '点两下画一面墙；按住 Shift 走直角；Esc 结束这一段',
    match: { key: '2', mod: false, shift: false },
  },
  {
    id: 'tool:add_door', group: '工具', label: '放门', keys: ['3'],
    hint: '点在墙上放一扇门',
    match: { key: '3', mod: false, shift: false },
  },
  {
    id: 'tool:add_window', group: '工具', label: '放窗', keys: ['4'],
    hint: '点在墙上放一扇窗',
    match: { key: '4', mod: false, shift: false },
  },
  {
    id: 'tool:add_stairs', group: '工具', label: '画楼梯', keys: ['5'],
    hint: '点两下画一跑楼梯：第一下是起步点，第二下是爬到哪；级数按层高自动算，上一层楼板自动开洞',
    match: { key: '5', mod: false, shift: false },
  },
  {
    id: 'tool:add_column', group: '工具', label: '放柱', keys: ['6'],
    hint: '点一下放一根柱；柱从本层地面长到本层墙顶，截面在工具条里选 30/40/60/80cm',
    match: { key: '6', mod: false, shift: false },
  },
  {
    id: 'tool:add_hole', group: '工具', label: '画楼板洞口', keys: ['7'],
    hint: '点两下画一个矩形洞（检修口 / 挑空）；本层楼板会被切出这个洞，楼上能看见楼下',
    match: { key: '7', mod: false, shift: false },
  },

  // ── 视图 ──
  {
    id: 'view:fit', group: '视图', label: '铺满画布', keys: ['F'],
    hint: '把整层楼缩放到刚好填满画布（手抖动弄丢视角时按这个）',
    match: { key: 'f', mod: false, shift: false },
  },
  {
    id: 'view:grid', group: '视图', label: '网格吸附开关', keys: ['G'],
    hint: '关掉后落点只做对齐吸附，不再咬 40cm 网格',
    match: { key: 'g', mod: false, shift: false },
  },
  {
    id: 'view:dims', group: '视图', label: '尺寸标注开关', keys: ['M'],
    hint: '每面墙中点显示长度；图面太挤时可以关',
    match: { key: 'm', mod: false, shift: false },
  },

  // ── 帮助 ──
  {
    id: 'help', group: '帮助', label: '快捷键一览', keys: ['?'],
    hint: '打开这张表（再按一次或 Esc 关闭）',
    match: { key: '?', mod: false, shift: true },
  },
  {
    id: 'help', group: '帮助', label: '快捷键一览', keys: ['F1'],
    hint: '同 ?（有些键盘打不出问号）',
    match: { key: 'f1', mod: false, shift: false },
  },
]);

/** 把一条定义渲染成 "Ctrl+Shift+Z" 这种展示串 */
export function describeKeys(entry) {
  return (entry && entry.keys ? entry.keys : []).join('+');
}

function normKey(raw) {
  const k = String(raw == null ? '' : raw);
  // 单个字母统一小写；其余（F1 / Escape / ? / 数字）保持原样再小写
  return k.length === 1 ? k.toLowerCase() : k.toLowerCase();
}

/**
 * 事件是否命中某条快捷键。
 *
 * 规则（都是踩过的坑）：
 *   · `mod` = Ctrl 或 Meta（mac 用 Cmd；Windows 上 Cmd 键不存在，等价于 Ctrl）；
 *   · `shift` 显式声明 —— 不写默认**必须没按 Shift**，否则 Ctrl+Shift+Z 会同时命中 Ctrl+Z；
 *   · 匹配时要求 Ctrl/Alt/Meta 状态与声明**完全一致**：声明 `mod:false` 时按着 Ctrl 不许触发
 *     （否则 Ctrl+C 之类会被当成工具切换）。
 *
 * @param {KeyboardEvent|{key:string,ctrlKey?:boolean,metaKey?:boolean,shiftKey?:boolean,altKey?:boolean}} e
 * @param {object} entry `INTERIOR_SHORTCUTS` 的一项
 */
export function matchShortcut(e, entry) {
  const m = (entry && entry.match) || {};
  if (!e) return false;
  if (normKey(e.key) !== normKey(m.key)) return false;

  const hasMod = !!(e.ctrlKey || e.metaKey);
  const wantMod = !!m.mod;
  if (hasMod !== wantMod) return false;

  // Alt 一律不参与（Alt+字母在部分输入法下是特殊字符）
  if (e.altKey) return false;

  const wantShift = !!m.shift;
  const hasShift = !!e.shiftKey;
  // 唯一例外：`?` 在多数键盘上本身就是 Shift+/，所以 shift 必须为真才匹配；
  // 反过来，声明 shift:false 的条目遇到 shift 按下就不算命中。
  return hasShift === wantShift;
}

/** 在一个表里找命中的第一个定义（找不到返回 null） */
export function findShortcut(e, table = INTERIOR_SHORTCUTS) {
  for (const entry of table) {
    if (matchShortcut(e, entry)) return entry;
  }
  return null;
}

/** 帮助浮层用的分组结构：[{ group, items:[entry…] }]（保持表里的顺序） */
export function groupShortcuts(table = INTERIOR_SHORTCUTS) {
  const order = [];
  const map = new Map();
  for (const entry of table) {
    if (!map.has(entry.group)) {
      map.set(entry.group, []);
      order.push(entry.group);
    }
    // 同一个 id 在同一组里只列一次（redo 有两个按法，合并成一行更省地方）
    const list = map.get(entry.group);
    if (list.some((x) => x.id === entry.id)) {
      const prev = list.find((x) => x.id === entry.id);
      prev.alternates = [...(prev.alternates || []), entry.keys];
      continue;
    }
    list.push({ ...entry, alternates: [] });
  }
  return order.map((g) => ({ group: g, items: map.get(g) }));
}
