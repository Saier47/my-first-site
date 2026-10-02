/* 生成「加到主屏」用的图标（make-icons.js）
 * ---------------------------------------------------------------------
 * 为什么手写 PNG：本机没有 Pillow / sharp，为一个图标装依赖不值得。
 * 图标是纯几何图形（圆角底 + 7 根胶囊竖条），用像素算法直接画最省事，
 * 而且纯标准库、任意尺寸都能出 —— 顺便绕开了"无头浏览器最小视口 482px"
 * 那个坑（180px 的图标截不出来，但能算出来）。
 *
 * 设计含义：7 根竖条 = 一周 7 天；第 3 根最亮最长 = 今天。
 * 配色沿用产品（深底 + 品牌青），和主视图一致。
 *
 * 跑法：node make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = __dirname;
const BASE = 512;   // 设计基准坐标（所有数字按它写，再等比缩到目标尺寸）

// —— 配色（和产品主视图一致）——
const BG_TOP = [0x11, 0x1a, 0x2e];
const BG_BG = [0x08, 0x0b, 0x14];
const BAR = [0x2b, 0x6a, 0x72];        // 普通的一天（暗青）
const BAR_TODAY = [0x3d, 0xdb, 0xd9];  // 今天（品牌青，最亮）

const BAR_W = 34;
const BAR_R = BAR_W / 2;   // 圆角取一半宽 → 胶囊形
const BASE_Y = 396;        // 所有条的底部对齐到这里
const TODAY = 2;           // 第 3 根 = 今天

const H_NORMAL = 168;   // 平时的高度 —— **7 根等高**才对：
                        // 高低不一会读成"音频波形/柱状图"，等高才像"一周 7 列"，
                        // 也就是产品主视图本身的样子。
const H_TODAY = 216;    // 今天那根挑出来

// x 起点 95，间距 48（= 宽 34 + 间隙 14），7 根正好在 512 里居中
const BARS = [0, 1, 2, 3, 4, 5, 6].map(function (i) {
  return { x: 95 + i * 48, h: (i === TODAY) ? H_TODAY : H_NORMAL };
});

/* 有符号距离场：圆角矩形。负数在内部。
   用距离而不是"逐边判断"，是为了让抗锯齿自然 —— 0.5 距离内的像素自动半透明。 */
function rrDist(px, py, cx, cy, w, h, r) {
  const dx = Math.abs(px - cx) - (w / 2 - r);
  const dy = Math.abs(py - cy) - (h / 2 - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

// 距离 → 覆盖率（1px 宽的过渡带 = 抗锯齿）
function cov(dist) {
  return Math.min(Math.max(0.5 - dist, 0), 1);
}

function lerp(a, b, t) { return a + (b - a) * t; }

function render(size, square) {
  const k = size / BASE;
  const buf = Buffer.alloc(size * size * 4);
  // ⚠️ iOS 的 apple-touch-icon 必须是**方形不透明**的：
  // 系统自己会做圆角遮罩，图标自带圆角 + 透明角的话，那四个角会被填成黑色。
  // 所以 square=true 时圆角取 0，让底色铺满整块画布。
  const radius = square ? 0 : 112;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 采样点取像素中心，再换回 512 基准坐标
      const px = (x + 0.5) / k;
      const py = (y + 0.5) / k;

      let r = 0, g = 0, b = 0, a = 0;

      // ① 圆角底 + 竖向渐变
      const bgA = cov(rrDist(px, py, BASE / 2, BASE / 2, BASE, BASE, radius));
      if (bgA > 0) {
        const t = Math.min(Math.max(py / BASE, 0), 1);
        r = lerp(BG_TOP[0], BG_BG[0], t);
        g = lerp(BG_TOP[1], BG_BG[1], t);
        b = lerp(BG_TOP[2], BG_BG[2], t);
        a = bgA;
      }

      // ② 今天那根的微光。
      //    深色科技风的关键手法（Day 8 注释里写过）：光要有取舍 ——
      //    只给"今天"一根，其余不发光；全发光 = 全不发光。
      const tb = BARS[TODAY];
      const tTop = BASE_Y - tb.h;
      // 用条自己的距离场向外衰减 —— 不能用"放大一圈的圆角矩形"，
      // 那会得到一个边界生硬的实心块（看起来像 bug，不像光）。
      const dBar = rrDist(px, py, tb.x + BAR_W / 2, tTop + tb.h / 2, BAR_W, tb.h, BAR_R);
      const gT = Math.max(0, 1 - Math.max(dBar, 0) / 46);
      const glowA = gT * gT * 0.32;   // 平方衰减，比线性柔和
      if (glowA > 0) {
        r = BAR_TODAY[0] * glowA + r * (1 - glowA);
        g = BAR_TODAY[1] * glowA + g * (1 - glowA);
        b = BAR_TODAY[2] * glowA + b * (1 - glowA);
      }

      // ③ 7 根竖条（叠在底和光晕之上）
      for (let i = 0; i < BARS.length; i++) {
        const bar = BARS[i];
        const top = BASE_Y - bar.h;
        const d = rrDist(px, py, bar.x + BAR_W / 2, top + bar.h / 2, BAR_W, bar.h, BAR_R);
        const c = cov(d);
        if (c <= 0) continue;

        const col = (i === TODAY) ? BAR_TODAY : BAR;
        // 源覆盖（source-over）合成
        r = col[0] * c + r * (1 - c);
        g = col[1] * c + g * (1 - c);
        b = col[2] * c + b * (1 - c);
        a = c + a * (1 - c);
      }

      const o = (y * size + x) * 4;
      buf[o]     = Math.round(r);
      buf[o + 1] = Math.round(g);
      buf[o + 2] = Math.round(b);
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

/* ---- 最小 PNG 编码器（IHDR + IDAT + IEND，RGBA8，filter 0）---- */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(tag, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function toPng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;                       // 每行前缀：filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // 位深
  ihdr[9] = 6;    // 颜色类型 6 = RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// 180 = apple-touch-icon 标准尺寸（方形、不透明）；192 / 512 = manifest 要求
const TARGETS = [
  { size: 512, file: 'icon-512.png' },
  { size: 192, file: 'icon-192.png' },
  { size: 180, file: 'apple-touch-icon.png', square: true }
];

TARGETS.forEach(function (t) {
  const rgba = render(t.size, t.square);
  const out = path.join(DIR, t.file);
  fs.writeFileSync(out, toPng(t.size, rgba));
  console.log('  ' + t.file + '  ' + t.size + 'x' + t.size +
    (t.square ? '  (方形不透明)' : '  (圆角)') + '  ' +
    fs.statSync(out).size + ' bytes');
});
console.log('图标生成完毕。');
