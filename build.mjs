#!/usr/bin/env node
// 墨刃 App · 打包腳本
// 掃描墨刃書稿 → 每卷加密成一個檔 → 輸出到 ./data → (可選) git 推上 GitHub
//
// 用法：
//   node build.mjs            只打包（不推）
//   node build.mjs --push     打包並 git commit + push
//
// 密碼放在同層的 .passphrase（已被 .gitignore 排除，不會上傳）。
// 加密方式：PBKDF2-SHA256(200000) 導出金鑰 → AES-256-GCM，與瀏覽器 WebCrypto 完全對應。

import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 設定 ────────────────────────────────────────────────
const SRC = process.env.MOREN_SRC
  || '/Users/ming/ClaudeHQ/dev_個人工具開發/文本建構器/墨刃/書稿';
const ROOT = dirname(SRC);    // 墨刃 根目錄（設定文件放這）
const OUT = join(__dirname, 'data');
const ITER = 200000;          // PBKDF2 迭代次數
const HASH = 'sha256';        // 對應瀏覽器 'SHA-256'

// 要放進 App「設定」區的設定文件（顯示順序）
const SETTING_FILES = ['故事大綱.md', '世界觀設定.md', '人物設定.md', '肉戲設定.md', '文筆風格卡.md'];

// ── 讀密碼 ──────────────────────────────────────────────
function readPassphrase() {
  const f = join(__dirname, '.passphrase');
  if (!existsSync(f)) {
    console.error('✗ 找不到 .passphrase 檔。請在 ' + __dirname + ' 建立 .passphrase，內容放你的密碼（單獨一行）。');
    process.exit(1);
  }
  const pass = readFileSync(f, 'utf8').replace(/\r?\n/g, '').trim();
  if (!pass) { console.error('✗ .passphrase 是空的，請填入密碼。'); process.exit(1); }
  return pass;
}

// ── 加密工具 ────────────────────────────────────────────
function deriveKey(pass, salt) {
  return pbkdf2Sync(Buffer.from(pass, 'utf8'), salt, ITER, 32, HASH);
}
function encrypt(key, plaintextBuf) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plaintextBuf), c.final()]);
  const tag = c.getAuthTag();                       // 16 bytes，附在密文尾端（WebCrypto 相容）
  return { iv: iv.toString('base64'), ct: Buffer.concat([body, tag]).toString('base64') };
}

// ── 掃描書稿 ────────────────────────────────────────────
// 卷資料夾：第XX卷_標題；章檔：NNN_標題.md；排除底線開頭（如 _備選版本）。
function scanVolumes() {
  if (!existsSync(SRC)) { console.error('✗ 找不到書稿來源：' + SRC); process.exit(1); }
  const volDirs = readdirSync(SRC, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^第.+卷/.test(d.name) && !d.name.startsWith('_'))
    .map(d => d.name)
    .sort();

  const volumes = [];
  for (const vd of volDirs) {
    const m = vd.match(/^(第.+?卷)[_·]?(.*)$/);
    const volNo = m ? m[1] : vd;
    const volSub = m && m[2] ? m[2].replace(/^_/, '') : '';
    const title = volSub ? `${volNo}｜${volSub}` : volNo;

    const dir = join(SRC, vd);
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .sort();

    const chapters = [];
    for (const f of files) {
      const cm = basename(f, '.md').match(/^(\d+)[_·\-\s]*(.*)$/);
      const n = cm ? parseInt(cm[1], 10) : chapters.length + 1;
      let title2 = cm && cm[2] ? cm[2] : basename(f, '.md');
      let raw = readFileSync(join(dir, f), 'utf8');
      // 去掉首行的 # 標題（避免與章名重複），保留其餘正文
      const lines = raw.split(/\r?\n/);
      if (lines[0] && /^#\s/.test(lines[0])) lines.shift();
      const body = lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
      chapters.push({ n, title: title2, body });
    }
    if (chapters.length) volumes.push({ id: 'vol' + volNo.replace(/\D/g, '').padStart(2, '0'), title, chapters });
  }
  return volumes;
}

// ── 掃描備選版本（書稿/_備選版本/*.md）────────────────────
function scanAlternates() {
  const dir = join(SRC, '_備選版本');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort();
  const items = [];
  for (const f of files) {
    const base = basename(f, '.md');
    const m = base.match(/^(\d+)[_·\-\s]*(.*)$/);
    const n = m ? parseInt(m[1], 10) : items.length + 1;
    const title = (m && m[2] ? m[2] : base).replace(/_/g, ' · ');   // 「章名_版本X」→「章名 · 版本X」
    const lines = readFileSync(join(dir, f), 'utf8').split(/\r?\n/);
    if (lines[0] && /^#\s/.test(lines[0])) lines.shift();
    const body = lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    items.push({ n, title, body });
  }
  return items;
}

// ── 掃描設定文件 ────────────────────────────────────────
function scanSettings() {
  const docs = [];
  for (const f of SETTING_FILES) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    let title = basename(f, '.md');
    if (lines[0] && /^#\s+/.test(lines[0])) { title = lines[0].replace(/^#\s+/, '').trim(); lines.shift(); }
    const body = lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    docs.push({ id: basename(f, '.md'), title, body });
  }
  return docs;
}

// ── 主流程 ──────────────────────────────────────────────
const pass = readPassphrase();
const salt = randomBytes(16);
const key = deriveKey(pass, salt);

const volumes = scanVolumes();
if (!volumes.length) { console.error('✗ 沒掃到任何章節，請確認書稿路徑。'); process.exit(1); }

// 清空並重建 data/
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const index = {
  v: 1,
  updated: new Date().toISOString(),
  kdf: { salt: salt.toString('base64'), iter: ITER, hash: 'SHA-256' },
  check: encrypt(key, Buffer.from('moren-ok', 'utf8')),   // 用來快速驗證密碼是否正確
  volumes: [],
};

let totalCh = 0, totalChars = 0;
for (const v of volumes) {
  const file = v.id + '.json';
  const payload = Buffer.from(JSON.stringify({ id: v.id, title: v.title, chapters: v.chapters }), 'utf8');
  writeFileSync(join(OUT, file), JSON.stringify(encrypt(key, payload)));
  index.volumes.push({ id: v.id, file, chapters: v.chapters.length });
  totalCh += v.chapters.length;
  totalChars += v.chapters.reduce((s, c) => s + c.body.length, 0);
}

// 備選版本（加密）
const alternates = scanAlternates();
if (alternates.length) {
  const payload = Buffer.from(JSON.stringify({ chapters: alternates }), 'utf8');
  writeFileSync(join(OUT, 'alternates.json'), JSON.stringify(encrypt(key, payload)));
  index.alternates = { file: 'alternates.json', count: alternates.length };
}

// 設定文件（加密）
const settings = scanSettings();
if (settings.length) {
  const payload = Buffer.from(JSON.stringify({ docs: settings }), 'utf8');
  writeFileSync(join(OUT, 'settings.json'), JSON.stringify(encrypt(key, payload)));
  index.settings = { file: 'settings.json', count: settings.length };
}

writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));

console.log(`✓ 打包完成：${volumes.length} 卷、${totalCh} 章、約 ${totalChars.toLocaleString()} 字` +
  (alternates.length ? `、${alternates.length} 篇備選` : '') +
  (settings.length ? `、${settings.length} 份設定` : '') + ` → ${OUT}`);

// ── 可選：推上 GitHub ───────────────────────────────────
if (process.argv.includes('--push')) {
  try {
    const run = (cmd) => execSync(cmd, { cwd: __dirname, stdio: 'pipe' }).toString().trim();
    run('git add -A');
    // 沒有變更就不 commit
    const status = run('git status --porcelain');
    if (!status) { console.log('· 內容無變更，略過推送。'); process.exit(0); }
    run(`git commit -m "更新墨刃章節（${totalCh} 章）"`);
    run('git push');
    console.log('✓ 已推上 GitHub，手機開 App 即可看到最新章節。');
  } catch (e) {
    console.error('✗ 推送失敗：', e.stderr ? e.stderr.toString() : e.message);
    process.exit(1);
  }
}
