#!/usr/bin/env node
// 墨刃 App · 反向同步腳本（線上 → 本地）
// 用途：把「手機上改過、已推上 GitHub」的最新內容，解密後寫回本地書稿 .md。
//
// 流程：git pull → 解密 data/*.json → 依章號/檔名比對本地，只把「有變動」的正文寫回。
// 只覆蓋真的變了的檔（body 與本地目前萃取結果不同才寫），沒變的一律不動 → 冪等、安全。
//
// 用法：
//   node pull.mjs          先 git pull，再把變動寫回 .md
//   node pull.mjs --dry    只比對、印出會改哪些，不 git pull、不寫檔（純唯讀，用來驗證）
//
// 密碼取自同層 .passphrase（與 build.mjs 相同）。

import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.MOREN_SRC
  || '/Users/ming/ClaudeHQ/dev_個人工具開發/文本建構器/墨刃/書稿';
const ROOT = dirname(SRC);            // 墨刃 根目錄（設定文件放這）
const DATA = join(__dirname, 'data');
const DRY = process.argv.includes('--dry');

// ── 讀密碼 ──────────────────────────────────────────────
function readPass() {
  const f = join(__dirname, '.passphrase');
  if (!existsSync(f)) { console.error('✗ 找不到 .passphrase'); process.exit(1); }
  const p = readFileSync(f, 'utf8').replace(/\r?\n/g, '').trim();
  if (!p) { console.error('✗ .passphrase 是空的'); process.exit(1); }
  return p;
}

// ── 解密（對應 build.mjs 的 AES-256-GCM；ct 尾端 16 bytes 是 authTag）────────
function decrypt(key, obj) {
  const iv = Buffer.from(obj.iv, 'base64');
  const all = Buffer.from(obj.ct, 'base64');
  const tag = all.subarray(all.length - 16);
  const body = all.subarray(0, all.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

// ── 與 build.mjs 完全一致的「正文萃取」邏輯 ────────────────────────
// 用來算出「本地這個 .md 檔目前會被 build 打包成什麼 body」，好跟線上解出的 body 比對。
function extractChapterBody(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0] && /^#\s/.test(lines[0])) lines.shift();
  return lines.join('\n').replace(/<!--\s*肉\s*-->/g, '').replace(/^\n+/, '').replace(/\n+$/, '');
}
function extractSettingBody(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0] && /^#\s+/.test(lines[0])) lines.shift();
  return lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
}
function headingOf(raw) {
  const l = raw.split(/\r?\n/);
  return (l[0] && /^#\s/.test(l[0])) ? l[0] : null;   // 保留原檔抬頭，避免格式漂移
}

// ── 定位本地檔 ──────────────────────────────────────────
function findVolDir(volId) {
  const want = parseInt((volId.match(/\d+/) || ['0'])[0], 10);   // 'vol01' → 1；'vol00' → 0（楔子）
  const dirs = readdirSync(SRC, { withFileTypes: true })
    .filter(d => d.isDirectory() && (/^第.+卷/.test(d.name) || /^楔子/.test(d.name)) && !d.name.startsWith('_'))
    .map(d => d.name);
  const hit = dirs.find(name => {
    if (/^楔子/.test(name)) return want === 0;                   // 楔子 ＝ vol00（與 build.mjs scanVolumes 對齊）
    const m = name.match(/第0*(\d+)卷/);
    return m && parseInt(m[1], 10) === want;
  });
  return hit ? join(SRC, hit) : null;
}
function findChapterFile(volDir, n) {
  const files = readdirSync(volDir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  const hit = files.find(f => {
    const m = basename(f, '.md').match(/^(\d+)/);
    return m && parseInt(m[1], 10) === n;
  });
  return hit ? join(volDir, hit) : null;
}
function findAltFile(altDir, n, title) {
  if (!existsSync(altDir)) return null;
  const files = readdirSync(altDir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
  const hit = files.find(f => {
    const base = basename(f, '.md');
    const m = base.match(/^(\d+)[_·\-\s]*(.*)$/);
    if (!m || parseInt(m[1], 10) !== n) return false;
    const t = (m[2] || base).replace(/_/g, ' · ');   // 對應 build.mjs scanAlternates 的標題轉換
    return t === title;
  });
  return hit ? join(altDir, hit) : null;
}
function sanitize(name) {
  return name.replace(/[\/:*?"<>|]/g, '＿');   // 檔名不合法字元換全形
}

// ── 快照 & 比對報告 ──────────────────────────────────────
// 動機：pull 是直接 writeFileSync 覆蓋、且書稿未進 git，被蓋掉的舊版就沒了、
// 事後也 diff 不出「手機上到底改了哪些字」。故在「寫回前」先備份即將被覆蓋的舊檔，
// 「寫回後」再對舊版(快照) vs 新版做行級 diff，產出繁中比對報告。
const RUN_AT = new Date();   // 本次更新時刻；快照資料夾名與報告時間共用同一時間戳

function stamp(d) {          // 檔名用：YYYY-MM-DD_HHMMSS
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function humanTime(d) {      // 報告用：YYYY-MM-DD HH:MM:SS
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function wordCount(s) { return (s || '').replace(/\s/g, '').length; }   // 字數 ≈ 去空白後字元數（中文一字一元）

// 惰性建立快照資料夾：真的有東西要備份時才建，沒變動就不留空資料夾
let _snapDir = null;
function snapshotDir() {
  if (_snapDir) return _snapDir;
  _snapDir = join(ROOT, '舊檔備份', `pull快照_${stamp(RUN_AT)}`);
  mkdirSync(_snapDir, { recursive: true });
  return _snapDir;
}
// 寫回前把「即將被覆蓋的舊檔」複製進快照；檔不存在（本地新增章，無舊版）就跳過、不報錯
function snapshotOld(srcPath) {
  if (DRY || !existsSync(srcPath)) return;
  try { copyFileSync(srcPath, join(snapshotDir(), basename(srcPath))); }
  catch (e) { console.error(`  ⚠ 快照失敗 ${basename(srcPath)}：${e.message}`); }
}

// 行級 LCS diff：回傳 [{t:' '|'-'|'+', s:行內容}]（每段落一行，正好呈現舊/新段落對照）
function lineDiff(oldStr, newStr) {
  const a = (oldStr || '').split('\n'), b = (newStr || '').split('\n');
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: a[i] }); i++; }
    else { out.push({ t: '+', s: b[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', s: a[i++] });
  while (j < m) out.push({ t: '+', s: b[j++] });
  return out;
}
// 只留變動段（含上下 ctx 段脈絡），未變動的長段落收合成一行提示，避免報告灌水
function renderDiff(oldStr, newStr, ctx = 1) {
  const ops = lineDiff(oldStr, newStr);
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.t !== ' ')
      for (let k = Math.max(0, idx - ctx); k <= Math.min(ops.length - 1, idx + ctx); k++) keep[k] = true;
  });
  const lines = [];
  let skipped = 0;
  for (let idx = 0; idx < ops.length; idx++) {
    if (keep[idx]) {
      if (skipped) { lines.push(`… 略過 ${skipped} 段未變動 …`); skipped = 0; }
      const op = ops[idx];
      lines.push((op.t === ' ' ? '  ' : op.t + ' ') + op.s);
    } else skipped++;
  }
  if (skipped) lines.push(`… 略過 ${skipped} 段未變動 …`);
  return lines.join('\n');
}

// 收集這次被覆蓋／新增的項目，供 pull 後產報告
const diffs = [];

// ── 主流程 ──────────────────────────────────────────────
// changedData：這次 git pull 實際帶進來的 data 檔（basename 集合）。
// 只回寫「遠端 commit 真的動過」的檔 → 避免把本地未推的編輯，用線上舊版蓋掉（曾踩過雷）。
// null = 不設限（--dry 純稽核模式：比對全部、但不寫檔）。
let changedData = null;
let gitRange = null;   // 本次 git pull 的 HEAD 前後範圍（供比對報告顯示）
if (!DRY) {
  const git = (args) => execSync('git ' + args, { cwd: __dirname, stdio: 'pipe' }).toString().trim();
  let headBefore = '';
  try { headBefore = git('rev-parse HEAD'); } catch {}
  console.log('· git pull …');
  try {
    console.log('  ' + git('pull --ff-only').replace(/\n/g, '\n  '));
  } catch (e) {
    console.error('✗ git pull 失敗（可能有本地未提交變更或衝突，請先處理）:\n' + (e.stderr?.toString() || e.message));
    process.exit(1);
  }
  const headAfter = git('rev-parse HEAD');
  gitRange = { before: headBefore, after: headAfter };
  if (headBefore === headAfter) {
    changedData = new Set();   // 沒有新的遠端 commit → 沒有手機編輯要拉，不動任何本地檔
  } else {
    changedData = new Set(git(`diff --name-only ${headBefore} ${headAfter} -- data/`).split('\n').filter(Boolean).map((p) => p.split('/').pop()));
  }
}
// 這個 data 檔是否該回寫本地：--dry 全查；正式模式只認「這次 pull 動過的檔」
const eligible = (file) => changedData === null || changedData.has(file);

const pass = readPass();
const idx = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8'));
const key = pbkdf2Sync(
  Buffer.from(pass, 'utf8'),
  Buffer.from(idx.kdf.salt, 'base64'),
  idx.kdf.iter, 32,
  idx.kdf.hash === 'SHA-256' ? 'sha256' : idx.kdf.hash.toLowerCase()
);

let checked = 0, changed = 0;
const report = [];

// 卷 → 章
for (const v of idx.volumes) {
  if (!eligible(v.file)) continue;   // 這次 pull 沒動到這個卷檔 → 跳過，別覆蓋本地
  let vol;
  try { vol = JSON.parse(decrypt(key, JSON.parse(readFileSync(join(DATA, v.file), 'utf8')))); }
  catch (e) { console.error(`✗ 解密 ${v.file} 失敗（密碼不符？）`); process.exit(1); }
  const volDir = findVolDir(vol.id);
  for (const ch of vol.chapters) {
    checked++;
    const nnn = String(ch.n).padStart(4, '0');
    const local = volDir ? findChapterFile(volDir, ch.n) : null;
    if (local) {
      const raw = readFileSync(local, 'utf8');
      if (extractChapterBody(raw) === ch.body) continue;   // 無變動 → 跳過
      const oldBody = extractChapterBody(raw);             // 拉回前的本地正文（供 diff）
      const heading = headingOf(raw) || `# 第 ${nnn} 章 ${ch.title}`;
      const out = heading + '\n' + (ch.mature ? '<!-- 肉 -->\n' : '') + '\n' + ch.body + '\n';
      snapshotOld(local);                                  // 寫回前先備份舊檔
      if (!DRY) writeFileSync(local, out, 'utf8');
      diffs.push({ kind: 'chapter', label: `章 ${nnn}《${ch.title}》`, sub: basename(volDir), file: basename(local), oldBody, newBody: ch.body });
      changed++; report.push(`  ✎ 章 ${nnn}《${ch.title}》→ ${basename(local)}`);
    } else if (volDir) {
      // 本地沒有此章 → 手機新建的章
      const path = join(volDir, `${nnn}_${sanitize(ch.title)}.md`);
      const out = `# 第 ${nnn} 章 ${ch.title}\n` + (ch.mature ? '<!-- 肉 -->\n' : '') + `\n${ch.body}\n`;
      if (!DRY) writeFileSync(path, out, 'utf8');
      diffs.push({ kind: 'new-chapter', label: `新章 ${nnn}《${ch.title}》`, sub: basename(volDir), file: basename(path), newBody: ch.body });
      changed++; report.push(`  ＋ 新章 ${nnn}《${ch.title}》→ ${basename(path)}`);
    } else {
      report.push(`  ⚠ 找不到 ${vol.id} 對應的本地卷資料夾，略過章 ${nnn}`);
    }
  }
}

// 設定文件
if (idx.settings && idx.settings.file && eligible(idx.settings.file)) {
  const docs = (JSON.parse(decrypt(key, JSON.parse(readFileSync(join(DATA, idx.settings.file), 'utf8')))).docs) || [];
  for (const doc of docs) {
    checked++;
    const path = join(ROOT, '設定集', doc.id + '.md');
    if (!existsSync(path)) { report.push(`  ⚠ 設定 ${doc.id}.md 本地不存在，略過`); continue; }
    const raw = readFileSync(path, 'utf8');
    if (extractSettingBody(raw) === doc.body) continue;
    const oldBody = extractSettingBody(raw);
    const heading = headingOf(raw) || `# ${doc.title}`;
    const out = heading + '\n\n' + doc.body + '\n';
    snapshotOld(path);
    if (!DRY) writeFileSync(path, out, 'utf8');
    diffs.push({ kind: 'setting', label: `設定《${doc.title}》`, sub: '設定集', file: doc.id + '.md', oldBody, newBody: doc.body });
    changed++; report.push(`  ✎ 設定 ${doc.id}.md`);
  }
}

// 備選版本
if (idx.alternates && idx.alternates.file && eligible(idx.alternates.file)) {
  const alts = (JSON.parse(decrypt(key, JSON.parse(readFileSync(join(DATA, idx.alternates.file), 'utf8')))).chapters) || [];
  const altDir = join(SRC, '_備選版本');
  for (const a of alts) {
    checked++;
    const file = findAltFile(altDir, a.n, a.title);
    if (!file) { report.push(`  ⚠ 備選《${a.title}》找不到本地檔，略過`); continue; }
    const raw = readFileSync(file, 'utf8');
    if (extractChapterBody(raw) === a.body) continue;
    const oldBody = extractChapterBody(raw);
    const heading = headingOf(raw) || `# ${a.title}`;
    const out = heading + '\n' + (a.mature ? '<!-- 肉 -->\n' : '') + '\n' + a.body + '\n';
    snapshotOld(file);
    if (!DRY) writeFileSync(file, out, 'utf8');
    diffs.push({ kind: 'alternate', label: `備選《${a.title}》`, sub: '_備選版本', file: basename(file), oldBody, newBody: a.body });
    changed++; report.push(`  ✎ 備選 ${basename(file)}`);
  }
}

console.log(`\n對照 ${checked} 項${DRY ? '（--dry：只比對、未寫檔）' : ''}，需寫回 ${changed} 項。`);
console.log(report.length ? report.join('\n') : '  ✓ 本地已是最新，無需更新。');

// ── pull 後：對被覆蓋的每一項做 舊版 vs 新版 diff，產出繁中比對報告 ────────
if (!DRY && diffs.length) {
  const dir = snapshotDir();   // 前面有 snapshotOld 過則已建立；純新章情況於此才建
  const rangeStr = gitRange
    ? `\`${(gitRange.before || '（無）').slice(0, 7)} → ${(gitRange.after || '').slice(0, 7)}\``
    : '（未取得）';
  const overwritten = diffs.filter((d) => d.kind !== 'new-chapter');   // 有舊版、可 diff
  const created = diffs.filter((d) => d.kind === 'new-chapter');       // 手機新建、無舊版

  const md = [];
  md.push(`# 墨刃更新比對報告 — ${humanTime(RUN_AT)}`, '');
  md.push(`- **更新時間**：${humanTime(RUN_AT)}`);
  md.push(`- **git 範圍**：${rangeStr}`);
  md.push(`- **對照 ${checked} 項，寫回 ${changed} 項**`);
  md.push('- 本資料夾同時存有「拉回前」被覆蓋檔的舊版快照，供回溯／比對。', '');

  if (overwritten.length) {
    md.push('## 逐項變更（舊版 → 新版）', '');
    for (const d of overwritten) {
      const oc = wordCount(d.oldBody), nc = wordCount(d.newBody), delta = nc - oc;
      const sign = delta > 0 ? `+${delta}` : `${delta}`;
      md.push(`### ${d.label}${d.sub ? `（${d.sub}）` : ''}`);
      md.push(`- 檔案：\`${d.file}\``);
      md.push(`- 字數：${oc.toLocaleString('en-US')} → ${nc.toLocaleString('en-US')}（${sign}）`, '');
      md.push('```diff');
      md.push(renderDiff(d.oldBody, d.newBody));
      md.push('```', '');
    }
  }
  if (created.length) {
    md.push('## 新增（線上有、本地原無 → 無舊版可比對）', '');
    for (const d of created)
      md.push(`- ${d.label}（${d.sub}）→ \`${d.file}\`，字數 ${wordCount(d.newBody).toLocaleString('en-US')}`);
    md.push('');
  }

  writeFileSync(join(dir, '更新比對報告.md'), md.join('\n'), 'utf8');

  // console 精簡摘要：哪幾項、各自字數增減
  console.log(`\n📸 已存快照＋比對報告 → ${dir}`);
  for (const d of overwritten) {
    const oc = wordCount(d.oldBody), nc = wordCount(d.newBody), delta = nc - oc;
    const sign = delta > 0 ? `+${delta}` : `${delta}`;
    console.log(`   ${d.label}  ${oc.toLocaleString('en-US')} → ${nc.toLocaleString('en-US')}（${sign} 字）`);
  }
  for (const d of created)
    console.log(`   ${d.label}  ＋${wordCount(d.newBody).toLocaleString('en-US')} 字（新增，無舊版）`);
}
