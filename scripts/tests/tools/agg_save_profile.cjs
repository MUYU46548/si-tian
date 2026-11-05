// 分析 undo-latency 的 CPU 样本：整段 self time + 按 100ms 分桶的“谁在占主线程”
// （CDP Profiler 的 timeDeltas 单位是**微秒**，这里统一换 ms 打印）
// 用法：node build/bench-save/agg-profile.cjs <profile.json> [bucketMs] [minBusyMs]
const fs = require('fs');
const file = process.argv[2];
const bucketMs = Number(process.argv[3] || 100);
const minBusy = Number(process.argv[4] || 20);
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const prof = raw.profile || raw;
const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const buckets = new Map();
let tUs = 0;
const dt = prof.timeDeltas || [];
const bucketUs = bucketMs * 1000;
for (let i = 0; i < (prof.samples || []).length; i++) {
  tUs += dt[i] || 0;
  const node = nodes.get(prof.samples[i]);
  if (!node) continue;
  const cf = node.callFrame;
  const key = `${cf.functionName || '(anonymous)'} @ ${(cf.url || '').split('/').pop()}:${cf.lineNumber}`;
  self.set(key, (self.get(key) || 0) + (dt[i] || 0));
  const b = Math.floor(tUs / bucketUs);
  if (!buckets.has(b)) buckets.set(b, new Map());
  const m = buckets.get(b);
  m.set(key, (m.get(key) || 0) + (dt[i] || 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`总采样 ${(total / 1000).toFixed(0)} ms，分桶 ${bucketMs}ms，只打印忙 ≥${minBusy}ms 的桶`);
console.log('\n== 整段 self time 前 25 ==');
[...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  .forEach(([k, us]) => console.log(`  ${(us / 1000).toFixed(1).padStart(8)} ms  ${k}`));
console.log('\n== 忙桶（谁在占主线程） ==');
const idle = /^\((idle|program)\)|^\(garbage collector\)/;
let shown = 0;
for (const b of [...buckets.keys()].sort((a, c) => a - c)) {
  const m = buckets.get(b);
  const busyUs = [...m.entries()].filter(([k]) => !idle.test(k)).reduce((a, c) => a + c[1], 0);
  if (busyUs / 1000 < minBusy) continue;
  const top = [...m.entries()].sort((a, c) => c[1] - a[1]).slice(0, 3)
    .map(([k, us]) => `${k} ${(us / 1000).toFixed(0)}ms`).join(' | ');
  console.log(`  [${(b * bucketMs)}ms] 忙 ${(busyUs / 1000).toFixed(0)}ms  ${top}`);
  shown++;
}
if (!shown) console.log('  （没有忙桶）');
