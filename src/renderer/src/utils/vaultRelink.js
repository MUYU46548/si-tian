// utils/vaultRelink.js — 「笔记改名 / 移动」断线检测 + 重连候选打分（纯函数，Node 可测）
//
// 背景（R15，2026-09-27 稽核）：
//   司天认亲的依据是 `sourcePath`（笔记在库里的相对路径）。笔记一改名或换目录，这个路径就失效；
//   而**项目态下知识库的 add/unlink 事件被整条拦掉**（防两套事实源混流，见 geodata 的
//   `handleNodeUpdated`），于是司天既不更新、也不提示 —— 下次「导入知识库内容」把新名当新实体
//   补进来，旧实体成孤儿（坐标与编辑成果留在旧 id 上，用户看到的是"多了一个、少了一个"）。
//
//   这正是「无 LLM 架构下所有聪明必须显式住在代码与文档里」的直接落点：机器不认识"改名"这种偏差，
//   过去由人替它补洞（自己回忆改成了什么）；本模块把那个洞变成**一份可解释的候选清单**，
//   让人只需点一下（报告定案的"修复成本 = 一次性几秒"）。
//
// 三条设计约束（都不许破）：
//   ① **只读**：本模块不改任何数据 —— 输入两份清单，输出断线与候选。写入一律由
//      `projectStore.relinkEntity` 经 undo 栈完成。
//   ② **确定性 + 可解释**：打分只用可复算的量（目录是否相同、名字最长公共子串长度）。
//      每个候选都带人类可读的理由串 —— UI 上给用户看理由，不给分数。
//   ③ **宁可少推，不可乱推**：没有把握就不标 `recommended`。乱推一条比不推更坏：
//      用户会照单全收，等于让机器替他认错亲。
//
// 与提取器的一致性：`notes[].sourcePath` 由主进程 `list-vault-notes` 产出，扫描口径必须与
// `scripts/extract-data.js` 的 `SCAN_SCOPE` 一致（`test_75` 守卫直接读两份源码比对常量）。
//
// 术语：
//   · 断线（dangling）—— 项目实体有 `sourcePath`，但库里已经没有那篇笔记（被改名 / 删除 / 移动走了）
//   · 无主（unclaimed）—— 库里有这篇笔记，但没有任何实体的 `sourcePath` 指向它（改名后的新名）
//   · 重连（relink）—— 把断线实体的 `sourcePath` 改指到无主笔记上；**id 保持不变**，
//     所以坐标、`mapData[planetId]`、`areaZones[regionId]`、`interiorData[buildingId]`
//     这些按 id 索引的编辑成果**天然全部保留**（这是刻意设计，不是巧合）。

/** 库内相对路径归一化：统一分隔符为 `/`（Windows 上是反斜杠）、去掉 `./` 前缀与首尾空白 */
export function normalizeRelPath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/^\.\/+/, '').trim().replace(/\/{2,}/g, '/');
}

/** 路径的目录部分（`''` = 库根） */
export function dirOf(relPath) {
  const p = normalizeRelPath(relPath);
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** 路径的文件名主干（去 `.md`） */
export function baseNameOf(relPath) {
  const p = normalizeRelPath(relPath);
  const seg = p.split('/').pop() || '';
  return seg.replace(/\.md$/i, '');
}

/**
 * 最长公共**子串**长度。
 * 刻意用子串而不是子序列：子序列会把「甲乙城」与「甲城乙」判成高度相似（长度 2），
 * 而人眼一看就知道那不是一个名字。中文地名恰恰以「前缀 + 层级词」为主，
 * 子串能抓住「霜寒城 → 霜寒主城」，子序列会顺带抓一堆噪声。
 * 名字都很短（≤ 30 字），朴素 DP 足够，不引入任何依赖。
 */
export function commonSubstrLen(a, b) {
  const s1 = String(a || ''), s2 = String(b || '');
  if (!s1 || !s2) return 0;
  let prev = new Array(s2.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= s1.length; i++) {
    const cur = new Array(s2.length + 1).fill(0);
    for (let j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 单个候选打分。返回 `{ score, reasons }` —— reasons 是给用户看的**理由**，不是调试信息。
 *
 * 权重取值的理由（不是拍脑袋，是可解释的排序意图）：
 *   · 同目录 +60   —— 改名最常见、目录基本不动；这是最强单信号
 *   · 名字相近 +0~30 —— 按「公共子串 ÷ 较短名长度」折算；改名多半保留原名的一部分
 *   · 互相包含 +10 —— 「霜寒城」→「霜寒城·东区」这类追加后缀
 * 同目录 + 名字完全相同的极端情形（同一目录里出现同名文件）不可能出现，故不设权重上限问题。
 */
export function scoreCandidate({ entityName = '', entityPath = '', noteName = '', notePath = '' } = {}) {
  const reasons = [];
  let score = 0;

  const ed = dirOf(entityPath);
  const nd = dirOf(notePath);
  if (ed === nd) {
    score += 60;
    reasons.push('同目录');
  }

  const en = String(entityName || baseNameOf(entityPath) || '');
  const nn = String(noteName || baseNameOf(notePath) || '');
  const c = commonSubstrLen(en, nn);
  if (c > 0) {
    const denom = Math.max(1, Math.min(en.length, nn.length));
    score += Math.round((c / denom) * 30);
    reasons.push(`名字相近（公共 ${c} 字）`);
  }
  if (en && nn && en !== nn && (en.includes(nn) || nn.includes(en))) {
    score += 10;
    reasons.push('名字互相包含');
  }

  return { score, reasons };
}

/**
 * 主入口：对账「项目实体」与「库里笔记」，产出断线清单与候选建议。
 *
 * @param {{entities?: Array|Object, notes?: Array, maxCandidates?: number}} input
 *   entities —— 项目实体（数组或 `{id: entity}` 字典都接受）；只用 `id` / `name` / `sourcePath`
 *   notes    —— 库里笔记清单（主进程 `list-vault-notes` 的 `notes`）
 * @returns {{
 *   checked: number,      参与对账的实体数（有 sourcePath 的）
 *   notes: number,        库里笔记数
 *   dangling: Array,      断线实体
 *   unclaimed: Array,     无主笔记
 *   suggestions: Object,  { [entityId]: [{sourcePath,name,dir,score,reasons,recommended}] }
 *   clean: boolean,       没有断线
 * }}
 */
export function detectBrokenLinks({ entities = [], notes = [], maxCandidates = 8 } = {}) {
  const list = Array.isArray(entities) ? entities : Object.values(entities || {});
  const noteList = (Array.isArray(notes) ? notes : [])
    .map(n => {
      const sourcePath = normalizeRelPath(n && n.sourcePath);
      return {
        sourcePath,
        name: String((n && n.name) || baseNameOf(sourcePath)),
        dir: dirOf(sourcePath),
      };
    })
    .filter(n => n.sourcePath);
  const noteByPath = new Map(noteList.map(n => [n.sourcePath, n]));

  // ── 断线：实体指向的笔记已不在库里 ──
  const claimed = new Set();
  const dangling = [];
  let checked = 0;
  for (const e of list) {
    const sp = normalizeRelPath(e && e.sourcePath);
    if (!sp) continue;              // 用户自建实体（无来源笔记）不参与对账，也不该报断线
    checked += 1;
    claimed.add(sp);
    if (!noteByPath.has(sp)) {
      dangling.push({ id: e.id, name: String((e && e.name) || ''), sourcePath: sp, dir: dirOf(sp) });
    }
  }

  // ── 无主：库里有笔记，但没有任何实体指向它 ──
  const unclaimed = noteList.filter(n => !claimed.has(n.sourcePath));

  // ── 候选：给每条断线在无主笔记里找最像的（按分数降序，同分按路径稳定排序）──
  const suggestions = {};
  for (const d of dangling) {
    const scored = unclaimed
      .map(n => {
        const { score, reasons } = scoreCandidate({
          entityName: d.name, entityPath: d.sourcePath, noteName: n.name, notePath: n.sourcePath,
        });
        return { sourcePath: n.sourcePath, name: n.name, dir: n.dir, score, reasons };
      })
      .sort((a, b) => (b.score - a.score) || String(a.sourcePath).localeCompare(String(b.sourcePath)));

    const top = scored[0];
    const second = scored[1];
    // 推荐线：绝对分够高（同目录 60 + 名字至少沾边），且明显领先第二名（否则让用户自己挑）
    const recommended = !!(top && top.score >= 70 && (!second || top.score - second.score >= 15));
    suggestions[d.id] = scored.slice(0, maxCandidates).map((c, i) => ({
      ...c,
      recommended: recommended && i === 0,
    }));
  }

  return {
    checked,
    notes: noteList.length,
    dangling,
    unclaimed,
    suggestions,
    clean: dangling.length === 0,
  };
}

/**
 * 由「候选条目」拼一句给人看的话（UI 与用例共用，避免两处各写一套措辞）。
 * 例：`同目录 + 名字相近（公共 3 字）`
 */
export function describeCandidate(cand, fallback = '不在原目录，名字也不相似') {
  if (!cand) return fallback;
  const reasons = Array.isArray(cand.reasons) ? cand.reasons.filter(Boolean) : [];
  return reasons.length ? reasons.join(' + ') : fallback;
}
