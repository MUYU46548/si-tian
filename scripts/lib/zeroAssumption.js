// scripts/lib/zeroAssumption.js — 零假设设定解析（纯函数层，Node 可测）
//
// ── 它解决什么（2026-11-07，用户第三次否掉“让用户按司天模型整理库”）────────────────
// 真实用户的库**可以没有 frontmatter、没有任何 [[双链]]、年表格式不可预知**。
// 解析器不许假设结构，只能靠三类信号：
//   ① **n-gram 词频**（名字在库里反复出现，这就是“它是个名字”的最硬证据）
//   ② **后缀校验**（`砺川共和国` / `青栎港` / `云岫山` → 高置信；无后缀的 `南共主` 靠词频）
//   ③ **谓词共现**（名字附近出现“吞并/结盟/签订/灭亡…”说明它参与了事件）
//   ④ **时间表达式**：绝对锚（`公元前 240 年`）+ 相对表达（`三年后` / `第四天`）挂到最近的绝对锚
//
// ── 走过的弯路（别回头）─────────────────────────────────────────────────────────
// 第一版用「后缀正则抓 1-6 字前缀」当名字来源 → 脏库实测假阳性 52.6%：
// 抓到的是 `与北面的砺川共和国` / `没人记得黑石关` / `火苗舔到城` —— **中文没有词边界**，
// 正则的前缀长度是猜的，猜错就吞进动词和介词。改成「**n-gram 出全名字，后缀只做校验**」后，
// 名字是从原文里**逐字匹配出来的整串**，不存在“吞前缀”这回事。
//
// ── 三条硬纪律 ────────────────────────────────────────────────────────────────
// A. **每条输出必须能引原文一行**（`evidence: {path, line, text}`）；引不到就丢弃。
//    对应既有红线：认不出进「待人工」、**不许默认成地点**——同理这里**不许默认成实体**。
// B. **证据 OR 合成**（不是 AND）：后缀+谓词 / 跨 ≥3 文件 / ≥2 个谓词，任一成立即可。
//    用 AND 会误杀“当主语但描述句没有动词”的真实体（`灰塔议会` 在 4 篇里出现却 0 谓词）。
// C. **不编造**：拿不准就 `confidence: 'low'` + `reasons`；不做“合理推断补全”。

'use strict';

// ── 谓词（关系/变化动词）────────────────────────────────────────────────────
const PREDICATES = [
  '吞并', '灭', '攻', '战', '结盟', '同盟', '盟约', '签订', '签署', '协定', '条约',
  '纳贡', '朝贡', '附庸', '归顺', '臣属', '自治', '推翻', '解散', '分裂', '合并',
  '建立', '建国', '成立', '解体', '统一', '占领', '割让', '迁', '驻',
  '隶属', '统治', '管辖', '投奔', '退守', '截', '断', '烧', '守', '签',
  '推举', '登记', '收税', '交战', '投降', '迁都', '割让', '围城', '征兵',
];

// ── 后缀（按长度降序，校验用；不参与“抓名字”）──────────────────────────────
const SUFFIXES = [
  '共和国', '合众国', '联盟', '联邦', '帝国', '王国', '公国', '汗国', '城邦',
  '王朝', '星系', '行星', '之城', '议会', '委员会', '长老会', '公会', '教会',
  '军团', '舰队', '水师', '军', '港口', '码头', '港', '河谷', '谷地', '关口',
  '要塞', '广场', '街区', '山', '河', '城', '关', '岛', '海', '平原', '沙漠', '峡',
].sort((a, b) => b.length - a.length);

/** **强后缀**：本身就是“地名/政体/组织”类型词，可以作为 high 的独立证据。
 *  真机反例：`关`/`军`/`城`/`海` 在中文里大量当普通词尾（关系 / 机关 / 将军 / 海军 / 脑海），
 *  所以把它们放进 WEAK —— 只有另有证据（跨文件或 ≥2 谓词）才收，且不给 high。 */
const STRONG_SUFFIXES = [
  '共和国', '合众国', '联盟', '联邦', '帝国', '王国', '公国', '汗国', '城邦', '王朝',
  '星系', '行星', '议会', '委员会', '长老会', '公会', '教会', '军团', '舰队',
  '港口', '河谷', '关口', '要塞', '平原', '沙漠', '山', '河', '岛', '峡', '港',
].sort((a, b) => b.length - a.length);
const WEAK_SUFFIXES = ['军', '城', '关', '海', '水师', '码头', '广场', '街区', '之城']
  .sort((a, b) => b.length - a.length);

/** 通用词：单独出现（没有前缀修饰）不是实体 */
const GENERIC = new Set([
  '王国', '共和国', '帝国', '联盟', '联邦', '城邦', '王朝', '星系', '行星', '议会',
  '委员会', '长老会', '公会', '教会', '军团', '舰队', '水师', '港口', '码头', '河谷',
  '关口', '要塞', '广场', '街区', '山', '河', '城', '关', '岛', '海', '平原', '沙漠',
  '峡', '军', '港',
]);

/** 前缀里出现这些词就不像专名 */
const STOP_PREFIX = [
  '这个', '那个', '这些', '那些', '一座', '两座', '三座', '任何', '所有', '每个', '各',
  '另一', '整个', '所谓', '这种', '那种', '一个', '两个', '三个', '这座', '那座',
  '有的', '没有', '不是', '就是', '还是', '也是', '都是', '半个', '几座', '数座',
  '小邦', '邻国', '各国', '诸国', '该国', '此国', '本国',
];

/** 功能字：出现在候选**开头**就不是名字开头；出现在中间说明候选跨了词 */
/** 名字**开头**不许出现的字（代词/连词/数字/量词等） */
const NAME_START_BAD = /[的了是在和与也都就而及这那其为被把让对从到以并且或若则又再更最很太不没无有会能可应须要让使给替跟同上下中里个些第元]/;
/** 数字开头**且**以这些量词/时间单位收尾 → 不是名字（`二年` / `三个` / `十章`）。
 *  但 `六部` / `三镇` / `七星海` 这类**是**名字，不能一刀切（上一版就是这么误杀 `六部` 的）。 */
const NUMERAL_JUNK = /^[一二三四五六七八九十百千\d]+(年|月|日|天|次|种|个|位|名|条|只|座|章|节|页|行)/;
/** 名字**中间**不许出现的字（`和/会/同/中/有/无/元` 这类是合法的 —— 共和国 / 议会 / 委员会），
 *  只挡真正跨词的虚词与指代。 */
const NAME_INNER_BAD = /[的了是而并或若则又再很太被把对从到这那其些个说讲问答做办干]/;

/** 功能词：2-4 字的代词/连词/副词 —— n-gram 会大量撞上它们（脏库实测：起来/自己/什么/他们/出来/后来） */
const FUNCTION_WORDS = [
  '起来', '出来', '进去', '回去', '过来', '下来', '上来', '自己', '什么', '怎么',
  '他们', '我们', '你们', '它们', '大家', '别人', '有人', '没人', '一个', '两个',
  '三个', '这些', '那些', '这样', '那样', '这种', '那种', '因为', '所以', '但是',
  '如果', '虽然', '然后', '还是', '只是', '就是', '不是', '可以', '东西', '时候',
  '地方', '事情', '问题', '方式', '其中', '之中', '之一', '以及', '或者', '而且',
  '并且', '因此', '于是', '另外', '其余', '后来', '当时', '现在', '以后',
];

/** 时间词：这些是**时间表达式**，不是实体（脏库实测：公元前 被当成实体抽出来） */
const TIME_WORDS = [
  '公元前', '之后', '之前', '此前', '此后', '同年', '次年', '翌年', '这一年', '那一年',
  '再往后', '起初', '前夕', '战后', '第二天', '第三天', '第四天', '第一年', '第二年',
  '第三年', '数十年', '十余年', '十二年', '三年后', '三年前',
];

/** 抽象名词/文书类型：不是“谁”，是“什么东西”（协定 / 盟约 / 编年…） */
const NON_ENTITY_NOUNS = [
  '协定', '盟约', '条约', '编年', '年表', '记录', '纪录', '名单', '铁板', '制度',
  '法令', '法律', '政策', '条款', '草案', '文件', '档案', '密令', '诏书', '檄文',
  '商队', '船队', '关城', '城楼', '山北', '山南', '越界', '反复', '已经', '关于',
  '公元', '元前', '此后', '之前', '之后', '同一', '有些', '所有', '各自', '互相',
  '执事', '长老', '议员', '首领', '执政官', '守军', '王室', '王族', '商会',
  '税吏', '水手', '工匠', 'rebellion',
];

/** 噪声黑名单（真机粗抽里的假阳性 + 排版/语气词 + 上面三类）。可由测试集假阳性继续追加。 */
const DEFAULT_BLACKLIST = new Set([
  '下一行', '上一行', '这一行', '那行', '建议行', '完成行', '修改后', '涉及行',
  '表示行', '以上', '如下', '详见', '见下', '同上', '备注', '注意', '说明', '示例',
  '本文', '本页', '本表', '本文档', '这一节', '下一节', '上一节',
  ...FUNCTION_WORDS, ...TIME_WORDS, ...NON_ENTITY_NOUNS,
]);

// ── 时间表达式 ──────────────────────────────────────────────────────────────
const ABS_PATTERNS = [
  /公元前\s*\d{1,4}\s*年/,
  /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?/,
  /\d{1,4}\s*年\s*\d{1,2}\s*月/,
  /\d{1,4}\s*年/,
  /第[一二三四五六七八九十百]+纪元/,
];
const REL_PATTERN = new RegExp([
  '同年', '次年', '翌年', '第二年', '第三年', '三年后', '数十年后', '此后十余年',
  '此后[一二三四五六七八九十百\\d]+年', '开战后第[一二三四五六七八九十百\\d]+天',
  '[一二三四五六七八九十百\\d]+年前', '第[一二三四五六七八九十\\d]+天',
  '之前', '之后', '前夕', '战后', '其后', '再往后', '后来',
  '撑了[一二三四五六七八九十\\d]+年', '当[时年]', '起初',
].join('|'), 'g');

/**
 * **文档类型识别**（格式信号，不依赖目录名 —— 用户的目录结构不可预知）。
 * 真机实测：`07 资料收藏`(4174) / `02 帮助`(1457) / `01 索引`(1206) 这些页**不该抽设定实体**，
 * 它们分别是剪报、帮助文案、索引表 —— 抽出来全是假阳性。
 *
 * @returns {'prose'|'table'|'changelog'|'list'}
 */
function classifyDocKind(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'list';
  const table = lines.filter((l) => l.startsWith('|')).length / lines.length;
  const dated = lines.filter((l) => /^[-*]?\s*\d{4}\s*[-/年]\s*\d{1,2}/.test(l)).length / lines.length;
  const bullet = lines.filter((l) => /^([-*+>]|\d+[.)])\s/.test(l)).length / lines.length;
  // 阈值要宽：**混排**的设定页（三成表格 + 七成散文）在真实库里很常见（脏库 d3 就是），
  // 一刀切会把它们整页跳过 —— 那丢的是真内容。只跳过“几乎全是表格/几乎全是日期行”的页。
  if (table >= 0.6) return 'table';
  if (dated >= 0.5) return 'changelog';
  if (bullet >= 0.85) return 'list';
  return 'prose';
}

/** 句子切分（中文标点；保留行号以便回引原文） */
function splitSentences(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  // 首行是标题（短、无标点）→ 跳过：`新建文档 1` 这种标题会在 5 个文件里重复，
  // 被 n-gram 当成“跨文件高频实体”（脏库实测就撞了这个）。
  const firstText = (lines.find((l) => l.trim()) || '').trim();
  const titleLine = firstText && firstText.length <= 20 && !/[。，；：]/.test(firstText) ? firstText : null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (titleLine && line.trim() === titleLine) continue;
    const parts = line.split(/(?<=[。！？；])/).filter((s) => s.trim());
    for (const p of parts) out.push({ line: i + 1, text: p.trim() });
  }
  return out;
}

/** 名字附近（±window 字）出现哪些谓词 */
function predicatesNear(text, index, nameLen, window = 24) {
  const from = Math.max(0, index - window);
  const to = Math.min(text.length, index + nameLen + window);
  const slice = text.slice(from, to);
  return PREDICATES.filter((p) => slice.includes(p));
}

function hasPredicateNear(text, index, nameLen, window = 24) {
  return predicatesNear(text, index, nameLen, window).length > 0;
}

/** 后缀校验：返回命中的后缀（长优先），没有返回 null。强/弱两档见 STRONG_SUFFIXES 的说明。 */
function suffixOf(name) {
  const strong = STRONG_SUFFIXES.find((x) => name.endsWith(x) && name.length > x.length);
  if (strong) return strong;
  const weak = WEAK_SUFFIXES.find((x) => name.endsWith(x) && name.length > x.length);
  return weak || null;
}

/** 这个后缀算不算强后缀（只有强后缀才允许给 high） */
function isStrongSuffix(suffix) {
  return !!suffix && STRONG_SUFFIXES.includes(suffix);
}

/** 以这些“量词性名词尾”收尾的候选不是专名（板/字/队/兵/船/车/块/片…） */
const COMMON_NOUN_TAIL = /(板|字|队|兵|船|车|块|片|条|根|张|面|件|样|些|种|堆|群|批|套|副|铁|木|石|泥|沙|盐|铜|银|布|纸|碗|盘|罐|箱|柜)$/;

/** 名字是否该被否掉 */
function isJunkName(name, blacklist = DEFAULT_BLACKLIST) {
  if (!name || name.length < 2) return true;
  if (name.length > 10) return true;
  if (GENERIC.has(name)) return true;
  if (blacklist.has(name)) return true;
  if (STOP_PREFIX.some((p) => name.startsWith(p))) return true;
  if (/^\d+$/.test(name)) return true;
  if (NAME_START_BAD.test(name[0])) return true;           // 以功能字开头 = 跨词了
  if (NUMERAL_JUNK.test(name)) return true;                 // 数字+量词（二年/三个）
  if (PREDICATES.includes(name)) return true;               // 候选本身就是谓词（推举/退守）
  if (COMMON_NOUN_TAIL.test(name)) return true;             // 量词性名词尾（薄铁板/商队）
  if (/^[一二三四五六七八九十百千\d]+$/.test(name)) return true;
  return false;
}

/**
 * **实体抽取（唯一实现）**：两遍扫描 + 子串遮蔽去重 + OR 合成证据。
 *
 * 🔴 为什么是两遍（2026-11-07 真机教训）：第一版对**每个 gram 的每次出现**都算谓词窗口，
 * 再对所有候选做 O(n²) 的“谁包含谁”——1373 篇的库上跑 **>10 分钟没跑完**。
 * 现在：第 1 遍只数频次（Map 查写），把几百万个 gram 砍到“出现 ≥2 次”的万级；
 * 第 2 遍只给这批候选补「文件集 / 谓词 / 出处」；去重改成**子串遮蔽**（收下一个名字时
 * 把它的所有子串标记掉），复杂度从 O(n²) 降到 O(候选数 × 名字长度²)。
 *
 * @param {Array<{path:string, sentences:Array<{line:number,text:string}>}>} files
 * @param {{blacklist?:Set<string>, minCount?:number, maxN?:number, maxCandidates?:number}} [opts]
 * @returns {{kept:Array, dropped:Array, stats:{grams:number, candidates:number, truncated:number}}}
 */
function extractEntities(files, opts = {}) {
  const blacklist = opts.blacklist || DEFAULT_BLACKLIST;
  const minCount = Number.isFinite(opts.minCount) ? opts.minCount : 2;
  const maxN = Number.isFinite(opts.maxN) ? opts.maxN : 6;
  const maxCandidates = Number.isFinite(opts.maxCandidates) ? opts.maxCandidates : 20000;

  // ── 第 1 遍：只数频次 ────────────────────────────────────────────────────
  const counts = new Map();
  for (const f of files) {
    for (const s of f.sentences) {
      const runs = s.text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
      for (const run of runs) {
        for (let n = 2; n <= maxN; n += 1) {
          for (let i = 0; i + n <= run.length; i += 1) {
            const g = run.slice(i, i + n);
            if (isJunkName(g, blacklist) || NAME_INNER_BAD.test(g)) continue;
            counts.set(g, (counts.get(g) || 0) + 1);
          }
        }
      }
    }
  }
  const gramTotal = counts.size;

  // 只留够频次的候选（这一步把百万级 gram 砍到万级）
  const cand = new Map();
  for (const [g, c] of counts) if (c >= minCount) cand.set(g, c);
  counts.clear();
  let truncated = 0;
  if (cand.size > maxCandidates) {
    const keep = [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxCandidates);
    truncated = cand.size - keep.length;
    cand.clear();
    for (const [g, c] of keep) cand.set(g, c);
  }

  // ── 第 2 遍：给候选补文件集 / 谓词 / 出处 ────────────────────────────────
  const info = new Map();
  for (const [g, c] of cand) {
    info.set(g, { name: g, count: c, files: new Set(), preds: new Set(), ev: [], suffix: suffixOf(g) });
  }
  for (const f of files) {
    for (const s of f.sentences) {
      const runs = s.text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
      for (const run of runs) {
        for (let n = 2; n <= maxN; n += 1) {
          for (let i = 0; i + n <= run.length; i += 1) {
            const g = run.slice(i, i + n);
            const rec = info.get(g);
            if (!rec) continue;
            rec.files.add(f.path);
            const idx = s.text.indexOf(g);
            if (idx >= 0) for (const pr of predicatesNear(s.text, idx, g.length)) rec.preds.add(pr);
            if (rec.ev.length < 3) rec.ev.push({ path: f.path, line: s.line, text: s.text.slice(0, 160) });
          }
        }
      }
    }
  }

  // ── 去重：子串遮蔽 ──────────────────────────────────────────────────────
  // 口径（真机/脏库都验过）：
  //   1) 带类型后缀的完整名优先（共和国 / 议会 / 港 / 关）—— 后缀就是“这是一个完整名字”的证据；
  //   2) 同档里频次高的优先；再同则长的优先；
  //   3) 收下一个名字后，把它的**所有子串**标记掉：`砺川共和国` 收下后 `砺川`/`川共` 自然作废，
  //      `南共主` 收下后 `南共`/`共主` 作废（后者频次更高也不该赢 —— 它只是子串 + 别处的普通名词）。
  const all = [...info.values()].sort(
    (a, b) => ((b.suffix ? 1 : 0) - (a.suffix ? 1 : 0))
      || (b.count - a.count)
      || (b.name.length - a.name.length),
  );
  // 反向索引：子串 → 包含它的更长候选（先建好，处理短的时就知道“后面还有更完整的名字”）
  const superOf = new Map();
  for (const c of all) {
    for (let len = 2; len < c.name.length; len += 1) {
      for (let i = 0; i + len <= c.name.length; i += 1) {
        const sub = c.name.slice(i, i + len);
        if (!superOf.has(sub)) superOf.set(sub, new Set());
        superOf.get(sub).add(c.name);
      }
    }
  }

  const accepted = [];
  const shadowed = new Set();
  const dropped = [];
  for (const c of all) {
    if (shadowed.has(c.name)) {
      dropped.push({ ...c, reasons: ['是更完整名字的子串'] });
      continue;
    }
    // 还有更长、且频次不算太低的候选包含我 → 我是子串，作废（让更完整的名字活）
    const supers = superOf.get(c.name);
    if (supers && [...supers].some((n) => (info.get(n) || {}).count >= Math.max(2, Math.ceil(c.count / 1.3)))) {
      dropped.push({ ...c, reasons: ['有更完整的名字包含它（保留更长的那个）'] });
      continue;
    }
    accepted.push(c);
    for (let len = 2; len < c.name.length; len += 1) {
      for (let i = 0; i + len <= c.name.length; i += 1) shadowed.add(c.name.slice(i, i + len));
    }
  }

  // ── 证据闸门（OR 合成；见文件头纪律 B）─────────────────────────────────
  const kept = [];
  for (const c of accepted) {
    const effectiveMin = c.suffix ? minCount : (c.files.size >= 3 ? 3 : Math.max(4, minCount));
    if (c.count < effectiveMin) {
      dropped.push({ ...c, reasons: ['词频不足（无后缀名要 ≥4；跨 ≥3 文件可放宽到 3）'] });
      continue;
    }
    const strong = isStrongSuffix(c.suffix);
    const crossFile = c.files.size >= 3;
    const multiPredicate = c.preds.size >= 2;
    // 强后缀 + 谓词 能自证；弱后缀（军/城/关/海）**必须**另有证据
    const suffixEvidence = !!c.suffix && c.preds.size >= 1 && (strong || crossFile || multiPredicate);
    if (!(suffixEvidence || crossFile || multiPredicate)) {
      dropped.push({ ...c, reasons: ['证据不足（无后缀+谓词 / 跨文件<3 / 谓词<2）'] });
      continue;
    }
    kept.push({
      name: c.name,
      by: c.suffix ? ['ngram', 'suffix'] : ['ngram'],
      suffix: c.suffix,
      count: c.count,
      files: c.files.size,
      predicates: [...c.preds],
      evidence: c.ev,
      confidence: (strong && c.preds.size >= 1 && (c.files.size >= 2 || c.count >= 3)) ? 'high'
        : (c.suffix || c.preds.size >= 2) ? 'mid' : 'low',
    });
  }
  kept.sort((a, b) => (a.confidence === b.confidence ? b.count - a.count : (a.confidence === 'high' ? -1 : 1)));
  return { kept, dropped, stats: { grams: gramTotal, candidates: cand.size, truncated } };
}

// ── 时间锚 ──────────────────────────────────────────────────────────────────
function extractTimes(files) {
  const anchors = [];
  const relatives = [];
  for (const f of files) {
    let lastAbs = null;
    for (const s of f.sentences) {
      const absHits = [];
      for (const re of ABS_PATTERNS) {
        const m = s.text.match(re);
        if (m) absHits.push({ text: m[0].replace(/\s+/g, ' ').trim(), index: m.index, line: s.line, path: f.path });
      }
      absHits.sort((a, b) => a.index - b.index);
      if (absHits.length) lastAbs = absHits[absHits.length - 1];
      anchors.push(...absHits);
      REL_PATTERN.lastIndex = 0;
      let rm;
      while ((rm = REL_PATTERN.exec(s.text))) {
        relatives.push({
          text: rm[0], path: f.path, line: s.line,
          anchor: lastAbs ? lastAbs.text : null,
          anchored: !!lastAbs,
        });
      }
    }
  }
  return { anchors, relatives };
}

/**
 * 事件候选：一句里 ≥1 个已判定实体 + 有谓词；且（第二个实体 或 时间锚）才算“事件”
 * —— 只有实体+谓词的句子多半是定义句（“XX 是城里唯一还有规矩的地方”）。
 */
function extractEvents(files, entities, times) {
  const names = entities.map((e) => e.name).sort((a, b) => b.length - a.length);
  const anchorsByLine = new Map();
  for (const a of times.anchors) anchorsByLine.set(`${a.path}#${a.line}`, a.text);
  for (const r of times.relatives) if (!anchorsByLine.has(`${r.path}#${r.line}`)) anchorsByLine.set(`${r.path}#${r.line}`, r.text);

  const events = [];
  const seen = new Set();
  for (const f of files) {
    for (const s of f.sentences) {
      const inS = names.filter((n) => s.text.includes(n));
      if (!inS.length) continue;
      const verb = PREDICATES.find((p) => s.text.includes(p));
      if (!verb) continue;
      const time = anchorsByLine.get(`${f.path}#${s.line}`) || null;
      if (!(inS.length >= 2 || time)) continue;
      const key = `${inS[0]}|${inS[1] || ''}|${verb}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        a: inS[0], b: inS[1] || null, verb, time,
        evidence: { path: f.path, line: s.line, text: s.text.slice(0, 160) },
      });
    }
  }
  return events;
}

/** 调试口：返回原始 n-gram 计数（{name:{count,files:Set,preds:Set}}）。给用例与排障用。 */
function debugCounts(files, opts = {}) {
  const blacklist = opts.blacklist || DEFAULT_BLACKLIST;
  const maxN = Number.isFinite(opts.maxN) ? opts.maxN : 6;
  const counts = new Map();
  for (const f of files) {
    for (const s of f.sentences) {
      const runs = s.text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
      for (const run of runs) {
        for (let n = 2; n <= maxN; n += 1) {
          for (let i = 0; i + n <= run.length; i += 1) {
            const g = run.slice(i, i + n);
            if (isJunkName(g, blacklist) || NAME_INNER_BAD.test(g)) continue;
            const cur = counts.get(g) || { count: 0, files: new Set(), preds: new Set() };
            cur.count += 1; cur.files.add(f.path);
            const idx = s.text.indexOf(g);
            for (const pr of (idx >= 0 ? predicatesNear(s.text, idx, g.length) : [])) cur.preds.add(pr);
            counts.set(g, cur);
          }
        }
      }
    }
  }
  return counts;
}
module.exports = {
  PREDICATES, SUFFIXES, GENERIC, STOP_PREFIX, DEFAULT_BLACKLIST,
  FUNCTION_WORDS, TIME_WORDS, NON_ENTITY_NOUNS, NAME_START_BAD, NAME_INNER_BAD, NUMERAL_JUNK, COMMON_NOUN_TAIL,
  STRONG_SUFFIXES, WEAK_SUFFIXES, isStrongSuffix,
  splitSentences, classifyDocKind, predicatesNear, hasPredicateNear, suffixOf, isJunkName,
  extractEntities, extractTimes, extractEvents, debugCounts,
};
