/* 「加到手机主屏」配置自检（check-pwa.js）
 * ---------------------------------------------------------------------
 * 锁住 Day 14 的修复：**这个网页必须能像一个正经 App 那样加到手机主屏。**
 *
 * 为什么要单独有个检查：
 *   加主屏这件事**坏起来是无声的** —— 少一个 meta、少一个图标文件，
 *   页面照常打开、测试照常全绿，只有真的把它加到主屏的人才知道
 *   "怎么是个白板图标、还没名字"。
 *   而那个人通常不是你。（这正是 Day 14 同伴反馈的由来。）
 *
 * 跑法：node check-pwa.js
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; fails.push(name + (extra ? ' -> ' + extra : '')); console.log('  \u274c ' + name + (extra ? ' -> ' + extra : '')); }
}

// 读 PNG 的真实尺寸（IHDR 在第 16~24 字节）——
// 不能只"文件存在"就算过：尺寸错了（比如 180 的图标其实是 512）同样会出问题。
function pngSize(file) {
  const buf = fs.readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47];
  if (!sig.every((b, i) => buf[i] === b)) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

console.log('=== 1. 三个图标文件 ===');
const ICONS = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 }
];
ICONS.forEach(function (ic) {
  const p = path.join(DIR, ic.file);
  if (!fs.existsSync(p)) { ok(ic.file + ' 存在', false, '文件没找到'); return; }
  const dim = pngSize(p);
  ok(ic.file + ' 是 ' + ic.size + 'x' + ic.size,
    !!dim && dim.w === ic.size && dim.h === ic.size,
    dim ? ('实际 ' + dim.w + 'x' + dim.h) : '不是合法 PNG');
});

console.log('\n=== 2. manifest.json ===');
const mfPath = path.join(DIR, 'manifest.json');
ok('manifest.json 存在', fs.existsSync(mfPath), '文件没找到');
let m = null;
try { m = JSON.parse(fs.readFileSync(mfPath, 'utf8')); } catch (e) { /* 下面会报 */ }
ok('manifest.json 是合法 JSON', !!m, '解析失败');
if (m) {
  ok('有 name（完整名）', typeof m.name === 'string' && m.name.length > 0, String(m.name));
  ok('有 short_name（主屏上显示的名字）',
    typeof m.short_name === 'string' && m.short_name.length > 0, String(m.short_name));
  ok('short_name 够短（长了主屏会截断）',
    typeof m.short_name === 'string' && m.short_name.length <= 6,
    '"' + m.short_name + '" 有 ' + (m.short_name || '').length + ' 个字');
  ok('display = standalone（打开后没有地址栏，才像 App）',
    m.display === 'standalone', String(m.display));
  ok('start_url 有', typeof m.start_url === 'string' && m.start_url.length > 0, String(m.start_url));
  ok('theme_color 和产品主色一致',
    m.theme_color === '#080b14', String(m.theme_color));
  ok('icons 里给了 192 和 512',
    Array.isArray(m.icons) &&
    m.icons.some(i => i.sizes === '192x192') &&
    m.icons.some(i => i.sizes === '512x512'),
    JSON.stringify((m.icons || []).map(i => i.sizes)));
  // manifest 里引用的图标必须真的存在，否则主屏上是个空位
  const missing = (m.icons || [])
    .filter(i => !fs.existsSync(path.join(DIR, i.src)))
    .map(i => i.src);
  ok('manifest 引用的图标文件都存在', missing.length === 0, '缺：' + missing.join(', '));
}

console.log('\n=== 3. index.html 的 head ===');
ok('引了 manifest', /<link[^>]+rel=["']manifest["']/.test(html));
ok('引了 apple-touch-icon',
  /<link[^>]+rel=["']apple-touch-icon["']/.test(html));
ok('有 apple-mobile-web-app-capable',
  /apple-mobile-web-app-capable/.test(html));
ok('有 apple-mobile-web-app-title（iOS 主屏上的名字）',
  /apple-mobile-web-app-title/.test(html));
ok('有 theme-color', /name=["']theme-color["']/.test(html));

console.log('\n=== 4. 全面屏适配（省了这条，底部导航会被 home 横条压住）===');
ok('viewport 里有 viewport-fit=cover（没有它 env() 永远是 0）',
  /viewport-fit=cover/.test(html));
ok('CSS 里用了 safe-area-inset-bottom',
  /safe-area-inset-bottom/.test(html));

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fails.length) {
  console.log('\n失败明细：');
  fails.forEach(f => console.log('  - ' + f));
}
process.exitCode = fail ? 1 : 0;
