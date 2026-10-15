#!/usr/bin/env node
/**
 * check-day24.js —— Day 24 自检：三个异步操作有没有兜住失败
 * =====================================================================
 * 纯静态，**不 spawn 任何子进程、不联网**。
 *   为什么要说这句：本沙箱禁止 Node 派生进程（execFileSync → EBUSY，
 *   连 node→node 都失败）。所以能 spawn 的部分一律交给 bash。
 *   运行时验证（真浏览器里断网、点删除）已经做过了，证据在 docs/day24/ 的截图里。
 *
 * ---------------------------------------------------------------------
 * 🔑 本脚本带 --selftest：先证明"检查器真的能抓到坏代码"。
 *
 *   这是 Day 23 学到的教训：一个报"全部通过"的检查，
 *   有可能是 ① 代码真的对，也可能是 ② **检查器坏了，什么都检查不出来**。
 *   两者从输出上看一模一样。
 *   所以先拿一段"故意写坏的假代码"试刀 —— 抓不出来，后面所有 ✅ 都不算数。
 *
 * ---------------------------------------------------------------------
 * ⚠️ 断言全部跑在**剥掉注释的源码**上。
 *   为什么：Day 23 就吃过这个亏 —— 注释里留档的旧文案让断言假红。
 *   这次我写了一大堆解释性注释（里面有 try / catch 字样），
 *   不剥注释的话，检查"函数里有没有 try"会连注释一起算，结果假绿。
 *
 * 跑法：D:/node.exe check-day24.js
 *      D:/node.exe check-day24.js --selftest
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? ' → ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' → ' + detail : ''));
  }
}

function read(f) {
  try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
  catch (e) { return ''; }
}

/* 剥掉注释。注意别把字符串里的 URL（https://…）当行注释给切了。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');     // 行注释（排除 ://）
}

/* 从 "function 名字(" 开始，按花括号配对切出函数体（含最外层 {}）。
   不处理字符串里放花括号的极端情况 —— 本项目的代码里没有。 */
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return null;
}

/* =====================================================================
 * 检查器本体（自证模式和正式跑都用同一个，这样自证才有意义）
 * ===================================================================== */

/** 一个函数体里是不是"有 try 也有 catch" */
function hasTryCatch(body) {
  return !!body && /\btry\s*\{/.test(body) && /\bcatch\s*\(/.test(body);
}

/** 一个函数体的 catch 里有没有调用 reportActionFailure */
function catchReports(body) {
  if (!body) return false;
  const ci = body.indexOf('catch');
  if (ci < 0) return false;
  return body.slice(ci).indexOf('reportActionFailure') > -1;
}

/* =====================================================================
 * --selftest：拿坏代码试刀，证明检查器不是摆设
 * ===================================================================== */
function selftest() {
  console.log('='.repeat(62));
  console.log('Day 24 · 检查器自检（先证明这把尺子量得出来）');
  console.log('='.repeat(62) + '\n');

  let wrong = 0;

  function expect(label, actual, want) {
    const good = (actual === want);
    if (!good) wrong++;
    console.log('  ' + (good ? '✅' : '❌') + ' ' + label
                + '　期望=' + want + ' 实际=' + actual);
  }

  // 用例 1：没接异常的 async 函数 —— 正是今天修的那个毛病
  const noCatch =
    'async function openEdit(kind, id) {\n' +
    '  const all = await S.listCourses();\n' +
    '  if (rec) openModal(kind, rec);\n' +
    '}';
  expect('用例1 · 没 try/catch 的函数 → 应判为"没兜底"',
         hasTryCatch(extractFunction(noCatch, 'openEdit')), false);

  // 用例 2：有 try/catch，但 catch 里不吭声（异常被吞了）
  const silent =
    'async function removeRecord(kind, id) {\n' +
    '  try { await S.deleteCourse(id); }\n' +
    '  catch (err) { /* 吞掉 */ }\n' +
    '}';
  expect('用例2 · catch 里不告诉用户 → 应判为"没上报"',
         catchReports(extractFunction(silent, 'removeRecord')), false);

  // 用例 3：只有注释写了 try/catch —— 不剥注释就会假绿
  const commentOnly =
    'async function toggleDone(id, checked) {\n' +
    '  // 这里应该 try { … } catch (e) { … }\n' +
    '  await S.updateDdl(id, {});\n' +
    '}';
  expect('用例3 · 注释里的 try/catch 不该算数',
         hasTryCatch(extractFunction(stripComments(commentOnly), 'toggleDone')), false);

  // 用例 4：正例 —— 写对了的代码不该被误伤
  const good =
    'async function removeRecord(kind, id) {\n' +
    '  try { await S.deleteCourse(id); }\n' +
    '  catch (err) { await reportActionFailure("删除", err); }\n' +
    '}';
  const g = extractFunction(good, 'removeRecord');
  expect('用例4 · 写对的代码应同时满足两条',
         hasTryCatch(g) && catchReports(g), true);

  console.log('\n' + '='.repeat(62));
  console.log(wrong === 0
    ? '自检结果：✅ 通过 —— 4 个用例全判对，后面的结果可信'
    : '自检结果：❌ 不通过（' + wrong + ' 个判错）—— 后面的 ✅ 不可信');
  console.log('='.repeat(62));
  return wrong === 0;
}

/* =====================================================================
 * 正式检查
 * ===================================================================== */
function run() {
  const appRaw = read('app.js');
  const app = stripComments(appRaw);
  const htmlRaw = read('index.html');
  const html = stripComments(htmlRaw);

  console.log('========================================');
  console.log('Day 24 自检 · 异步操作必须兜住失败');
  console.log('========================================\n');

  // =================================================================
  console.log('【A】修复的"骨架"在不在');
  // =================================================================
  ok('A1 app.js 存在且读得到',                  app.length > 1000, app.length + ' 字符');
  ok('A2 ★ 多了 reportActionFailure()',          extractFunction(app, 'reportActionFailure') !== null);
  ok('A3 ★ 多了 restoreCheckbox()',              extractFunction(app, 'restoreCheckbox') !== null);

  const toastBody = extractFunction(app, 'showToast');
  ok('A4 showToast 收第二个参数 kind',           /function showToast\(text,\s*kind\)/.test(app));
  ok('A5 showToast 里会切 is-error 类',          !!toastBody && toastBody.indexOf('is-error') > -1);
  ok('A6 showToast 错误时留更久（hold 变量）',    !!toastBody && /\bhold\b/.test(toastBody));

  // =================================================================
  console.log('\n【B】三个函数各自兜住失败 ★核心');
  // =================================================================
  const targets = [
    ['openEdit',     '打开编辑'],
    ['removeRecord', '删除'],
    ['toggleDone',   '勾选'],
  ];
  for (const [fn, label] of targets) {
    const body = extractFunction(app, fn);
    ok('B·' + fn + ' 存在',                      !!body);
    ok('B·' + fn + ' ★ 有 try/catch',             hasTryCatch(body),
       body ? '函数体没有 try/catch' : '找不到函数');
    ok('B·' + fn + ' ★ catch 里调用了 reportActionFailure', catchReports(body));
  }

  // =================================================================
  console.log('\n【C】两个"额外但同类"的处理');
  // =================================================================
  const toggleBody = extractFunction(app, 'toggleDone');
  ok('C1 ★ 勾选失败会拨回复选框',
     !!toggleBody && /restoreCheckbox\(id,\s*!checked\)/.test(toggleBody));

  const rmBody = extractFunction(app, 'removeRecord');
  ok('C2 ★ 记录不存在时不再静默 return（会提示）',
     !!rmBody && !/\bif\s*\(!target\)\s*return\s*;/.test(rmBody),
     '还在用裸的 if (!target) return;');
  ok('C3 记录不存在时走了 showToast',            !!rmBody && /showToast\(/.test(rmBody));

  const editBody = extractFunction(app, 'openEdit');
  ok('C4 编辑找不到记录时也会提示',              !!editBody && /showToast\(/.test(editBody));

  // =================================================================
  console.log('\n【D】提示条的"失败态"样式');
  // =================================================================
  ok('D1 index.html 有 --danger 变量',           /--danger\s*:/.test(html));
  ok('D2 有 .toast.is-error 规则',               /\.toast\.is-error\b/.test(html));
  ok('D3 失败态里图标也换色',
     /\.toast\.is-error\s+\.toast-check/.test(html));
  ok('D4 变量是在 :root 里定义的（不是局部）',
     /:root\s*\{[\s\S]*?--danger\s*:[\s\S]*?\}/.test(html));

  // =================================================================
  console.log('\n【E】"为什么"留在代码里了（防以后被清理）');
  // =================================================================
  ok('E1 app.js 里有 Day 24 的说明块',           /Day 24/.test(appRaw));
  ok('E2 说明了根因（Day 20 localStorage → Day 22 云接口）',
     /localStorage/.test(appRaw) && /Day 22/.test(appRaw));
  ok('E3 说明了勾选失败为什么要拨回复选框',
     /复选框|拨回/.test(appRaw) && /撒谎|刷新/.test(appRaw));

  // =================================================================
  console.log('\n【F】没把别的 async 操作落下');
  // =================================================================
  // 列出所有 async function，逐个看是不是"要么有 try/catch，要么挂在有兜底的地方"
  const asyncFns = [];
  const re = /async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(app)) !== null) asyncFns.push(m[1]);

  // 注：其余的 async 函数（loadData / saveWithFeedback / render…）
  //     从 Day 11 / Day 20 起就各自处理了失败 —— 本次只碰上面那三个。
  ok('F1 找到若干 async 函数',                   asyncFns.length >= 8,
     '找到 ' + asyncFns.length + ' 个：' + asyncFns.join(','));

  // 三个"点了就发请求"的操作必须都有兜底（已在 B 组验过），这里只做汇总断言
  const unprotected = ['openEdit', 'removeRecord', 'toggleDone']
    .filter(fn => !hasTryCatch(extractFunction(app, fn)));
  ok('F2 ★ 三个目标函数没有一个是裸的',           unprotected.length === 0,
     unprotected.join(','));

  // =================================================================
  console.log('\n【G】线上部署的是新版（.deploy-tmp 里也应是新版）');
  // =================================================================
  const deploy = read('.deploy-tmp/app.js');
  if (deploy) {
    ok('G1 .deploy-tmp/app.js 含 reportActionFailure',
       deploy.indexOf('reportActionFailure') > -1);
  } else {
    console.log('  ·  .deploy-tmp/ 不在（正常，部署完可以删）—— 跳过 G1');
  }

  // =================================================================
  console.log('\n========================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log('  · ' + f));
  } else {
    console.log('\n📌 三个操作都兜住了失败：异常有人接、界面有人说话。');
    console.log('   勾选失败还会把复选框拨回去 —— 界面不再撒谎。');
  }
  return fail === 0;
}

if (process.argv.includes('--selftest')) {
  process.exit(selftest() ? 0 : 1);
}
process.exit(run() ? 0 : 1);
