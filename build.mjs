#!/usr/bin/env node
// 墨刃 App · 打包腳本
// 掃描墨刃書稿 → 每卷加密成一個檔 → 輸出到 ./data → (可選) git 推上 GitHub
//
// 除了 App 讀的東西（章節／備選／設定 md），另打包一份「換機同步包」（2026-08-18 加）：
//   data/brain.json   小說大腦/ 整包 ＋ 墨刃 CLAUDE.md
//   data/assets.json  設定集/ 的非 md 素材（地圖 .ai/.png/.svg ＋ 兩支生成器）
// App 端不讀這兩包（index.brain／index.assets 它壓根沒 fetch），純粹是為了讓另一台電腦
// 跑 pull.mjs 就拿得到整包最新進度 —— SSD 不在身邊時的取得管道。repo 是 public，故照樣加密。
//
// ⭐內容指紋（2026-08-18 加）：每個 data 檔把「金鑰＋明文」的 sha256 記進索引，
// 指紋一樣就原地保留舊密文、完全不重新加密 → 一個字沒改時 data/ 一個 byte 都不動、推送自動略過。
//
// ⭐⭐ 章級分片（v2 · 2026-08-18 改）：以前一卷打包成一個檔（vol01.json 已 1.07MB），
// 改一章幾個字就要整卷重新加密、整包重推；手機按儲存也是整卷 1.07MB 上傳（Ming 回報最痛的一段）。
// 現在改成：
//   data/volXX.json    ← 卷「目錄」（加密）：{id, title, chapters:[{n,title,mature,file,sha}]}，不含正文
//   data/ch/NNNN.json  ← 單章密文（加密）：{n, title, body, mature}
// 改一章 → 只重寫該章檔（約 15KB）＋ 該卷目錄（約 11KB）＋ index.json，而不是 1.07MB。
// 章號 NNNN 是全書連續、跨卷不重複（見墨刃 CLAUDE.md），故可直接當檔名。
// ⚠️ 舊版 vol01.json 的明文沒有章級 sha 欄位 → 首次跑新版時全部章節自動重新加密一次（預期行為）。
//
// 用法：
//   node build.mjs            只打包（不推）
//   node build.mjs --push     打包並 git commit + push
//
// 密碼放在同層的 .passphrase（已被 .gitignore 排除，不會上傳）。
// 加密方式：PBKDF2-SHA256(200000) 導出金鑰 → AES-256-GCM，與瀏覽器 WebCrypto 完全對應。

import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, relative, extname, sep } from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 設定 ────────────────────────────────────────────────
// ⚠️ 不要寫死絕對路徑（dev 資料夾改過名，寫死會直接 ENOENT）
// 用腳本自身位置往上推：墨刃App/ 的上一層＝墨刃根目錄
const SRC = process.env.MOREN_SRC
  || join(dirname(__dirname), '書稿');
const ROOT = dirname(SRC);    // 墨刃 根目錄（設定文件放這）
const OUT = join(__dirname, 'data');
const ITER = 200000;          // PBKDF2 迭代次數
const HASH = 'sha256';        // 對應瀏覽器 'SHA-256'

// 要放進 App「設定」區的設定文件（顯示順序）
const SETTING_FILES = ['設定集/故事大綱.md', '設定集/世界觀設定.md', '設定集/人物設定.md', '設定集/肉戲設定.md', '設定集/文筆風格卡.md'];

// 「換機同步包」要帶的東西（App 不讀，只為讓另一台電腦 pull 得到整包最新進度）
const BRAIN_DIR = '小說大腦';        // 整包遞迴（連續性總帳／事實表／踩雷筆記／實體卡／章要點／_歸檔…）
const BRAIN_EXTRA = ['CLAUDE.md'];   // 墨刃工作規範（選項 dispatch、逐章書寫鐵則、權威分工）
const ASSET_DIR = '設定集';          // 只收非 .md（地圖 .ai/.png/.svg 與兩支生成器）；5 份 md 已走 settings.json

// --full（＝「全檔更新」）：連換機同步包一起重打包。
// 平常推送不帶它 —— 寫完一章大腦一定跟著改（總帳／章要點／實體卡），每次都重推 1.9MB 的
// brain.json 太浪費。不帶時舊的 brain.json／assets.json 原封不動保留（連掃都不掃），
// index 那兩欄沿用舊值 → git 完全看不到差異。⚠️ 但也表示大腦的更新要等下次 --full 才上線。
const FULL = process.argv.includes('--full') || process.argv.includes('--all');

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
// 解密：只用在「讀舊卷目錄檔、取出章級指紋」（章的 sha 存在加密的目錄裡，不外露到 index.json）
function decrypt(key, obj) {
  const raw = Buffer.from(obj.ct, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(obj.iv, 'base64'));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
}

// ── 掃描書稿 ────────────────────────────────────────────
// 卷資料夾：第XX卷_標題（含「第00卷」＝原「楔子」，2026-07-30 改名）；章檔：NNN_標題.md；排除底線開頭（如 _備選版本）。
// ⚠「楔子_」那條 regex 與 xm 分支保留作舊相容，現已無資料夾命中；第00卷 走第一條分支、算出的 id 同樣是 vol00（故 data/vol00.json 與手機端閱讀狀態不受改名影響）。
function scanVolumes() {
  if (!existsSync(SRC)) { console.error('✗ 找不到書稿來源：' + SRC); process.exit(1); }
  const volDirs = readdirSync(SRC, { withFileTypes: true })
    .filter(d => d.isDirectory() && (/^第.+卷/.test(d.name) || /^楔子/.test(d.name)) && !d.name.startsWith('_'))
    .map(d => d.name)
    .sort();

  const volumes = [];
  for (const vd of volDirs) {
    const xm = vd.match(/^(楔子)[_·]?(.*)$/);
    const m = vd.match(/^(第.+?卷)[_·]?(.*)$/);
    const volNo = xm ? xm[1] : (m ? m[1] : vd);
    const volSub = xm ? (xm[2] ? xm[2].replace(/^_/, '') : '') : (m && m[2] ? m[2].replace(/^_/, '') : '');
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
      const mature = /<!--\s*肉\s*-->/.test(raw);   // 隱藏標記 → 標 18+
      // 去掉首行的 # 標題（避免與章名重複），保留其餘正文
      const lines = raw.split(/\r?\n/);
      if (lines[0] && /^#\s/.test(lines[0])) lines.shift();
      const body = lines.join('\n').replace(/<!--\s*肉\s*-->/g, '').replace(/^\n+/, '').replace(/\n+$/, '');
      chapters.push({ n, title: title2, body, mature });
    }
    if (chapters.length) volumes.push({ id: xm ? 'vol00' : 'vol' + volNo.replace(/\D/g, '').padStart(2, '0'), title, chapters });
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
    const raw = readFileSync(join(dir, f), 'utf8');
    const mature = /<!--\s*肉\s*-->/.test(raw);
    const lines = raw.split(/\r?\n/);
    if (lines[0] && /^#\s/.test(lines[0])) lines.shift();
    const body = lines.join('\n').replace(/<!--\s*肉\s*-->/g, '').replace(/^\n+/, '').replace(/\n+$/, '');
    items.push({ n, title, body, mature });
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

// ── 掃描「換機同步包」：小說大腦＋工作規範＋設定集素材 ──────────────────
// 目的（2026-08-18 加）：SSD 不在身邊時，另一台電腦只要 node pull.mjs 就拿得到整包最新進度。
// 原本 pull 只還原「App 讀得到的東西」（章節／備選／5 份設定 md），大腦與地圖完全沒過去 → 換機就缺進度。
// ⚠️ repo 是 public，所以照章節同一把密碼加密後才推。App 端不讀 index.brain／index.assets → 不下載、不顯示。
const TEXT_EXT = new Set(['.md', '.txt', '.py', '.svg', '.json', '.csv', '.html']);

function walk(dir, out = []) {
  for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (d.name.startsWith('.')) continue;                       // .DS_Store 等系統雜項不收
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (d.isFile()) out.push(p);
  }
  return out;
}

// 打成 { path(相對墨刃根目錄), enc, body }。
// 文字檔存 utf8（pull 端才做得出行級 diff 報告）；二進位（.ai/.png）存 base64。
function packFile(abs) {
  const rel = relative(ROOT, abs).split(sep).join('/');         // 一律用 / 當分隔，跨平台一致
  return TEXT_EXT.has(extname(abs).toLowerCase())
    ? { path: rel, enc: 'utf8', body: readFileSync(abs, 'utf8') }
    : { path: rel, enc: 'b64', body: readFileSync(abs).toString('base64') };
}

function scanBrain() {
  const files = [];
  const dir = join(ROOT, BRAIN_DIR);
  if (existsSync(dir)) files.push(...walk(dir));
  for (const f of BRAIN_EXTRA) {
    const p = join(ROOT, f);
    if (existsSync(p)) files.push(p);
  }
  return files.map(packFile);
}

function scanAssets() {
  const dir = join(ROOT, ASSET_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.md'))
    .map((d) => d.name).sort()
    .map((n) => packFile(join(dir, n)));
}

// ── 主流程 ──────────────────────────────────────────────
const pass = readPassphrase();
// 固定 salt（由密碼派生、每次 build 都一樣）：讓每次打包共用同一把 key，
// 即使手機快取混到新舊兩次 build 的檔案、或 CDN 尚未同步完，也能用同一把 key 解開、不會打不開。
// （每個檔案的 iv 仍每次隨機 → AES-GCM 密文每次不同，加密安全性不受影響。）
const salt = createHash('sha256').update('moren-fixed-salt::v1::' + pass).digest().subarray(0, 16);
const key = deriveKey(pass, salt);

// ── 防呆：若線上版本比本地新，代表你在手機 App 上改過內容還沒同步回本地，先擋下 ──
// （避免用舊的本地書稿，把手機剛編輯的內容蓋掉。用 --force 可強制略過。）
async function checkRemoteNewer() {
  if (process.argv.includes('--force')) return;
  const localIdxPath = join(OUT, 'index.json');
  if (!existsSync(localIdxPath)) return;                     // 首次打包，無可比對
  let localUpdated;
  try { localUpdated = JSON.parse(readFileSync(localIdxPath, 'utf8')).updated; } catch { return; }
  if (!localUpdated) return;
  let remote;
  try {
    const res = await fetch('https://ming-c-tw.github.io/noir-blade/data/index.json?cb=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    remote = await res.json();
  } catch { return; }                                        // 離線／抓不到 → 不擋，照常打包
  if (remote.updated && remote.updated > localUpdated) {
    console.error('✗ 線上版本比本地新（線上 ' + remote.updated + ' > 本地 ' + localUpdated + '）。');
    console.error('  很可能你在手機 App 上改過內容、還沒同步回本地。');
    console.error('  請先雙擊「更新.command」（或執行 node pull.mjs）把手機的修改拉回本地，再重新打包。');
    console.error('  若確定要用本地覆蓋線上，請改用：node build.mjs --push --force');
    process.exit(1);
  }
}
await checkRemoteNewer();

const volumes = scanVolumes();
if (!volumes.length) { console.error('✗ 沒掃到任何章節，請確認書稿路徑。'); process.exit(1); }

mkdirSync(OUT, { recursive: true });

// ── 內容指紋：沒變就不重新加密（2026-08-18 加）──────────────────────────
// 病因：AES-GCM 的 iv 每次隨機 → 同一份明文每次密文都不同 → 就算一個字沒改，
//       git 也看到全部 data 檔有異動、照樣 commit＋push。密文無法 delta 壓縮，
//       646 次 commit 已讓 .git 長到 410MB；再加上大腦與地圖素材會更快撐爆。
// 解法：把「金鑰＋明文」的 sha256 記進 index.json。下次 build 指紋一樣 → 原地保留舊密文檔、完全不碰。
//       把 key 也混進 sha → 換密碼時指紋全變、自動全部重新加密，不會留下解不開的舊檔。
const OLD_INDEX = (() => {
  try { return JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8')); } catch { return null; }
})();
function oldShaOf(file) {
  if (!OLD_INDEX) return null;
  const pool = [...(OLD_INDEX.volumes || []), OLD_INDEX.alternates, OLD_INDEX.settings, OLD_INDEX.brain, OLD_INDEX.assets];
  const hit = pool.find((x) => x && x.file === file);
  return hit ? hit.sha : null;
}
const kept = [];      // 這次沿用舊密文（沒重新加密）的檔，供 console 回報
const rebuilt = [];   // 這次真的重新加密、寫檔的檔

// 章級指紋存在「加密的卷目錄檔」裡（不放進明文 index.json —— 1700 章會讓 index 膨脹到上百 KB、
// 每次儲存都得重推）。要比對就把舊目錄檔解密出來查。整卷只解一次、快取起來。
const OLD_VOL_CACHE = {};
function oldVolManifest(volId) {
  if (volId in OLD_VOL_CACHE) return OLD_VOL_CACHE[volId];
  let m = null;
  const entry = OLD_INDEX && (OLD_INDEX.volumes || []).find((x) => x.id === volId);
  if (entry) {
    try { m = JSON.parse(decrypt(key, JSON.parse(readFileSync(join(OUT, entry.file), 'utf8')))); } catch { m = null; }
  }
  OLD_VOL_CACHE[volId] = m;
  return m;
}
function oldChapterSha(volId, n) {
  const m = oldVolManifest(volId);
  const hit = m && Array.isArray(m.chapters) ? m.chapters.find((c) => c.n === n) : null;
  return hit ? hit.sha : null;   // 舊格式（v1）的目錄沒有 sha 欄位 → undefined → 這章會重新加密一次
}

// oldSha 省略時查 index.json（適用 volXX/alternates/settings/brain/assets）；章檔要外帶。
function emit(file, payload, oldSha) {
  const sha = createHash('sha256').update(key).update(payload).digest('hex');
  const path = join(OUT, file);
  const prev = oldSha === undefined ? oldShaOf(file) : oldSha;
  if (sha === prev && existsSync(path)) { kept.push(file); return sha; }   // 指紋沒變 → 原地不動
  mkdirSync(dirname(path), { recursive: true });                           // data/ch/ 首次要先建
  writeFileSync(path, JSON.stringify(encrypt(key, payload)));
  rebuilt.push(file);
  return sha;
}

const index = {
  v: 2,   // v2＝章級分片（v1 是「一卷一檔、正文包在裡面」）
  updated: new Date().toISOString(),   // 若最後發現整包內容都沒變，收尾時會還原成舊值
  kdf: { salt: salt.toString('base64'), iter: ITER, hash: 'SHA-256' },
  // check 用來快速驗證密碼是否正確。它的 iv 也是隨機的，每次重算會讓 index.json 無謂變動 →
  // 只要 kdf 參數沒變（＝同一把 key），就沿用舊的那份，舊 check 一樣驗得過。
  check: (OLD_INDEX && OLD_INDEX.check && OLD_INDEX.kdf
    && OLD_INDEX.kdf.salt === salt.toString('base64') && OLD_INDEX.kdf.iter === ITER)
    ? OLD_INDEX.check
    : encrypt(key, Buffer.from('moren-ok', 'utf8')),
  volumes: [],
};

// 純正文去空白計法：去掉所有空白與標點符號，只算實際文字（Ming 定的分卷字數口徑）
const pureLen = (s) => s.replace(/[\s\p{P}\p{S}]/gu, '').length;
let totalCh = 0, totalChars = 0, totalPure = 0;
const wordReport = [];   // 逐卷字數，供推送後「回報三項」直接取用
const chapterFiles = [];   // 這次所有章檔的相對路徑（收尾清孤兒要用）
const seenChNo = new Map();
for (const v of volumes) {
  const file = v.id + '.json';
  // 逐章各自加密成 data/ch/NNNN.json；目錄裡只留 {n,title,mature,file,sha}，不含正文
  const manifest = v.chapters.map((c) => {
    const nnn = String(c.n).padStart(4, '0');
    if (seenChNo.has(nnn)) {
      console.error(`✗ 章號 ${nnn} 重複（${seenChNo.get(nnn)} 與 ${v.id}）——章號必須全書唯一，否則章檔會互蓋。`);
      process.exit(1);
    }
    seenChNo.set(nnn, v.id);
    const chFile = 'ch/' + nnn + '.json';
    // ⚠️ 鍵的順序＝手機端 App 重算指紋時的順序，兩邊必須完全一致，否則同一份內容會算出不同 sha
    const chPayload = Buffer.from(JSON.stringify({ n: c.n, title: c.title, body: c.body, mature: c.mature }), 'utf8');
    const sha = emit(chFile, chPayload, oldChapterSha(v.id, c.n));
    chapterFiles.push(chFile);
    return { n: c.n, title: c.title, mature: c.mature, file: chFile, sha };
  });
  const payload = Buffer.from(JSON.stringify({ id: v.id, title: v.title, chapters: manifest }), 'utf8');
  index.volumes.push({ id: v.id, file, chapters: manifest.length, sha: emit(file, payload) });
  const volPure = v.chapters.reduce((s, c) => s + pureLen(c.body), 0);
  totalCh += v.chapters.length;
  totalChars += v.chapters.reduce((s, c) => s + c.body.length, 0);
  totalPure += volPure;
  wordReport.push({ title: v.title, chapters: v.chapters.length, pure: volPure });
}

// 備選版本（加密）
const alternates = scanAlternates();
if (alternates.length) {
  const payload = Buffer.from(JSON.stringify({ chapters: alternates }), 'utf8');
  index.alternates = { file: 'alternates.json', count: alternates.length, sha: emit('alternates.json', payload) };
}

// ── 以下三包「只有 --full 才重打包」（Ming 2026-08-18 定）──────────────
// 快速更新（預設）＝只推正文：章節 ＋ 備選版本。設定集／大腦／素材一律原地不動、連掃都不掃。
// ⚠️ 連 settings.json 也是——就算這次真的改了設定集，沒下 --full 就不推（Ming 明確要的）。
//    代價：手機 App 的「設定」區會停在上次 --full 的版本，直到下次全檔更新。
// carry()：把舊 index 的那一欄整個搬過來，並登記進 kept ⇒ 收尾的孤兒清理不會誤刪那個檔。
function carry(field) {
  const old = OLD_INDEX && OLD_INDEX[field];
  if (!old || !existsSync(join(OUT, old.file))) return;   // 線上／本地還沒有這包 → 這次就沒有，等 --full 建
  index[field] = old;
  kept.push(old.file);
}
let settings = [], brain = [], assets = [];
if (FULL) {
  // 設定集 5 份 md（App「設定」區讀這包）
  settings = scanSettings();
  if (settings.length) {
    const payload = Buffer.from(JSON.stringify({ docs: settings }), 'utf8');
    index.settings = { file: 'settings.json', count: settings.length, sha: emit('settings.json', payload) };
  }
  // 小說大腦＋墨刃 CLAUDE.md（App 不讀，只供另一台電腦 pull 回整包進度）
  brain = scanBrain();
  if (brain.length) {
    const payload = Buffer.from(JSON.stringify({ files: brain }), 'utf8');
    index.brain = { file: 'brain.json', count: brain.length, sha: emit('brain.json', payload) };
  }
  // 設定集素材（地圖等非 md）。幾乎不變，故與大腦拆成兩個檔，不被大腦的日常變動拖著重寫。
  assets = scanAssets();
  if (assets.length) {
    const payload = Buffer.from(JSON.stringify({ files: assets }), 'utf8');
    index.assets = { file: 'assets.json', count: assets.length, sha: emit('assets.json', payload) };
  }
} else {
  carry('settings');
  carry('brain');
  carry('assets');
}

// 收尾：清孤兒檔（卷被刪／改名留下的舊密文），再決定 updated 要不要動
const contentFiles = new Set([
  ...index.volumes.map((v) => v.file), ...chapterFiles,
  index.alternates?.file, index.settings?.file, index.brain?.file, index.assets?.file,
].filter(Boolean));
// 遞迴列出 data/ 底下的檔（相對路徑、一律 / 分隔）—— 章檔在子目錄，舊的平面掃描看不到
function listOut(dir = OUT, base = '') {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + d.name : d.name;
    if (d.isDirectory()) out.push(...listOut(join(dir, d.name), rel));
    else out.push(rel);
  }
  return out;
}
const orphans = listOut().filter((f) => f !== 'index.json' && !contentFiles.has(f));
for (const f of orphans) rmSync(join(OUT, f), { force: true });
// 除了 updated 之外與上次完全相同 → 這次打包實質沒有任何變化。
// 把 updated 也還原成舊值，index.json 位元組就完全一樣 → git 乾淨 → --push 走「內容無變更，略過推送」。
const noChange = OLD_INDEX
  && JSON.stringify({ ...index, updated: 0 }) === JSON.stringify({ ...OLD_INDEX, updated: 0 });
if (noChange) index.updated = OLD_INDEX.updated;

writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));

console.log(`✓ 打包完成：${volumes.length} 卷、${totalCh} 章、約 ${totalChars.toLocaleString()} 字（含標點）` +
  (alternates.length ? `、${alternates.length} 篇備選` : '') +
  (FULL
    ? (settings.length ? `、${settings.length} 份設定` : '') +
      (index.brain ? `、大腦 ${index.brain.count} 檔` : '') +
      (index.assets ? `、素材 ${index.assets.count} 檔` : '')
    : '') + ` → ${OUT}`);

console.log(FULL
  ? '· 模式：⭐全檔更新（--full）── 連 設定集／小說大腦／CLAUDE.md／地圖素材 一起重打包。'
  : '· 模式：快速更新（預設）── 只推正文（章節＋備選版本）；' +
    (index.settings || index.brain || index.assets
      ? '設定集／大腦／素材沿用上次那份、原地未動。⚠️ 要讓它們上線得跑「全檔更新」（--full）。'
      : '⚠️ 尚未建立過設定／大腦／素材包，請跑一次 --full。'));

// 指紋比對結果：沿用＝這次沒重新加密、git 也看不到差異
if (noChange) {
  console.log('· 整包內容與上次完全相同（全部沿用舊密文，data/ 一個 byte 都沒動）→ 推送會自動略過。');
} else {
  const chRebuilt = rebuilt.filter((f) => f.startsWith('ch/'));
  const other = rebuilt.filter((f) => !f.startsWith('ch/'));
  const parts = [];
  if (chRebuilt.length) parts.push(`${chRebuilt.length} 章（${chRebuilt.map((f) => f.slice(3, -5)).join('、')}）`);
  if (other.length) parts.push(other.join('、'));
  const bytes = rebuilt.reduce((sum, f) => { try { return sum + statSync(join(OUT, f)).size; } catch { return sum; } }, 0);
  console.log(`· 重新加密 ${rebuilt.length} 檔：${parts.join(' ＋ ') || '無'}` +
    `（共 ${(bytes / 1024).toFixed(0)} KB）` +
    (kept.length ? `；沿用 ${kept.length} 檔（內容未變、原地不動）` : '') +
    (orphans.length ? `；清掉 ${orphans.length} 個孤兒檔` : ''));
}

// 推送後「回報三項」用（Ming 定）：① 總章數 ② 總字數 ③ 逐卷字數（純正文去空白計法）
console.log(`── 字數統計（純正文去空白）── 共 ${totalCh} 章、${totalPure.toLocaleString()} 字`);
for (const r of wordReport) {
  console.log(`   · ${r.title}：${r.chapters} 章、${r.pure.toLocaleString()} 字`);
}

// ── 可選：推上 GitHub ───────────────────────────────────
if (process.argv.includes('--push')) {
  try {
    const run = (cmd) => execSync(cmd, { cwd: __dirname, stdio: 'pipe' }).toString().trim();
    run('git add -A');
    // 沒有變更就不 commit
    const status = run('git status --porcelain');
    if (!status) { console.log('· 內容無變更，略過推送。'); process.exit(0); }
    // commit 訊息反映這次「真正重新加密了什麼」——只改大腦時別再寫成「更新章節」
    const NAME = { 'brain.json': '大腦', 'assets.json': '素材', 'settings.json': '設定', 'alternates.json': '備選' };
    // ch/NNNN.json 與 volXX.json 都歸「章節」；避免 87 個章檔各自變成一個標籤
    const what = [...new Set(rebuilt.map((f) => NAME[f] || '章節'))].join('＋') || '內容';
    run(`git commit -m "更新墨刃${what}（${totalCh} 章）"`);
    run('git push');
    console.log('✓ 已推上 GitHub，手機開 App 即可看到最新章節。');
  } catch (e) {
    console.error('✗ 推送失敗：', e.stderr ? e.stderr.toString() : e.message);
    process.exit(1);
  }
}
