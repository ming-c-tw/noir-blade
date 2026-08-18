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
const GOLD = [246, 228, 146];  // 淺黃（黎明淡光）
const BLK = [26, 24, 20];      // 黑刀（帶一點暖）

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

// ── 武士刀幾何（沿弧形中心線；正規化座標 0..1，y 向下）──
// 中心線＝二次貝茲：A 柄尾(左下) → T 刀尖(右上)，C 控制點給刀身弧度(sori)
const A = [0.255, 0.755], T = [0.775, 0.225];
const _dx = T[0] - A[0], _dy = T[1] - A[1], _dl = Math.hypot(_dx, _dy);
const _dir = [_dx / _dl, _dy / _dl];
const _perp = [-_dir[1], _dir[0]];                       // 中心線法向
const _mid = [(A[0] + T[0]) / 2, (A[1] + T[1]) / 2];
const CURVE = 0.085;                                     // 刀身彎度（sori，往刀背側鼓）
const C = [_mid[0] - _perp[0] * CURVE, _mid[1] - _perp[1] * CURVE];

const bez = (t) => { const m = 1 - t; return [m * m * A[0] + 2 * m * t * C[0] + t * t * T[0], m * m * A[1] + 2 * m * t * C[1] + t * t * T[1]]; };
const tangent = (t) => { const m = 1 - t; let x = 2 * m * (C[0] - A[0]) + 2 * t * (T[0] - C[0]), y = 2 * m * (C[1] - A[1]) + 2 * t * (T[1] - C[1]); const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
const normal = (t) => { const tg = tangent(t); return [-tg[1], tg[0]]; };
const off = (t, dd) => { const q = bez(t), n = normal(t); return [q[0] + n[0] * dd, q[1] + n[1] * dd]; };

// 沿中心線在 [t0,t1] 兩側各偏移 halfW（可為函式 u→寬）建帶狀多邊形
function band(t0, t1, halfW, steps) {
  const top = [], bot = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps, t = t0 + (t1 - t0) * u;
    const hw = typeof halfW === 'function' ? halfW(u) : halfW;
    top.push(off(t, hw)); bot.push(off(t, -hw));
  }
  return top.concat(bot.reverse());
}
// 護手（tsuba）：在 t 處沿法向拉長、沿切向給厚度的橫桿
function guard(t, halfLen, halfThick) {
  const q = bez(t), n = normal(t), tg = tangent(t);
  const a = [q[0] + n[0] * halfLen, q[1] + n[1] * halfLen], b = [q[0] - n[0] * halfLen, q[1] - n[1] * halfLen];
  return [
    [a[0] + tg[0] * halfThick, a[1] + tg[1] * halfThick], [b[0] + tg[0] * halfThick, b[1] + tg[1] * halfThick],
    [b[0] - tg[0] * halfThick, b[1] - tg[1] * halfThick], [a[0] - tg[0] * halfThick, a[1] - tg[1] * halfThick],
  ];
}

const TG = 0.30;   // 柄與刀身分界（柄約佔 30%、刀身 70%）
const POLYS = [
  band(0.0, TG, 0.026, 20),                                        // 刀柄（tsuka）
  guard(TG, 0.058, 0.013),                                         // 護手（tsuba）
  band(TG + 0.005, 1.0, (u) => 0.024 * Math.pow(1 - u, 0.7), 70),  // 刀身：細長、往刀尖收成點
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
