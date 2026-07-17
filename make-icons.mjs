#!/usr/bin/env node
// 一次性產生 App 圖示：墨黑底 + 一道墨刃斜劃 + 朱紅印點。
// 純 Node（zlib），不裝任何套件。輸出 icons/icon-192.png、icon-512.png。
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'icons');
mkdirSync(OUT, { recursive: true });

// 色票
const BG = [15, 17, 21];       // #0f1115 墨黑
const INK = [232, 230, 224];   // 近白墨色
const SEAL = [176, 46, 40];    // 朱紅印

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// 點到線段距離
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { d: Math.hypot(px - cx, py - cy), t };
}

function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  // 斜劃兩端點（留安全區，避免 maskable 被裁）
  const ax = 0.30 * N, ay = 0.74 * N, bx = 0.70 * N, by = 0.26 * N;
  const sealX = 0.665 * N, sealY = 0.315 * N, sealR = 0.052 * N;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = BG[0], g = BG[1], b = BG[2];
      const px = x + 0.5, py = y + 0.5;

      // 墨刃斜劃：中段粗、兩端收（tapered）
      const { d, t } = distSeg(px, py, ax, ay, bx, by);
      const taper = Math.sin(Math.PI * t);            // 0→1→0
      const half = (0.018 + 0.060 * taper) * N;
      const cov = smooth(half + 1.2, half - 1.2, d);  // 抗鋸齒
      if (cov > 0) { r = r + (INK[0] - r) * cov; g = g + (INK[1] - g) * cov; b = b + (INK[2] - b) * cov; }

      // 朱紅印點
      const ds = Math.hypot(px - sealX, py - sealY);
      const covS = smooth(sealR + 1.2, sealR - 1.2, ds);
      if (covS > 0) { r = r + (SEAL[0] - r) * covS; g = g + (SEAL[1] - g) * covS; b = b + (SEAL[2] - b) * covS; }

      const i = (y * N + x) * 4;
      buf[i] = clamp(r); buf[i + 1] = clamp(g); buf[i + 2] = clamp(b); buf[i + 3] = 255;
    }
  }
  return buf;
}

// ── 最小 PNG 編碼（RGBA / color type 6）──
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(N, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // 每列前面加 filter byte 0
  const raw = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0;
    rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

for (const N of [192, 512]) {
  writeFileSync(join(OUT, `icon-${N}.png`), encodePNG(N, render(N)));
  console.log(`✓ icons/icon-${N}.png`);
}
