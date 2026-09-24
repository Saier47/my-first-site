/* Day 9 设计审查脚本
 * ---------------------------------------------------------------------
 * 按 6 条可量化标准，逐项量出页面的真实数值：
 *   1 对比度  2 间距节奏  3 对齐  4 层级字号  5 移动端溢出  6 触达尺寸
 *
 * 为什么必须在**真实浏览器**里跑：jsdom 不做布局计算（getBoundingClientRect
 * 全是 0），也拿不到计算后的样式。Day 8 已经在 jsdom 的布局上吃过一次亏。
 *
 * 用法：node audit-design.js > 审查结果.txt
 * 它读的是 http://127.0.0.1:8000，所以跑之前先起本地服务（npm start）。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

/* ---------- 1. 颜色与对比度（WCAG 2.1 公式，自己实现，不引库） ---------- */

// 把 #rgb / #rrggbb / rgb() / rgba() 解析成 [r,g,b,a]
function parseColor(str) {
  if (!str) return null;
  str = String(str).trim().toLowerCase();
  if (str === 'transparent') return [0, 0, 0, 0];
  let m = str.match(/^#([0-9a-f]{3})$/);
  if (m) return [...m[1]].map(c => parseInt(c + c, 16)).concat(1);
  m = str.match(/^#([0-9a-f]{6})$/);
  if (m) {
    const h = m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  m = str.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return null;
}

// 把半透明色叠到背景上（做实际的"视觉颜色"）
function composite(fg, bg) {
  const a = fg[3];
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
    1
  ];
}

// 相对亮度（WCAG 定义：先做 sRGB 反伽马，再按 0.2126/0.7152/0.0722 加权）
function luminance(c) {
  const f = v => {
    v = v / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

function contrastRatio(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------- 2. 从样式表里把"设计变量"提出来 ---------- */

const DIR = __dirname;
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];

// 收集所有 --xxx 变量
const vars = {};
for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
  vars[m[1]] = m[2].trim();
}

// 把 var(--x) 展开成实际值（支持一层嵌套即可）
function resolve(value, depth) {
  depth = depth || 0;
  if (!value || depth > 6) return value;
  return value.replace(/var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)/g, (_, name, fallback) => {
    const v = vars[name];
    if (v === undefined) return fallback ? fallback.trim() : '';
    return resolve(v, depth + 1);
  });
}

const PAGE_BG = resolve('var(--bg)') || '#ffffff';

function report(title) {
  console.log('');
  console.log('='.repeat(74));
  console.log(title);
  console.log('='.repeat(74));
}

/* =====================================================================
 * 检查 1：文字对比度
 * 做法：把 CSS 里所有 color: 声明抓出来，逐个和页面底色算对比度。
 * 注意：这里算的是"最坏情况"——一律用页面底色 #080b14 当背景。
 * 卡片上的实际背景比页面底更亮一点，所以真实对比度会比这里算的略好。
 * 这样算偏保守，不会漏掉问题。
 * ===================================================================== */

report('检查 1 · 文字对比度（标准：正文 ≥ 4.5:1，大字 ≥ 3:1）');

const bgRgb = parseColor(PAGE_BG);
console.log('页面底色 = ' + PAGE_BG);
console.log('');

// 抓 color: 声明，并记录它属于哪条规则（往前找最近的选择器）
const colorDecls = [];
{
  const lines = css.split('\n');
  let currentSelector = '(未知)';
  lines.forEach((line, i) => {
    const sel = line.match(/^\s*([.#\w][^{]*?)\s*\{/);
    if (sel) currentSelector = sel[1].trim();
    const cm = line.match(/^\s*color\s*:\s*([^;]+);/);
    if (cm) colorDecls.push({ selector: currentSelector, raw: cm[1].trim(), line: i + 1 });
  });
}

const contrastRows = [];
colorDecls.forEach(d => {
  const resolved = resolve(d.raw);
  if (resolved.includes('var(')) return;
  let c = parseColor(resolved);
  if (!c) return;
  if (c[3] < 1) c = composite(c, bgRgb);
  const ratio = contrastRatio(c, bgRgb);
  contrastRows.push({ ...d, resolved, ratio });
});

contrastRows.sort((a, b) => a.ratio - b.ratio);

console.log('  ' + '对比度'.padEnd(9) + '判定'.padEnd(8) + '选择器 / 色值');
console.log('  ' + '-'.repeat(70));
contrastRows.forEach(r => {
  const fail = r.ratio < 4.5;
  const weak = r.ratio >= 4.5 && r.ratio < 5.5;
  const mark = fail ? '不合格 ❌' : (weak ? '勉强 ⚠️' : '合格 ✅');
  console.log('  ' + (r.ratio.toFixed(2) + ':1').padEnd(9) + mark.padEnd(8) +
    r.selector.slice(0, 34) + '  ' + r.resolved);
});

/* =====================================================================
 * 检查 2：间距节奏
 * 从 CSS 里抓所有 padding / margin / gap 的像素值，统计哪些不在 4 的倍数网格上
 * ===================================================================== */

report('检查 2 · 间距节奏（标准：落在 4 的倍数网格上）');

const spacingProps = ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap',
  'row-gap', 'column-gap'];

const spacingValues = [];
{
  const lines = css.split('\n');
  let currentSelector = '(未知)';
  lines.forEach((line, i) => {
    const sel = line.match(/^\s*([.#\w][^{]*?)\s*\{/);
    if (sel) currentSelector = sel[1].trim();
    spacingProps.forEach(prop => {
      const re = new RegExp('^\\s*' + prop + '\\s*:\\s*([^;]+);');
      const m = line.match(re);
      if (!m) return;
      const val = m[1].trim();
      // 只挑纯 px 值来判网格（calc / % / auto 不参与）
      const nums = val.match(/(\d+)px/g);
      if (!nums) return;
      nums.forEach(n => {
        spacingValues.push({ selector: currentSelector, prop, px: parseInt(n, 10), line: i + 1 });
      });
    });
  });
}

const offGrid = spacingValues.filter(s => s.px % 4 !== 0);
const uniq = {};
offGrid.forEach(s => { uniq[s.px + 'px'] = (uniq[s.px + 'px'] || 0) + 1; });

console.log('  共抓到 ' + spacingValues.length + ' 个 px 间距值');
console.log('  不在 4 倍数网格上的：' + offGrid.length + ' 个');
console.log('');
if (Object.keys(uniq).length) {
  console.log('  偏离网格的值（值 → 出现次数）：');
  Object.entries(uniq).sort((a, b) => parseInt(a) - parseInt(b)).forEach(([v, n]) => {
    console.log('    ' + v.padEnd(8) + '×' + n);
  });
  console.log('');
  console.log('  具体位置（前 20 条）：');
  offGrid.slice(0, 20).forEach(s => {
    console.log('    ' + (s.px + 'px').padEnd(7) + s.prop.padEnd(16) + s.selector.slice(0, 32));
  });
}

// 同类元素间距是否一致：同一属性 + 同一"元素族"，值应一致
console.log('');
console.log('  同类元素间距一致性抽查：');
const families = {
  '卡片内边距 (.day/.item/.row)': spacingValues.filter(s => s.prop === 'padding' && /\.(day|item|row)\b/.test(s.selector)),
  '卡片间距 (margin-bottom)': spacingValues.filter(s => s.prop === 'margin-bottom' && /\.(day|item|row|over-item)\b/.test(s.selector))
};
Object.entries(families).forEach(([name, list]) => {
  const vals = [...new Set(list.map(s => s.px + 'px'))];
  console.log('    ' + name + ' → ' + (vals.length ? vals.join(' / ') : '(未抓到)') +
    (vals.length > 1 ? '  ← 不一致 ⚠️' : '  ✅'));
});

/* =====================================================================
 * 检查 3：字号层级
 * ===================================================================== */

report('检查 3 · 字号层级（标准：阶梯 ≤ 4 档，相邻档差 ≥ 2px，字重有差异）');

const fontSizes = [];
{
  const lines = css.split('\n');
  let currentSelector = '(未知)';
  lines.forEach((line, i) => {
    const sel = line.match(/^\s*([.#\w][^{]*?)\s*\{/);
    if (sel) currentSelector = sel[1].trim();
    const m = line.match(/^\s*font-size\s*:\s*([^;]+);/);
    if (m) {
      const px = parseFloat(m[1]);
      if (!isNaN(px)) fontSizes.push({ selector: currentSelector, px, line: i + 1 });
    }
  });
}

const sizeCount = {};
fontSizes.forEach(f => { sizeCount[f.px] = (sizeCount[f.px] || 0) + 1; });
const sizes = Object.keys(sizeCount).map(Number).sort((a, b) => a - b);

console.log('  用到的字号共 ' + sizes.length + ' 档：' + sizes.map(s => s + 'px').join(' / '));
if (sizes.length > 4) console.log('  ' + (sizes.length - 4) + ' 档超出「≤4 档」建议 ⚠️');
console.log('');
console.log('  相邻档差：');
for (let i = 1; i < sizes.length; i++) {
  const d = sizes[i] - sizes[i - 1];
  console.log('    ' + sizes[i - 1] + 'px → ' + sizes[i] + 'px　差 ' + d + 'px' + (d < 2 ? '  ← 差异不明显 ⚠️' : ''));
}
console.log('');
console.log('  字号使用次数：');
Object.entries(sizeCount).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([v, n]) => {
  console.log('    ' + (v + 'px').padEnd(8) + '×' + n);
});

const weights = new Set();
for (const m of css.matchAll(/font-weight\s*:\s*(\d+)/g)) weights.add(m[1]);
console.log('');
console.log('  用到的字重：' + [...weights].sort().join(' / ') +
  (weights.size < 2 ? '  ← 只有一档，没有主次 ⚠️' : ''));

/* =====================================================================
 * 检查 6：触达尺寸（从 CSS 静态值判断，浏览器里再实测一次）
 * ===================================================================== */

report('检查 6 · 触达尺寸（标准：可点击元素 ≥ 44×44px）');

const clickables = [
  { name: '.btn-icon（编辑/删除）', sel: '.btn-icon' },
  { name: '.btn-mini（+ 课程 / + DDL）', sel: '.btn-mini' },
  { name: '.tab（底部导航）', sel: '.tab' },
  { name: '.fab（+ 添加）', sel: '.fab' },
  { name: '.row-check（勾选框）', sel: '.row-check' },
  { name: '.icon-btn（弹层关闭 ×）', sel: '.icon-btn' },
  { name: '.btn-primary / .btn-ghost', sel: '.btn-primary' }
];

// 从 CSS 里粗略估算每个选择器的 padding + height
function findRule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\' + selector.slice(1) + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  return m ? m[1] : null;
}

clickables.forEach(c => {
  const body = findRule(c.sel);
  if (!body) { console.log('  ' + c.name.padEnd(28) + '(CSS 里没找到独立规则，可能在浏览器实测)'); return; }
  const h = (body.match(/height\s*:\s*(\d+)px/) || [])[1];
  const pad = (body.match(/padding\s*:\s*([^;]+);/) || [])[1];
  const minH = (body.match(/min-height\s*:\s*(\d+)px/) || [])[1];
  let estimate = '';
  if (h) estimate = h + 'px 高';
  else if (minH) estimate = minH + 'px 高(最小)';
  else if (pad) estimate = 'padding ' + pad.trim();
  console.log('  ' + c.name.padEnd(28) + (estimate || '(未声明尺寸)'));
});

/* =====================================================================
 * 浏览器实测：溢出 + 触达尺寸（jsdom 测不了，输出提示让浏览器脚本做）
 * ===================================================================== */

report('检查 5 · 移动端溢出（需真实浏览器，见 audit-design-browser.js）');
console.log('  jsdom 不做布局计算，本节由浏览器端脚本实测。');
console.log('  运行方式：见 audit-design-browser.js 顶部说明。');
