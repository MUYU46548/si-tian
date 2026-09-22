#!/usr/bin/env node
/**
 * Node 单元测试：应用侧令牌保管（src/main/gitCredentialStore.js）
 *
 * 为什么单独守这一层：2026-09-22 的真实事故是「用户填了令牌，点同步仍报需要登录」——
 * 旧实现只把令牌交给系统凭据管理器，推送时取不回来。现在令牌由本应用加密保管并直接喂给 git，
 * 所以「存进去能不能取回来」「会不会落明文」必须有用例守着。
 *
 * 手法：注入「假加密」（base64 + 前缀）当成 safeStorage —— 不依赖 Electron，也能验证
 * 「磁盘上不含明文」「跨实例（≈重启）能解密取回」「解密失败按没有处理」。
 *
 * 用法：node scripts/tests/unit/test_git_credential_store.js
 */
'use strict';

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const S = require(path.join(ROOT, 'src', 'main', 'gitCredentialStore.js'));

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail: detail || '' }); })
    .catch((err) => { results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) }); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const TMP_CANDIDATES = [
  process.env.SITIAN_TEST_TMP, process.env.TEMP, process.env.TMP,
  (() => { try { return os.tmpdir(); } catch (e) { return ''; } })(),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
  path.join(os.homedir(), '.sitian-test-tmp'),
].filter(Boolean);

let TMP = '';
async function resolveTmpRoot() {
  const tried = [];
  for (const base of TMP_CANDIDATES) {
    const dir = path.join(base, `sitian-cred-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      await fsp.writeFile(probe, 'ok', 'utf-8');
      await fsp.unlink(probe);
      TMP = dir;
      return;
    } catch (e) { tried.push(`${base} → ${e.code || e.message}`); }
  }
  throw new Error('找不到可写的临时目录。候选：' + tried.join(' | '));
}

/** 假加密：base64 + 前缀（只用于证明「磁盘上不是明文」「跨实例可取回」） */
const fakeEncrypt = (s) => 'enc:' + Buffer.from(String(s), 'utf-8').toString('base64');
const fakeDecrypt = (s) => {
  const t = String(s || '');
  if (!t.startsWith('enc:')) throw new Error('格式不对');
  return Buffer.from(t.slice(4), 'base64').toString('utf-8');
};

const TOKEN = 'ghp_this_is_a_fake_token_value_1234567890';

async function main() {
  await resolveTmpRoot();

  // ── 1. 有加密能力：落盘加密 + 跨实例可取回 ──────────────────────────────
  await check('令牌落盘是密文，且跨实例（≈重启）仍能取回', async () => {
    const store = S.createCredentialStore({ dir: TMP, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
    const saved = await store.set({ host: 'github.com', username: 'muyu', token: TOKEN });
    assert(saved.ok, `保存失败：${saved.error}`);
    eq(saved.persistent, true, 'persistent');

    const file = path.join(TMP, S.FILE_NAME);
    const raw = await fsp.readFile(file, 'utf-8');
    assert(!raw.includes(TOKEN), '令牌明文落盘（严重）');
    assert(raw.includes('github.com'), '未按域名保存');

    // 新实例（模拟下次启动）：只能靠磁盘解密取回
    const fresh = S.createCredentialStore({ dir: TMP, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
    const got = await fresh.get('github.com');
    assert(got, '重启后取不回令牌（这正是本次要修的事故形态）');
    eq(got.token, TOKEN, 'token');
    eq(got.username, 'muyu', 'username');
    eq(await fresh.has('github.com'), true, 'has');
    eq(await fresh.get('gitee.com'), null, '未保存的域名应返回 null');
    return '磁盘密文 + 跨实例解密取回 OK';
  });

  await check('原子写：不残留 .tmp-* 中间文件', async () => {
    const files = await fsp.readdir(TMP);
    const leftovers = files.filter(f => f.includes('.tmp-'));
    eq(leftovers.length, 0, `残留中间文件：${leftovers.join(',')}`);
    return `目录内文件：${files.join(', ')}`;
  });

  await check('清除令牌：文件里不再有该域名', async () => {
    const store = S.createCredentialStore({ dir: TMP, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
    const cleared = await store.clear('github.com');
    assert(cleared.ok, `清除失败：${cleared.error}`);
    eq(await store.has('github.com'), false, 'clear 后 has');
    const raw = await fsp.readFile(path.join(TMP, S.FILE_NAME), 'utf-8');
    assert(!raw.includes('github.com'), 'clear 后文件里仍有该域名');
    return 'ok';
  });

  await check('解密失败（换了机器/密钥）→ 视为没有，而不是抛错炸链路', async () => {
    const store = S.createCredentialStore({ dir: TMP, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
    await store.set({ host: 'example.com', username: 'u', token: TOKEN });
    const broken = S.createCredentialStore({
      dir: TMP, encrypt: fakeEncrypt,
      decrypt: () => { throw new Error('DPAPI 解不开'); },
    });
    eq(await broken.get('example.com'), null, '解密失败应返回 null');
    return 'ok';
  });

  // ── 2. 无加密能力：只在会话内存里，不写明文 ─────────────────────────────
  await check('无加密能力：退回会话内存，绝不写明文文件', async () => {
    const dir2 = path.join(TMP, 'no-crypto');
    await fsp.mkdir(dir2, { recursive: true });
    const store = S.createCredentialStore({ dir: dir2 });   // 不注入加解密
    eq(store.persistent, false, 'persistent');
    const saved = await store.set({ host: 'github.com', username: 'u', token: TOKEN });
    assert(saved.ok, `会话内存保存也应成功：${saved.error}`);
    eq(saved.persistent, false, 'saved.persistent');
    const got = await store.get('github.com');
    eq(got && got.token, TOKEN, '会话内可读');
    const files = await fsp.readdir(dir2);
    eq(files.length, 0, `不该产生任何文件，实际：${files.join(',')}`);
    return '会话内存保管（无任何落盘）';
  });

  await check('safeStorage 不可用（encrypt 返回 null）→ 不写明文、退回内存', async () => {
    const dir3 = path.join(TMP, 'null-crypto');
    await fsp.mkdir(dir3, { recursive: true });
    const store = S.createCredentialStore({ dir: dir3, encrypt: () => null, decrypt: () => null });
    const saved = await store.set({ host: 'github.com', username: 'u', token: TOKEN });
    assert(saved.ok, '保存应成功（降级为会话内存）');
    eq(saved.persistent, false, 'persistent');
    const got = await store.get('github.com');
    eq(got && got.token, TOKEN, '会话内可读');
    const files = await fsp.readdir(dir3);
    eq(files.length, 0, `不该产生任何文件，实际：${files.join(',')}`);
    return '降级为会话内存（无明文落盘）';
  });

  await check('域名大小写归一 + 空值校验', async () => {
    const store = S.createCredentialStore({ dir: TMP, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
    await store.set({ host: 'GitHub.COM', username: 'u', token: TOKEN });
    const got = await store.get('github.com');
    eq(got && got.token, TOKEN, '大小写应归一');
    const bad = await store.set({ host: '', username: 'u', token: TOKEN });
    eq(bad.ok, false, '空域名应失败');
    const bad2 = await store.set({ host: 'github.com', username: 'u', token: '' });
    eq(bad2.ok, false, '空令牌应失败');
    return 'ok';
  });

  // ── 汇总 ───────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  console.log('=== 令牌保管单元测试（Node）===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error('单元测试运行器异常:', err);
    await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  });
