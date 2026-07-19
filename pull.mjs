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
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
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
  const want = parseInt((volId.match(/\d+/) || ['0'])[0], 10);   // 'vol01' → 1
  const dirs = readdirSync(SRC, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^第.+卷/.test(d.name) && !d.name.startsWith('_'))
    .map(d => d.name);
  const hit = dirs.find(name => {
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

// ── 主流程 ──────────────────────────────────────────────
if (!DRY) {
  try {
    console.log('· git pull …');
    const out = execSync('git pull --ff-only', { cwd: __dirname, stdio: 'pipe' }).toString().trim();
    console.log('  ' + out.replace(/\n/g, '\n  '));
  } catch (e) {
    console.error('✗ git pull 失敗（可能有本地未提交變更或衝突，請先處理）:\n' + (e.stderr?.toString() || e.message));
    process.exit(1);
  }
}

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
  let vol;
  try { vol = JSON.parse(decrypt(key, JSON.parse(readFileSync(join(DATA, v.file), 'utf8')))); }
  catch (e) { console.error(`✗ 解密 ${v.file} 失敗（密碼不符？）`); process.exit(1); }
  const volDir = findVolDir(vol.id);
  for (const ch of vol.chapters) {
    checked++;
    const nnn = String(ch.n).padStart(3, '0');
    const local = volDir ? findChapterFile(volDir, ch.n) : null;
    if (local) {
      const raw = readFileSync(local, 'utf8');
      if (extractChapterBody(raw) === ch.body) continue;   // 無變動 → 跳過
      const heading = headingOf(raw) || `# 第 ${nnn} 章 ${ch.title}`;
      const out = heading + '\n' + (ch.mature ? '<!-- 肉 -->\n' : '') + '\n' + ch.body + '\n';
      if (!DRY) writeFileSync(local, out, 'utf8');
      changed++; report.push(`  ✎ 章 ${nnn}《${ch.title}》→ ${basename(local)}`);
    } else if (volDir) {
      // 本地沒有此章 → 手機新建的章
      const path = join(volDir, `${nnn}_${sanitize(ch.title)}.md`);
      const out = `# 第 ${nnn} 章 ${ch.title}\n` + (ch.mature ? '<!-- 肉 -->\n' : '') + `\n${ch.body}\n`;
      if (!DRY) writeFileSync(path, out, 'utf8');
      changed++; report.push(`  ＋ 新章 ${nnn}《${ch.title}》→ ${basename(path)}`);
    } else {
      report.push(`  ⚠ 找不到 ${vol.id} 對應的本地卷資料夾，略過章 ${nnn}`);
    }
  }
}

// 設定文件
if (idx.settings && idx.settings.file) {
  const docs = (JSON.parse(decrypt(key, JSON.parse(readFileSync(join(DATA, idx.settings.file), 'utf8')))).docs) || [];
  for (const doc of docs) {
    checked++;
    const path = join(ROOT, doc.id + '.md');
    if (!existsSync(path)) { report.push(`  ⚠ 設定 ${doc.id}.md 本地不存在，略過`); continue; }
    const raw = readFileSync(path, 'utf8');
    if (extractSettingBody(raw) === doc.body) continue;
    const heading = headingOf(raw) || `# ${doc.title}`;
    const out = heading + '\n\n' + doc.body + '\n';
    if (!DRY) writeFileSync(path, out, 'utf8');
    changed++; report.push(`  ✎ 設定 ${doc.id}.md`);
  }
}

// 備選版本
if (idx.alternates && idx.alternates.file) {
  const alts = (JSON.parse(decrypt(key, JSON.parse(readFileSync(join(DATA, idx.alternates.file), 'utf8')))).chapters) || [];
  const altDir = join(SRC, '_備選版本');
  for (const a of alts) {
    checked++;
    const file = findAltFile(altDir, a.n, a.title);
    if (!file) { report.push(`  ⚠ 備選《${a.title}》找不到本地檔，略過`); continue; }
    const raw = readFileSync(file, 'utf8');
    if (extractChapterBody(raw) === a.body) continue;
    const heading = headingOf(raw) || `# ${a.title}`;
    const out = heading + '\n' + (a.mature ? '<!-- 肉 -->\n' : '') + '\n' + a.body + '\n';
    if (!DRY) writeFileSync(file, out, 'utf8');
    changed++; report.push(`  ✎ 備選 ${basename(file)}`);
  }
}

console.log(`\n對照 ${checked} 項${DRY ? '（--dry：只比對、未寫檔）' : ''}，需寫回 ${changed} 項。`);
console.log(report.length ? report.join('\n') : '  ✓ 本地已是最新，無需更新。');
