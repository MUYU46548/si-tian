#!/usr/bin/env node
/**
 * Node 单元测试：2026-11-03 实测反馈里那批“可用性事故”的源码闸门
 *
 * 用户这一轮的原话（按条目）：
 *   #10 “新建了一个世界，完全无法编辑，想重命名都做不到。右键没反应，点进去也没地方编辑。”
 *   #2  “涂归属一开始无法选择势力，原因不明。到处乱点又突然可以选了，疑似必须选中一个剧本。”
 *   #3  “找了五分钟没找到‘地形生成参数’，手册搜索无结果。”
 *   #4  “‘FMG 模板’同样未找到，最接近的是‘FMG 地形’，我只能猜。”
 *   #12 “（星域视图）能放大的倍数太小了，不够看。”
 *
 * 这几条的共同点：**代码其实在，但对用户不可见/不可达**。所以判据也不能只测“函数存在”，
 * 而要钉住“入口叫什么、在哪、缺前置条件时说不说人话”。这些是源码级事实，用 CDP 跑一遍
 * 要 40 秒且只在真机上才暴露 —— 这里做成秒级闸门，另由 drill/case 守真机行为。
 *
 * 用法：node scripts/tests/unit/test_usability_20261103.js
 * 退出码：0 = 全通过，1 = 有失败
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const P = (...bits) => path.join(ROOT, 'src', 'renderer', 'src', ...bits);

const F = {
  nodeDetail: P('components', 'NodeDetailPanel.vue'),
  worldSelector: P('components', 'WorldSelector.vue'),
  app: P('App.vue'),
  bridge: P('store', 'canvasBridge.js'),
  scenarioMap: P('components', 'ScenarioMap.vue'),
  galaxyMap: P('components', 'GalaxyMap.vue'),
  guide: P('utils', 'userGuide.js'),
};

/** 本仓 index=LF、工作树可能被 autocrlf 变 CRLF —— 读源码先归一化（2026-11-03 假红的来源） */
function readText(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const SRC = {};
for (const [k, p] of Object.entries(F)) SRC[k] = readText(p);

// ── 判据实现（每条都写成“对一段文本返回问题清单”，供反向探针复用同一份逻辑）──

/** #10 属性面板：项目态必须能改名（此前永远 disabled → 项目里新建的世界改不了名） */
function problemsNodeDetail(src) {
  const out = [];
  if (!src.includes('data-testid="entity-name-input"')) out.push('缺少可改名的输入框（entity-name-input）');
  if (!src.includes(':disabled="!canRenameEntity"')) out.push('名称输入框没有按“项目态”放开（仍是无条件 disabled）');
  if (!src.includes('function updateName(')) out.push('缺 updateName()：改名没有落库路径');
  if (!src.includes('renameEntityInProject(')) out.push('没走 canvasBridge.renameEntityInProject（改名不会进 undo）');
  if (/from '\.\.?\/.*store\/projectStore'/.test(src)) {
    out.push('属性面板静态 import 了 projectStore —— 会在启动时把惰性 store 拉起来（应走 canvasBridge）');
  }
  if (!src.includes('const canRenameEntity = computed(')) out.push('缺 canRenameEntity：项目态判定没有唯一来源');
  return out;
}

/** #10 世界卡：必须有改名入口（原来只有删除按钮） */
function problemsWorldSelector(src) {
  const out = [];
  if (!src.includes('data-testid="rename-world"')) out.push('世界卡上没有改名按钮（rename-world）');
  if (!src.includes("@click.stop=\"$emit('rename-world', world)\"")) out.push('改名按钮没有 emit rename-world');
  if (!src.includes("'rename-world'")) out.push('defineEmits 里没有 rename-world');
  return out;
}

/** #10 App 侧：改名必须走 canvasBridge（App 禁止 import projectStore）+ 红线复验 */
function problemsApp(src) {
  const out = [];
  if (!src.includes('@rename-world="handleRenameWorld"')) out.push('WorldSelector 的 rename-world 没接线');
  if (!src.includes('renameEntityInProject')) out.push('没有走 canvasBridge.renameEntityInProject');
  if (/from '\.\/store\/projectStore'/.test(src) || /from '\.\/store\/projectStore\.js'/.test(src)) {
    out.push('🔴 App.vue 直接 import 了 projectStore（违反 test_46/test_55 的静态闸门）');
  }
  if (!src.includes('async function handleRenameWorld(')) out.push('缺 handleRenameWorld()');
  return out;
}

/** #10 桥接层：动态 import + 未打开项目时说人话 */
function problemsBridge(src) {
  const out = [];
  if (!src.includes('export async function renameEntityInProject(')) out.push('canvasBridge 没有 renameEntityInProject 导出');
  if (!src.includes("await import('./projectStore')")) out.push('桥接没有用动态 import（会与 projectStore 形成静态环）');
  if (!src.includes("reason: 'readonly'")) out.push('未打开项目时没有给出 readonly 口径');
  return out;
}

/** #2 涂归属：缺剧本时必须说清依赖，而不是静默不干活 */
function problemsScenarioMap(src) {
  const out = [];
  if (!src.includes('data-testid="owner-brush-need-scenario"')) out.push('涂归属缺“要先有剧本”的提示节点');
  if (!src.includes('v-if="!selectedScenario"')) out.push('提示节点没有按“没选剧本”显示');
  if (!src.includes('data-testid="owner-brush-new-scenario"')) out.push('提示里没有“新建剧本”直达入口');
  if (!src.includes('“涂归属”和上方的势力色板都挂在剧本上')) {
    out.push('左栏空态没有解释“没有剧本时势力色板不出现”（用户的原话就是“原因不明”）');
  }
  return out;
}

/** #3/#4 生成入口正名：按钮可见文字必须与用户/手册里的叫法一致
 *  2026-11-05：`FMG 模板` → **现成模板**（用户反馈“看不懂 FMG 是什么”；手册里仍保留
 *  “FMG 模板 / FMG地形”作**搜索关键词**，两个叫法都能搜到 —— 见下方 #3 手册那条）。 */
function problemsGenButtons(src) {
  const out = [];
  if (!src.includes('>地形生成参数</button>')) out.push('按钮可见文字不是“地形生成参数”');
  if (!src.includes('>现成模板</button>')) out.push('模板地形入口没有可见文字（应为“现成模板”）');
  if (src.includes('>生成参数</button>')) out.push('仍残留旧名“生成参数”（手册/口耳相传都叫“地形生成参数”）');
  if (src.includes('>FMG 地形</button>') || src.includes('>FMG 模板</button>')) {
    out.push('仍残留旧名“FMG 地形 / FMG 模板”（2026-11-05 起改叫“现成模板”，FMG 只留在手册关键词里）');
  }
  return out;
}

/** #12 星域视图放大上限 */
function problemsGalaxyZoom(src) {
  const out = [];
  if (!/useCanvasRenderer\(canvas,\s*\{[\s\S]{0,300}?maxScale:\s*8,/.test(src)) {
    out.push('GalaxyMap 没有把 maxScale 提到 8（默认 3 倍就是用户说的“滚不动了”）');
  }
  return out;
}

async function main() {
  await check('#10 属性面板：项目态能改名（不再是永久 disabled）', () => {
    const bad = problemsNodeDetail(SRC.nodeDetail);
    assert(bad.length === 0, bad.join('；'));
    return '名称输入框按项目态放开，走 renameEntity（一条 undo）';
  });

  await check('#10 世界卡：有改名按钮并 emit', () => {
    const bad = problemsWorldSelector(SRC.worldSelector);
    assert(bad.length === 0, bad.join('；'));
    return '卡片上“改名 / 删除”并列';
  });

  await check('#10 App 接线：走 canvasBridge，不破“App 不得 import projectStore”', () => {
    const bad = problemsApp(SRC.app);
    assert(bad.length === 0, bad.join('；'));
    return 'App → canvasBridge →（动态 import）projectStore';
  });

  await check('#10 桥接层：动态 import + 未打开项目给 readonly', () => {
    const bad = problemsBridge(SRC.bridge);
    assert(bad.length === 0, bad.join('；'));
    return 'renameEntityInProject 已导出';
  });

  await check('#2 涂归属：缺剧本时给出依赖与两个直达入口', () => {
    const bad = problemsScenarioMap(SRC.scenarioMap);
    assert(bad.length === 0, bad.join('；'));
    return '有提示节点 + 选剧本 / 新建剧本两条路';
  });

  await check('#3/#4 生成入口正名：地形生成参数 / FMG 模板', () => {
    const bad = problemsGenButtons(SRC.scenarioMap);
    assert(bad.length === 0, bad.join('；'));
    return '两个按钮的可见文字与手册叫法一致，旧名已清';
  });

  await check('#12 星域视图：放大上限 8 倍', () => {
    const bad = problemsGalaxyZoom(SRC.galaxyMap);
    assert(bad.length === 0, bad.join('；'));
    return 'useCanvasRenderer({ maxScale: 8 })';
  });

  await check('#3 手册可搜到：地形生成参数 / FMG 模板 / FMG地形 / 造陆 / 地形注记', async () => {
    const mod = await import(pathToFileURL(F.guide).href);
    const { searchGuide } = mod;
    for (const q of ['地形生成参数', 'FMG 模板', 'FMG地形', '造陆']) {
      const hit = searchGuide(q);
      assert(hit.some((s) => s.id === 'terrain-generate'), `搜“${q}”没命中 terrain-generate（命中：${hit.map((s) => s.id).join(',') || '无'}）`);
    }
    // #8（2026-11-03 用户实测：“地形注记有什么用？怎么用？看不懂”）
    const tl = searchGuide('地形注记');
    assert(tl.some((s) => s.id === 'terrain-labels'), `搜“地形注记”没命中 terrain-labels（命中：${tl.map((s) => s.id).join(',') || '无'}）`);
    assert(searchGuide('山脊').some((s) => s.id === 'terrain-labels'), '搜“山脊”没命中地形注记节');
    return '5 个叫法都落到对应章节';
  });

  await check('红线：新增文案里不许出现直角引号（直角那对，不是中文双引号）', () => {
    const bad = [];
    // 用码点写，别在源码里留字面量 —— 否则本文件自己就成了红线的违反者
    const OPEN = '\u300c';
    const CLOSE = '\u300d';
    for (const [k, src] of Object.entries(SRC)) {
      if (src.includes(OPEN) || src.includes(CLOSE)) bad.push(F[k]);
    }
    assert(bad.length === 0, `出现直角引号：${bad.join('、')}`);
    return '7 个文件 0 处';
  });

  await check('反向探针：把旧写法喂回判据，必须变红（否则本文件是空转）', () => {
    const cases = [
      ['#10 旧属性面板', problemsNodeDetail('<input type="text" :value="node.name" disabled title="名称对应 Markdown 文件名，请在 Obsidian 中重命名" />')],
      ['#10 世界卡只有删除', problemsWorldSelector('<button class="delete-btn" @click.stop="$emit(\'delete-world\', world)">x</button>')],
      ['#10 App 直连 store', problemsApp("import { useProjectStore } from './store/projectStore';")],
      ['#2 涂归属静默', problemsScenarioMap('<div class="tool-group" v-if="tool === \'ownerBrush\'"><span class="row-label">涂归属：</span></div>')],
      ['#3 旧按钮名', problemsGenButtons('>生成参数</button>>FMG 地形</button>')],
      ['#12 默认 zoom', problemsGalaxyZoom('const renderer = useCanvasRenderer(canvas, { onRender });')],
    ];
    for (const [label, bad] of cases) {
      assert(bad.length > 0, `反向探针失败：${label} 没被报出`);
    }
    return `${cases.length} 种旧写法都被抓到`;
  });

  report();
}

function report() {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 单测自身异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
