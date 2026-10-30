// utils/scenarioLayerRegistry.js — 剧本视图**渲染层注册表**（N1 接口化，2026-10-30）
//
// ── 为什么要有它（N1 的动机，写在这里省得反复解释）────────────────────────────
// `ScenarioMap.vue` 的 `renderFrame()` 是一条手写的 `if` 链：底图 / 栅格 / 海岸 / 省界 /
// 道路 / 河流 / 标注… 谁先谁后**只能靠读代码**，而且想"在整张图之上套一层质感"没有落脚点
// （每个函数各自往同一个 ctx 上画）。这条链已经在制造真实缺陷：2026-10-14 那次
// `ctx.save is not a function` 抛在中途 → 从那一行起后面全不画，用户看到"一片空白"。
//
// 注册表把顺序**变成数据**：每个层声明 `order` / `when`，`run()` 负责排序、判定、调用。
// 契约来自 `docs/plan/NEXT_STAGE_20261025`（不重新发明）：
//   { id, order, when(view, state), draw(ctx, view), cacheable, quality }
//
// 口径（判据见 `scripts/tests/unit/test_scenario_layer_registry.js`）：
//   · `order` 必须有限数；同 order 按**注册先后**稳定排序（增量迁移期两条链并存时不打乱）；
//   · `when` 缺省恒真；返回假值则**不调用** `draw`；
//   · **不做异常吞掉**：`draw` 抛就往上抛。渲染护栏在 ScenarioMap 里，这一层不假装容错
//     （吞掉异常正是"某层没画出来但没人知道"的来源）；
//   · `run()` 返回本次真正画了的层 id 列表 —— 给用例/诊断一个可断言的出口。

const DEFAULT_QUALITY = 'full';

function assertLayer(layer) {
  if (!layer || typeof layer !== 'object') throw new TypeError('layer 必须是对象');
  if (!layer.id || typeof layer.id !== 'string') throw new TypeError('layer.id 必须是非空字符串');
  if (!Number.isFinite(layer.order)) throw new TypeError(`layer(${layer.id}).order 必须是有限数`);
  if (typeof layer.draw !== 'function') throw new TypeError(`layer(${layer.id}).draw 必须是函数`);
  if (layer.when !== undefined && typeof layer.when !== 'function') {
    throw new TypeError(`layer(${layer.id}).when 必须是函数`);
  }
}

export function createLayerRegistry() {
  /** @type {Map<string, object>} 注册表（Map 保插入序，稳定排序靠它） */
  const layers = new Map();
  let seq = 0;
  /** @type {Map<string, number>} 注册序号，用于同 order 的稳定排序 */
  const bornAt = new Map();

  function register(layer) {
    assertLayer(layer);
    if (layers.has(layer.id)) throw new Error(`layer id 重复：${layer.id}`);
    const normalized = {
      id: layer.id,
      order: layer.order,
      when: layer.when || (() => true),
      draw: layer.draw,
      cacheable: layer.cacheable === true,
      quality: layer.quality || DEFAULT_QUALITY,
    };
    layers.set(layer.id, normalized);
    bornAt.set(layer.id, seq++);
    return normalized;
  }

  /** 同名覆盖（增量迁移期"新旧两条链"切换用；正常路径应该用 register + 不重复 id） */
  function replace(layer) {
    assertLayer(layer);
    const existed = layers.has(layer.id);
    const normalized = {
      id: layer.id,
      order: layer.order,
      when: layer.when || (() => true),
      draw: layer.draw,
      cacheable: layer.cacheable === true,
      quality: layer.quality || DEFAULT_QUALITY,
    };
    layers.set(layer.id, normalized);
    if (!existed) bornAt.set(layer.id, seq++);
    return normalized;
  }

  function unregister(id) {
    bornAt.delete(id);
    return layers.delete(id);
  }

  /** 当前会画的层（已排序、已过 `when`），不执行 */
  function plan(view, state) {
    const out = [];
    for (const layer of layers.values()) {
      let on = true;
      try {
        on = layer.when(view, state);
      } catch (e) {
        throw new Error(`layer(${layer.id}).when 抛错：${e && e.message}`);
      }
      if (on) out.push(layer);
    }
    return out.sort((a, b) => (a.order - b.order) || (bornAt.get(a.id) - bornAt.get(b.id)));
  }

  /** 按 order 依次画；返回真的画了的层 id（诊断/判据用） */
  function run(ctx, view, state) {
    const drawn = [];
    for (const layer of plan(view, state)) {
      layer.draw(ctx, view, state);
      drawn.push(layer.id);
    }
    return drawn;
  }

  /** 注册表形状快照（用例断言顺序用；不含函数） */
  function snapshot() {
    return [...layers.values()]
      .sort((a, b) => (a.order - b.order) || (bornAt.get(a.id) - bornAt.get(b.id)))
      .map(l => ({ id: l.id, order: l.order, cacheable: l.cacheable, quality: l.quality }));
  }

  return { register, replace, unregister, plan, run, snapshot, get size() { return layers.size; } };
}
