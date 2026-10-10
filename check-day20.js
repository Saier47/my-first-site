#!/usr/bin/env node
/* =====================================================================
 * check-day20.js —— Day 20 自检
 * ---------------------------------------------------------------------
 * 今天做的是「把前端接上云接口」。这个脚本查三件事：
 *
 *   【A】接口层（真打公网）—— 服务活着、跨域头在、数据真返回
 *   【B】前端文件层（读本地源码）—— store.js 真的改成调接口了
 *   【C】线上部署层（真拉公网文件）—— 传上去的就是本地这一份
 *
 * ⚠️ 静态层不 spawn 子进程（Node 沙箱禁止，Day 15 踩过）；
 *    要发 HTTP 就用 Node 18+ 内置 fetch，主流程写成 async IIFE。
 *
 * 跑法：D:/node.exe check-day20.js
 * ===================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ENV_ID = 'my-first-site-d0g3re4p71560e327';
const HASH = '1500310885';
const PAGE_BASE = `https://${ENV_ID}-${HASH}.tcloudbaseapp.com`;
const API_BASE = `https://${ENV_ID}-${HASH}.ap-shanghai.app.tcloudbase.com`;

let pass = 0, fail = 0;
const failedItems = [];

function ok(label) { pass++; console.log('  ✅ ' + label); }
function ng(label, extra) {
  fail++; failedItems.push(label);
  console.log('  ❌ ' + label + (extra ? '  → ' + extra : ''));
}
function check(label, cond, extra) { cond ? ok(label) : ng(label, extra); }
function head(t) { console.log('\n【' + t + '】'); }

/* 带超时的 fetch。默认 20 秒 —— 云端冷启动偶尔慢，但也不该无限等。 */
async function req(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 可能不是 JSON */ }
    return { status: r.status, headers: r.headers, text, json };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log('════════════════════════════════════════════');
  console.log('  Day 20 自检 · 前端接云接口');
  console.log('  ' + new Date().toISOString());
  console.log('════════════════════════════════════════════');

  /* ================= A. 接口层（真打公网） ================= */
  head('A. 接口层（真打公网）');

  const health = await req(API_BASE + '/api/health');
  check('A1 /api/health 返回 200', health.status === 200, 'HTTP ' + health.status);
  check('A2 health body 里 ok=true', health.json && health.json.ok === true,
    JSON.stringify(health.json));

  const courses = await req(API_BASE + '/api/courses');
  check('A3 /api/courses 返回 200', courses.status === 200, 'HTTP ' + courses.status);
  check('A4 courses 是数组且有数据',
    courses.json && Array.isArray(courses.json.data) && courses.json.data.length > 0,
    '条数：' + (courses.json && courses.json.data ? courses.json.data.length : 'N/A'));

  const ddls = await req(API_BASE + '/api/ddls');
  check('A5 /api/ddls 返回 200', ddls.status === 200, 'HTTP ' + ddls.status);
  check('A6 ddls 是数组且有数据',
    ddls.json && Array.isArray(ddls.json.data) && ddls.json.data.length > 0,
    '条数：' + (ddls.json && ddls.json.data ? ddls.json.data.length : 'N/A'));

  // 跨域：今天要掌握的那件事的"实物证据"
  const ORIGIN = PAGE_BASE;
  const withOrigin = await req(API_BASE + '/api/courses', { headers: { Origin: ORIGIN } });
  const allowOrigin = withOrigin.headers.get('access-control-allow-origin');
  check('A7 带 Origin 的请求，响应里有 access-control-allow-origin',
    !!allowOrigin, '实际：' + allowOrigin);
  check('A8 allow-origin 回显了页面来源（不是写死的 *）',
    allowOrigin === ORIGIN, '实际：' + allowOrigin);

  const preflight = await req(API_BASE + '/api/courses', {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  check('A9 跨域预检 OPTIONS 被接受（2xx）',
    preflight.status >= 200 && preflight.status < 300, 'HTTP ' + preflight.status);
  check('A10 预检响应里有 allow-methods',
    !!preflight.headers.get('access-control-allow-methods'),
    '实际：' + preflight.headers.get('access-control-allow-methods'));

  /* ================= B. 前端文件层（读本地源码） ================= */
  head('B. 前端文件层（读本地源码）');

  const storeSrc = fs.readFileSync(path.join(ROOT, 'store.js'), 'utf8');

  check('B1 store.js 里有 API_BASE 常量', /const\s+API_BASE\s*=/.test(storeSrc));
  check('B2 store.js 用 fetch 调接口', /\bfetch\s*\(/.test(storeSrc));
  // 反例：还在读 localStorage 就算没改干净
  check('B3 store.js 代码里不再直接读 localStorage（注释不算）',
    !/^\s*[^*/]*localStorage\.(get|set)Item/m.test(storeSrc.replace(/^\s*\*.*$/gm, '')),
    '还有代码在碰 localStorage');
  check('B4 store.js 里有统一拆信封的函数',
    /payload\.ok\s*!==\s*true/.test(storeSrc));

  // 8 个函数的签名一个不能少（今天的铁律）
  const SIGS = ['listCourses', 'createCourse', 'updateCourse', 'deleteCourse',
    'listDdls', 'createDdl', 'updateDdl', 'deleteDdl'];
  const missing = SIGS.filter(function (n) {
    return !new RegExp(n + '\\s*:\\s*async\\s+function').test(storeSrc);
  });
  check('B5 8 个函数签名一个不少（' + SIGS.length + ' 个）',
    missing.length === 0, '缺：' + missing.join(', '));

  // 加练项
  check('B6 加练：store.js 暴露 getLastSyncedAt', /getLastSyncedAt/.test(storeSrc));

  const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('B7 加练：index.html 有 sync-note 节点', /id="sync-note"/.test(htmlSrc));
  check('B8 加练：index.html 有 .sync-note 样式', /\.sync-note\s*\{/.test(htmlSrc));

  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  check('B9 加练：app.js 会渲染同步时间', /renderSyncNote\s*\(/.test(appSrc));
  // app.js 不许自己碰数据来源 —— 分层规矩
  check('B10 app.js 里没出现 API_BASE（视图层不打听接口地址）',
    !/API_BASE/.test(appSrc));
  check('B11 app.js 里没出现 fetch 调接口',
    !/fetch\s*\(\s*['"`]https?:/.test(appSrc));

  /* ================= C. 线上部署层（真拉公网文件） ================= */
  head('C. 线上部署层（真拉公网文件）');

  const FILES = ['index.html', 'app.js', 'store.js', 'mock-data.js',
    'manifest.json', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

  for (const f of FILES) {
    const r = await req(PAGE_BASE + '/' + f + '?t=' + Date.now());
    const localSize = fs.statSync(path.join(ROOT, f)).size;
    const remoteSize = Buffer.byteLength(r.text, 'utf8');
    const same = (r.status === 200) && (
      // 文本文件比对字节数；二进制(图片)只看状态码，避免编码换算误差
      /\.(png)$/.test(f) ? true : Math.abs(localSize - remoteSize) <= 2
    );
    check('C ' + f + ' 线上 200 且与本地一致',
      same, 'HTTP ' + r.status + ' 本地 ' + localSize + ' / 线上 ' + remoteSize);
  }

  // 线上 store.js 必须是新版（不能还是 localStorage 那版）
  const remoteStore = await req(PAGE_BASE + '/store.js?t=' + Date.now());
  check('C9 线上 store.js 是新版（含 API_BASE）',
    /API_BASE/.test(remoteStore.text));
  check('C10 线上 store.js 不含 localStorage 读数据',
    !/localStorage\.(get|set)Item/.test(remoteStore.text.replace(/^\s*\*.*$/gm, '')));

  // 线上首页是自己的页面（不是平台的警告页）
  const home = await req(PAGE_BASE + '/index.html?t=' + Date.now());
  check('C11 线上首页是自己的页面（标题含"这一周"）',
    /<title>[^<]*这一周[^<]*<\/title>/.test(home.text));
  check('C12 线上首页引用了 store.js / app.js',
    /store\.js/.test(home.text) && /app\.js/.test(home.text));

  /* ================= 汇总 ================= */
  console.log('\n════════════════════════════════════════════');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('\n  失败清单：');
    failedItems.forEach(function (t) { console.log('    · ' + t); });
  }
  console.log('════════════════════════════════════════════');

  process.exit(fail === 0 ? 0 : 1);
})().catch(function (err) {
  console.error('\n💥 脚本自己崩了（这不是被测对象的问题）：');
  console.error(err && err.stack ? err.stack : err);
  process.exit(2);
});
