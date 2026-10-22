// utils/scenarioEventLedger.js
// 历史剧本「事件账本」的**纯函数层**（2026-10-22，三刀序列·第一刀）
//
// 它与既有的两层账本是什么关系（先读这段，别再加第三套）：
//   · `scenario.changeEvents[provinceId] = [{y,m,d,owner}]`  —— **省份归属**子账本（谁的地）。
//   · `scenario.initialOwnership + changeEvents`（v2）      —— 上面那本的「基线 + 事件」形状，
//     由 `utils/scenarioLedgerV2.js` 派生 / 校验。
//   · 本模块 = **事件/外交**子账本：`scenario.timelineEvents = [event...]`（谁和谁、什么事、起止）。
//     两本**不双写**：归属仍然只由 `changeEvents` 表达；本模块不复制一份省份归属，
//     免得又出现「改一处另两处不变」。
//
// 数据形状（照 Azgaar 的外交口径：两两关系是一张状态表，不是每国一段叙述）：
//
//   event = {
//     id: 'ev3',                     // 剧本内唯一（`makeEventId` 递增，稳定好读）
//     type: 'war',                   // 见 EVENT_TYPES
//     actors: ['pol_ou', 'pol_li'],  // 有序：vassalage/independence 用方向（actors[0] 为宗主/原主）
//     from: { y: 1348, m: 6, d: 1 }, // 必填（年即可，m/d 可 null = 该年 1 月 1 日）
//     to:   { y: 1352, m: 6, d: 1 } | null,  // 空 = 未记终止（至今）
//     title: '甲梁战争',
//     note: '',
//     data: {},                      // 类型专属（暂未使用；留给「战役结果/赔款」这类字段）
//   }
//
// 时间语义（全模块统一，改之前先想清楚）：
//   · 事件在 `[from, to)` 内生效 —— **终止当日不再生效**。
//     所以「1348-06-01 开战、1352-06-01 停战」在 1352-06-01 当天已经不是敌对；
//     同一天录一条 `peace` 就能自然接上，不会出现「和约日当天又打了一天」。
//   · `to` 为空 = 至今有效。
//   · 同一对势力、同一天有多条事件时：**账本里靠后的那条生效**（`sortEvents` 按 from 稳定排序，
//     同日保持录入顺序）。这条是刻意选的：录入顺序就是人的意图顺序，且重载后不变。
//     ⚠️ 同日冲突不会因此被掩盖 —— `findConflicts` 会单独报出来（写入口也拦）。
//
// ⚠️ 本模块只做纯计算：不读盘、不碰 store、不改入参、不生成随机数/时间戳
//    （`createdAt`/`updatedAt` 由 store 写口补，测试才能逐字节复现）。
import {
  cmpDate, formatDate, normalizeDate, parseDateText, toOrdinal,
} from './scenarioDates';

// ============================================================
// 关系词表（Azgaar 口径：Ally / Friendly / Neutral / Suspicious / Enemy / Rival + 宗主-藩属）
// ============================================================

/** 关系原语。**值就是落盘值**（英文），中文只在 `RELATION_LABELS` 里出现一次。 */
export const RELATIONS = {
  NEUTRAL: 'Neutral',
  ALLY: 'Ally',
  FRIENDLY: 'Friendly',
  SUSPICIOUS: 'Suspicious',
  ENEMY: 'Enemy',
  RIVAL: 'Rival',
  VASSAL: 'Vassal',
  SUZERAIN: 'Suzerain',
};

/** 关系 → 中文（唯一出处：UI / 命令行 / 导出都从这里取） */
export const RELATION_LABELS = {
  Neutral: '中立',
  Ally: '同盟',
  Friendly: '友好',
  Suspicious: '猜忌',
  Enemy: '敌对',
  Rival: '竞争',
  Vassal: '藩属',
  Suzerain: '宗主',
};

/**
 * 关系「阵营」—— 只用来判冲突，不参与查询。
 * 同一个势力对在同一天既「同盟/友好」又「敌对/竞争」= 数据自相矛盾（真实历史里那种
 * 「明盟暗战」不是同一层语义，用户应该录两条不同类型的事件并在标题里说明，而不是让查询瞎猜）。
 */
const RELATION_CAMP = {
  Ally: 'positive',
  Friendly: 'positive',
  Enemy: 'negative',
  Rival: 'negative',
  // Vassal / Suzerain 是**支配**关系，与战争/同盟可以并存（藩属也会被宗主拉去打仗）；
  // Suspicious / Neutral 不参与冲突判定。
};

// ============================================================
// 事件类型表（唯一出处）
// ============================================================
//
// `effect`   = 该类型对「参与方两两关系」的写入值（null = 只记事，不改关系）
// `directed` = 有方向（actors[0] → actors[1]）；其余类型在**所有配对**上对称生效
// `instant`  = 一次性事件（`to` 无意义；给了只 warn，不报错 —— 用户可能想记「和约有效期」，
//              那就该用 alliance/friendship 这类有窗口的类型）
export const EVENT_TYPES = {
  war: {
    label: '战争', effect: RELATIONS.ENEMY, directed: false, instant: false, minActors: 2,
  },
  alliance: {
    label: '同盟', effect: RELATIONS.ALLY, directed: false, instant: false, minActors: 2,
  },
  friendship: {
    label: '友好', effect: RELATIONS.FRIENDLY, directed: false, instant: false, minActors: 2,
  },
  rivalry: {
    label: '宿敌', effect: RELATIONS.RIVAL, directed: false, instant: false, minActors: 2,
  },
  vassalage: {
    label: '臣属', effect: RELATIONS.SUZERAIN, directed: true, instant: false, minActors: 2,
  },
  independence: {
    label: '独立', effect: RELATIONS.NEUTRAL, directed: true, instant: true, minActors: 2,
  },
  peace: {
    label: '和约', effect: RELATIONS.NEUTRAL, directed: false, instant: true, minActors: 2,
  },
  custom: {
    // 记事**不是**一次性事件：「大旱 1348 ~ 1352」是有起止的（只是不改关系）
    label: '记事', effect: null, directed: false, instant: false, minActors: 1,
  },
};

/** 事件类型 id 列表（UI 下拉 / 校验提示用；顺序 = 界面顺序） */
export const EVENT_TYPE_LIST = Object.keys(EVENT_TYPES);

/** 类型 → 中文标签（未知类型原样返回，不吞） */
export function typeLabel(type) {
  return (EVENT_TYPES[type] && EVENT_TYPES[type].label) || String(type || '');
}

/** 关系 → 中文（未知值原样返回，不吞） */
export function relationLabel(relation) {
  return RELATION_LABELS[relation] || String(relation || '');
}

// ============================================================
// id
// ============================================================

/**
 * 下一个事件 id（`ev1` / `ev2` …）—— 确定性、可读、重载后稳定。
 * 不掺时间戳/随机数：同一天录入两条事件时，测试与 diff 才有可复现的顺序。
 * @param {Array|Set} existing 现有事件数组、id 数组或 Set
 * @param {string} prefix
 */
export function makeEventId(existing, prefix = 'ev') {
  const ids = new Set();
  if (existing instanceof Set) for (const x of existing) ids.add(String(x));
  else if (Array.isArray(existing)) {
    for (const x of existing) ids.add(String(x && typeof x === 'object' ? x.id : x));
  } else if (existing && typeof existing === 'object') {
    for (const k of Object.keys(existing)) ids.add(k);
  }
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of ids) {
    const m = id.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (ids.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

// ============================================================
// 录入（事件录入接口：谁 / 什么事 / 起 / 止）
// ============================================================

function asActorList(raw) {
  if (raw === null || raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
    .filter(Boolean);
}

function parseBoundary(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  return parseDateText(raw) || null;
}

/**
 * 校验一条事件（不复制、不改入参）。
 * @param {object} ev 事件（`from`/`to` 允许是文本，如 `'1348-06-01'`）
 * @param {{polities?:Array, era?:object, nameOf?:Function}} opts
 *        `polities` = 本剧本势力列表（`[{id,name}]` 或 id 数组）；给了才查「势力是否存在」
 * @returns {{errors:string[], warnings:string[]}}
 */
export function validateEvent(ev, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!ev || typeof ev !== 'object') return { errors: ['事件不是一个对象'], warnings };

  const type = String(ev.type || '');
  const t = EVENT_TYPES[type];
  if (!t) {
    errors.push(`未知事件类型「${type || '(空)'}」（可用：${EVENT_TYPE_LIST.join(' / ')}）`);
  }

  const actors = asActorList(ev.actors);
  if (!actors.length) errors.push('至少需要一个参与方（actors）');
  if (new Set(actors).size !== actors.length) errors.push('参与方重复（同一个势力写了两遍）');
  if (t) {
    if (actors.length < t.minActors) {
      errors.push(`${t.label} 至少需要 ${t.minActors} 个参与方，实际 ${actors.length}`);
    }
    if (t.directed && actors.length !== 2) {
      errors.push(`${t.label} 是**有方向**的：必须且只能有 2 个参与方（第一位 = 宗主 / 原主）`);
    }
  }

  const from = parseBoundary(ev.from);
  if (!from) errors.push(`起始日期无法识别：「${ev.from === undefined ? '' : ev.from}」（需要年份，如 1348 / 1348-06-01）`);
  let to = null;
  if (ev.to !== undefined && ev.to !== null && ev.to !== '') {
    to = parseBoundary(ev.to);
    if (!to) {
      errors.push(`终止日期无法识别：「${ev.to}」（留空 = 至今）`);
    } else if (from && cmpDate(to, from) < 0) {
      errors.push(`终止日期 ${formatDate(to)} 早于起始日期 ${formatDate(from)}`);
    } else if (from && cmpDate(to, from) === 0) {
      warnings.push(`起止同一天（${formatDate(from)}）：该事件的时间窗口为空，任何时刻都不会生效`);
    }
    if (t && t.instant) {
      warnings.push(`${t.label} 是一次性事件，终止日期不生效（只有起始日有意义）`);
    }
  }

  if (opts.polities) {
    const known = new Set((opts.polities || []).map((p) => String(p && typeof p === 'object' ? p.id : p)));
    for (const a of actors) {
      if (!known.has(a)) warnings.push(`参与方「${a}」不在本剧本的势力表里（可能抄错 id，或该势力还没建）`);
    }
  }

  if (opts.era && from) {
    const ys = Number(opts.era.startYear);
    const ye = Number(opts.era.endYear);
    if (Number.isFinite(ys) && Number.isFinite(ye)
        && (from.y < ys || (to ? to.y : from.y) > ye)) {
      warnings.push(`事件年份超出本剧本区间 ${ys} ~ ${ye}（跨代事件允许，但请确认放在正确的剧本里）`);
    }
  }

  return { errors, warnings };
}

/**
 * 把「录入草稿」规整成一条可落盘的事件（**写入口的唯一实现**）。
 *
 * 草稿很宽松：`from` 可以是 `'1348-06-01'`；`actors` 可以是单个 id。
 * 出参很严格：字段齐、日期已规整、id 已分配（或不覆盖传入的 id）。
 *
 * @param {object} draft
 * @param {{existing?:Array, prefix?:string, polities?:Array, era?:object, nameOf?:Function}} opts
 * @returns {{ok:boolean, event:object|null, errors:string[], warnings:string[]}}
 */
export function makeEvent(draft, opts = {}) {
  const src = draft && typeof draft === 'object' ? draft : {};
  const type = String(src.type || '').trim();
  const actors = asActorList(src.actors !== undefined ? src.actors : [src.a, src.b]);
  const from = parseBoundary(src.from);
  const to = parseBoundary(src.to);
  const candidate = {
    id: src.id ? String(src.id) : '',
    type,
    actors,
    from: from || src.from,
    to: to || (src.to === undefined || src.to === null || src.to === '' ? null : src.to),
    title: src.title ? String(src.title) : '',
    note: src.note ? String(src.note) : '',
    data: src.data && typeof src.data === 'object' ? { ...src.data } : {},
  };
  const { errors, warnings } = validateEvent(candidate, opts);
  if (errors.length) return { ok: false, event: null, errors, warnings };

  if (!candidate.id) candidate.id = makeEventId(opts.existing || [], opts.prefix || 'ev');
  if (!candidate.title) {
    const nameOf = typeof opts.nameOf === 'function' ? opts.nameOf : (id) => id;
    const label = typeLabel(type);
    const names = actors.map((a) => nameOf(a) || a);
    candidate.title = names.length > 1 ? `${names.join(' × ')}：${label}` : `${names[0]}：${label}`;
  }
  return { ok: true, event: candidate, errors: [], warnings };
}

// ============================================================
// 时间：排序 / 生效窗口 / 查询
// ============================================================

/** 稳定排序（按 `from` 升序；同日保持录入顺序 —— 后录入者生效） */
export function sortEvents(events) {
  return (Array.isArray(events) ? events : [])
    .filter((ev) => ev && typeof ev === 'object')
    .slice()
    // 手改过的文件里可能出现文本日期（`'1350-06-01'`）→ 排序/查询都要认，不能让它沉到最前
    .sort((a, b) => cmpDate(parseBoundary(a.from) || a.from, parseBoundary(b.from) || b.from));
}

/** 事件是否在 `atDate` 这一刻生效（`[from, to)`；`to` 空 = 至今） */
export function isActiveAt(ev, atDate) {
  if (!ev || typeof ev !== 'object') return false;
  // `atDate` 允许文本（`'1350-06-01'` / `'1350'`）—— 命令行与以后的面板都直接喂用户输入
  const at = toOrdinal(parseBoundary(atDate));
  if (!Number.isFinite(at)) return false;
  const start = toOrdinal(parseBoundary(ev.from));
  if (!Number.isFinite(start) || at < start) return false;
  if (ev.to === null || ev.to === undefined || ev.to === '') return true;
  const end = toOrdinal(parseBoundary(ev.to));
  if (!Number.isFinite(end)) return false;
  return at < end;
}

/** 某日仍在生效的事件（按时间顺序；可选按类型过滤） */
export function activeEventsAt(events, atDate, { types = null } = {}) {
  const allow = types ? new Set(types) : null;
  return sortEvents(events).filter((ev) => {
    if (allow && !allow.has(ev.type)) return false;
    return isActiveAt(ev, atDate);
  });
}

/**
 * 一个事件对「参与方两两关系」的写入清单。
 * 对称类型返回所有配对（正反两个方向各一条），有方向类型返回主从两条。
 * @returns {Array<{a:string,b:string,relation:string}>}
 */
export function eventEffects(ev) {
  const t = EVENT_TYPES[ev && ev.type];
  if (!t || !t.effect) return [];
  const actors = asActorList(ev.actors);
  if (actors.length < 2) return [];
  if (t.directed) {
    const [a, b] = actors;
    return [
      { a, b, relation: t.effect },
      // 臣属：actors[0] 在 actors[1] 眼里是宗主；独立/和约：两个方向都是中立
      { a: b, b: a, relation: t.effect === RELATIONS.SUZERAIN ? RELATIONS.VASSAL : t.effect },
    ];
  }
  const out = [];
  for (let i = 0; i < actors.length; i++) {
    for (let j = i + 1; j < actors.length; j++) {
      out.push({ a: actors[i], b: actors[j], relation: t.effect });
      out.push({ a: actors[j], b: actors[i], relation: t.effect });
    }
  }
  return out;
}

const NEUTRAL_RESULT = {
  relation: RELATIONS.NEUTRAL,
  label: RELATION_LABELS[RELATIONS.NEUTRAL],
  since: null,
  until: null,
  eventId: null,
  title: '',
  type: null,
  known: false,
};

function resultFor(ev, relation) {
  if (!ev) return { ...NEUTRAL_RESULT };
  return {
    relation,
    label: relationLabel(relation),
    since: normalizeDate(ev.from),
    until: ev.to ? normalizeDate(ev.to) : null,
    eventId: ev.id !== undefined ? String(ev.id) : null,
    title: ev.title || '',
    type: ev.type || null,
    known: true,
  };
}

/**
 * 「`atDate` 这一刻，A 和 B 是什么关系」—— 本模块的**主查询**。
 *
 * 规则：所有对该**有序对** (A, B) 生效的事件里，**最后录入的那条**生效
 * （排序按 from 升序、同日按录入顺序）。`to` 到期的战争不再生效 → 自动回落到
 * 更早的、仍在有效期内的关系（如更早的同盟），没有就返回中立。
 *
 * @returns {{relation:string, label:string, since:object|null, until:object|null,
 *            eventId:string|null, title:string, type:string|null, known:boolean}}
 *   `known=false` 表示「账本里没有任何一条针对这一对的关系事件」（= 中立，但不等于「确定和平」）
 */
export function relationBetween(events, a, b, atDate) {
  const pa = a === null || a === undefined ? '' : String(a);
  const pb = b === null || b === undefined ? '' : String(b);
  if (!pa || !pb || pa === pb) return { ...NEUTRAL_RESULT };
  const at = parseBoundary(atDate);
  if (!at) return { ...NEUTRAL_RESULT };

  let best = null;
  let bestRelation = RELATIONS.NEUTRAL;
  for (const ev of sortEvents(events)) {
    for (const eff of eventEffects(ev)) {
      if (eff.a !== pa || eff.b !== pb) continue;
      if (!isActiveAt(ev, at)) continue;
      // 升序遍历 → 最后一条生效（同日按录入顺序，见文件头「时间语义」）
      best = ev;
      bestRelation = eff.relation;
    }
  }
  return resultFor(best, bestRelation);
}

/**
 * 某日**所有**非中立关系（对称事件只报一次；有方向的按 (A,B) 方向各报一次）。
 * @returns {{pairs:Array, byPolity:Object}}
 *   `pairs`   = `[{a, b, relation, label, since, until, eventId, title, type}]`
 *   `byPolity`= `{ polityId: { otherId: pair } }`
 */
export function relationsAt(events, atDate, { polityIds = null } = {}) {
  const allow = polityIds ? new Set((polityIds || []).map(String)) : null;
  const matrix = {};
  for (const ev of sortEvents(events)) {
    if (!isActiveAt(ev, atDate)) continue;
    for (const eff of eventEffects(ev)) {
      if (allow && (!allow.has(eff.a) || !allow.has(eff.b))) continue;
      if (eff.relation === RELATIONS.NEUTRAL) {
        if (matrix[eff.a]) delete matrix[eff.a][eff.b];
        continue;
      }
      (matrix[eff.a] || (matrix[eff.a] = {}))[eff.b] = {
        a: eff.a,
        b: eff.b,
        relation: eff.relation,
        label: relationLabel(eff.relation),
        since: normalizeDate(ev.from),
        until: ev.to ? normalizeDate(ev.to) : null,
        eventId: ev.id !== undefined ? String(ev.id) : null,
        title: ev.title || '',
        type: ev.type || null,
      };
    }
  }
  const pairs = [];
  for (const a of Object.keys(matrix)) {
    for (const b of Object.keys(matrix[a])) pairs.push(matrix[a][b]);
  }
  return { pairs, byPolity: matrix };
}

/** 事件是否「有有效期窗口」（战争/同盟/臣属…）；和约/独立/记事是一次性或纯记录 */
export function isWindowEvent(ev) {
  const t = ev && EVENT_TYPES[ev.type];
  return !!(t && !t.instant);
}

/** 一天文案：`1348-06-01 ~ 1352-06-01` / `1348-06-01 起` */
export function formatEventSpan(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const from = formatDate(ev.from);
  if (!from) return '';
  const to = ev.to ? formatDate(ev.to) : '';
  return to ? `${from} ~ ${to}` : `${from} 起`;
}

/**
 * 与这一对势力**有关**的全部事件（不论是否生效中；按时间升序）。
 * 查询「去年那场仗打完没有」、命令行列「涉及这两方的事件」都用它。
 */
export function eventsBetween(events, a, b) {
  const pa = String(a);
  const pb = String(b);
  return sortEvents(events).filter((ev) => {
    const actors = asActorList(ev.actors).map(String);
    return actors.includes(pa) && actors.includes(pb);
  });
}

/**
 * 「X 年 A 和 B 什么关系」的一句话答案（UTF-8 中文；命令行与以后的面板共用）。
 * @param {object} opts `{ nameOf?:Function, names?:Object }`
 */
export function describeRelation(events, a, b, atDate, opts = {}) {
  const nameOf = typeof opts.nameOf === 'function'
    ? opts.nameOf
    : (id) => (opts.names && opts.names[id]) || id;
  const at = parseBoundary(atDate);
  const day = at ? formatDate(at) : String(atDate);
  const r = relationBetween(events, a, b, at);
  const na = nameOf(a) || a;
  const nb = nameOf(b) || b;
  if (!r.eventId) {
    // 没有**生效中**的事件 ≠ 没有记录：那场仗可能已经打完了。
    // 直接把「最近一条已终止的事件」说出来，比回一句「中立」有用得多。
    const past = eventsBetween(events, a, b)
      .filter((ev) => at && cmpDate(ev.from, at) <= 0)
      .pop();
    if (past) {
      return `${day} 时，${na} 与 ${nb} 之间没有生效中的关系事件`
        + `（此前最近一条：${typeLabel(past.type)}「${past.title || past.id}」${formatEventSpan(past)}，已终止）。`;
    }
    return `${day} 时，${na} 与 ${nb} 之间没有已记录的关系事件（中立）。`;
  }
  const what = `${typeLabel(r.type)}${r.title ? `「${r.title}」` : ''}`;
  // 中立但来自事件（和约 / 独立）：说清「为什么中立」，别让用户以为是没数据
  if (r.relation === RELATIONS.NEUTRAL) {
    return `${day} 时，${na} 与 ${nb}：中立（${what}，${formatEventSpan({ from: r.since, to: r.until })}）。`;
  }
  return `${day} 时，${na} 与 ${nb}：${relationLabel(r.relation)}（${what}，${formatEventSpan({ from: r.since, to: r.until })}）。`;
}

// ============================================================
// 冲突 / 完整性检查（写入口在拦，但读入口也要能报）
// ============================================================

/**
 * 找出账本里的问题（**只报不改**）。
 *
 * 判据分层：
 *   · `error`   —— 这条数据本身不成立（缺年份 / 起止颠倒 / 未知类型 / 同一 id 两条）。
 *   · `warning` —— 数据能读，但很可能是录错（势力不存在 / 年份越界 / 同日自相矛盾 / 完全重复）。
 *
 * @returns {{errors:Array, warnings:Array}} 每条 `{code, message, eventIds:[]}`
 */
export function findConflicts(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const errors = [];
  const warnings = [];
  const seenIds = new Map();
  const valid = [];

  list.forEach((ev, i) => {
    const at = `${i + 1} 条`;
    const { errors: e, warnings: w } = validateEvent(ev, opts);
    const label = (ev && (ev.title || ev.id)) ? `${at}（${ev.title || ev.id}）` : at;
    for (const msg of e) errors.push({ code: 'invalid-event', message: `${label}：${msg}`, eventIds: ev && ev.id ? [String(ev.id)] : [] });
    for (const msg of w) warnings.push({ code: 'suspicious-event', message: `${label}：${msg}`, eventIds: ev && ev.id ? [String(ev.id)] : [] });
    if (!e.length) valid.push(ev);
    if (ev && typeof ev === 'object' && ev.id !== undefined && ev.id !== null && ev.id !== '') {
      const id = String(ev.id);
      if (seenIds.has(id)) {
        errors.push({
          code: 'duplicate-id',
          message: `事件 id「${id}」重复（第 ${seenIds.get(id)} 条与第 ${i + 1} 条）`,
          eventIds: [id],
        });
      } else seenIds.set(id, i + 1);
    }
  });

  // 同一对势力、时间窗交叠、阵营相反 → 自相矛盾
  // ⚠️ 对称事件会生成两个方向的效果，同一条冲突会被正反各命中一次 → 按「无序对 + 两条事件」去重
  const reported = new Set();
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const A = valid[i];
      const B = valid[j];
      const ea = eventEffects(A);
      const eb = eventEffects(B);
      for (const x of ea) {
        const y = eb.find((z) => z.a === x.a && z.b === x.b);
        if (!y) continue;
        const pairKey = [x.a, x.b].sort().join('×');
        const key = `${i}|${j}|${pairKey}`;
        if (reported.has(key)) continue;
        reported.add(key);
        const ca = RELATION_CAMP[x.relation];
        const cb = RELATION_CAMP[y.relation];
        if (!ca || !cb || ca === cb) continue;
        if (!windowsOverlap(A, B)) continue;
        const pair = `${x.a} × ${x.b}`;
        warnings.push({
          code: 'conflicting-relations',
          message: `${pair} 在时间上重叠的两条事件关系相反：`
            + `${typeLabel(A.type)}「${A.title || A.id}」(${formatEventSpan(A)}) 对 `
            + `${typeLabel(B.type)}「${B.title || B.id}」(${formatEventSpan(B)})`,
          eventIds: [A.id, B.id].filter((v) => v !== undefined).map(String),
        });
      }
    }
  }

  // 完全重复（同类型 / 同参与方 / 同起止 / 同标题）= 多半是点了两次
  const seen = new Map();
  for (const ev of valid) {
    const key = [
      ev.type, asActorList(ev.actors).join('|'), formatDate(ev.from), ev.to ? formatDate(ev.to) : '',
      ev.title || '',
    ].join('¶');
    if (seen.has(key)) {
      warnings.push({
        code: 'duplicate-event',
        message: `两条事件完全相同：「${ev.title || ev.id}」（${formatEventSpan(ev)}）`,
        eventIds: [seen.get(key), ev.id].filter((v) => v !== undefined && v !== null).map(String),
      });
    } else seen.set(key, ev.id === undefined ? null : String(ev.id));
  }

  return { errors, warnings };
}

function windowsOverlap(a, b) {
  const aStart = toOrdinal(parseBoundary(a.from));
  const bStart = toOrdinal(parseBoundary(b.from));
  const aEnd = a.to ? toOrdinal(parseBoundary(a.to)) : Infinity;
  const bEnd = b.to ? toOrdinal(parseBoundary(b.to)) : Infinity;
  if (!Number.isFinite(aStart) || !Number.isFinite(bStart)) return false;
  return aStart < bEnd && bStart < aEnd;
}

/** 账本清点（命令行 / 以后的面板用） */
export function ledgerStats(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const byType = {};
  let ongoing = 0;
  let invalid = 0;
  for (const ev of list) {
    byType[ev && ev.type] = (byType[ev && ev.type] || 0) + 1;
    const t = ev && EVENT_TYPES[ev.type];
    // 「至今未终」只对**有窗口**的类型有意义（和约/独立是一次性事件，记了终止日也不生效）
    if (t && !t.instant && (ev.to === null || ev.to === undefined || ev.to === '')) ongoing++;
    if (!ev || validateEvent(ev, opts).errors.length) invalid++;
  }
  const { errors, warnings } = findConflicts(list, opts);
  return { total: list.length, byType, ongoing, invalid, errors: errors.length, warnings: warnings.length };
}

/** 取某剧本的事件表（容错：没录过 = 空数组，**不**返回 undefined） */
export function timelineEventsOf(scenario) {
  return Array.isArray(scenario && scenario.timelineEvents) ? scenario.timelineEvents : [];
}

/**
 * 追加一条事件（纯函数，返回新数组；store 写口在 `execute` 的 redo 里调它）。
 * @returns {{ok:boolean, events:Array, event:object|null, errors:string[], warnings:string[]}}
 */
export function appendEvent(scenario, draft, opts = {}) {
  const existing = timelineEventsOf(scenario);
  const made = makeEvent(draft, { ...opts, existing });
  if (!made.ok) return { ok: false, events: existing, event: null, errors: made.errors, warnings: made.warnings };
  return { ok: true, events: [...existing, made.event], event: made.event, errors: [], warnings: made.warnings };
}

/**
 * 替换一条事件（按 id）。找不到 = `ok:false, reason:'missing'`（不静默新建）。
 * @returns {{ok:boolean, events:Array, event:object|null, reason?:string, errors?:Array, warnings?:Array}}
 */
export function replaceEvent(scenario, eventId, patch, opts = {}) {
  const existing = timelineEventsOf(scenario);
  const at = existing.findIndex((ev) => ev && String(ev.id) === String(eventId));
  if (at < 0) return { ok: false, events: existing, event: null, reason: 'missing', errors: [], warnings: [] };
  const merged = { ...existing[at], ...(patch && typeof patch === 'object' ? patch : {}), id: existing[at].id };
  const { errors, warnings } = validateEvent(merged, opts);
  if (errors.length) return { ok: false, events: existing, event: null, errors, warnings };
  const event = {
    ...merged,
    actors: asActorList(merged.actors),
    from: parseBoundary(merged.from) || merged.from,
    to: parseBoundary(merged.to) || (merged.to === null || merged.to === undefined || merged.to === '' ? null : merged.to),
    title: merged.title ? String(merged.title) : '',
    note: merged.note ? String(merged.note) : '',
    data: merged.data && typeof merged.data === 'object' ? { ...merged.data } : {},
  };
  const events = existing.slice();
  events[at] = event;
  return { ok: true, events, event, errors: [], warnings };
}

/** 删除一条事件（按 id）；返回新数组 */
export function removeEvent(scenario, eventId) {
  const existing = timelineEventsOf(scenario);
  const events = existing.filter((ev) => !(ev && String(ev.id) === String(eventId)));
  return { ok: events.length !== existing.length, events };
}
