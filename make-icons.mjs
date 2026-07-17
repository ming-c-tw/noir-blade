#!/usr/bin/env node
// 一次性產生 App 圖示：黎明黃底 + 一把黑色的刀（單刃、帶柄與護手）。
// 純 Node（zlib），不裝任何套件。輸出 icons/icon-192.png、icon-512.png。
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'icons');
mkdirSync(OUT, { recursive: true });

// 色票
const GOLD = [233, 178, 46];   // 黎明黃底
const BLK = [22, 20, 16];      // 黑刀（帶一點暖）

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

// 刀的幾何（正規化座標 0..1，y 向下）
const A = [0.30, 0.70], T = [0.72, 0.28];               // 柄端 → 刀尖
const d = [T[0] - A[0], T[1] - A[1]];
const dl = Math.hypot(d[0], d[1]);
const dn = [d[0] / dl, d[1] / dl];
const p = [-dn[1], dn[0]];                               // 垂直方向
const at = (s, t) => [A[0] + s * d[0] + t * p[0], A[1] + s * d[1] + t * p[1]];

// 建立各多邊形
function bladePoly() {
  const N = 44, pts = [];
  for (let i = 0; i <= N; i++) { const u = i / N, s = 0.235 + u * (1 - 0.235); pts.push(at(s, +0.032 * (1 - u ** 4))); }     // 刀背（略直、近尖收）
  for (let i = N; i >= 0; i--) { const u = i / N, s = 0.235 + u * (1 - 0.235); pts.push(at(s, -((0.045 + 0.045 * Math.sin(Math.PI * u)) * (1 - u ** 8)))); } // 刀刃（帶弧腹）
  return pts;
}
const quad = (s0, s1, w) => [at(s0, w), at(s1, w), at(s1, -w), at(s0, -w)];
const POLYS = [
  quad(-0.03, 0.205, 0.030),   // 刀柄
  quad(0.205, 0.240, 0.085),   // 護手（tsuba）
  bladePoly(),                 // 刀身
];

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function render(Npx) {
  const buf = Buffer.alloc(Npx * Npx * 4);
  const SS = 4;                                    // 4×4 超取樣抗鋸齒
  for (let y = 0; y < Npx; y++) {
    for (let x = 0; x < Npx; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const nx = (x + (sx + 0.5) / SS) / Npx, ny = (y + (sy + 0.5) / SS) / Npx;
        if (POLYS.some((poly) => inPoly(nx, ny, poly))) hit++;
      }
      const cov = hit / (SS * SS);
      const r = GOLD[0] + (BLK[0] - GOLD[0]) * cov;
      const g = GOLD[1] + (BLK[1] - GOLD[1]) * cov;
      const b = GOLD[2] + (BLK[2] - GOLD[2]) * cov;
      const i = (y * Npx + x) * 4;
      buf[i] = clamp(r); buf[i + 1] = clamp(g); buf[i + 2] = clamp(b); buf[i + 3] = 255;
    }
  }
  return buf;
}

// ── 最小 PNG 編碼（RGBA / color type 6）──
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(Npx, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(Npx, 0); ihdr.writeUInt32BE(Npx, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(Npx * (Npx * 4 + 1));
  for (let y = 0; y < Npx; y++) { raw[y * (Npx * 4 + 1)] = 0; rgba.copy(raw, y * (Npx * 4 + 1) + 1, y * Npx * 4, (y + 1) * Npx * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

for (const N of [192, 512]) {
  writeFileSync(join(OUT, `icon-${N}.png`), encodePNG(N, render(N)));
  console.log(`✓ icons/icon-${N}.png`);
}
