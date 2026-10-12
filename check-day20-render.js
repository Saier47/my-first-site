#!/usr/bin/env node
/* =====================================================================
 * check-day20-render.js —— Day 20 教训：**静态检查救不了运行时 bug**
 * ---------------------------------------------------------------------
 * 为什么要有这个脚本（今天用血换来的）：
 *
 *   check-day20.js 有三层检查（接口层 / 源码层 / 部署层），33 项全过 ——
 *   但用户打开页面看到的却是**永远转圈的骨架屏**。
 *
 *   原因：我加 renderSyncNote() 时误删了两行 `const courses/ddls = ...`，
 *   于是 render() 里 `ddls.filter(...)` 抛 ReferenceError，渲染整个断掉。
 *   而那三层检查**全是静态的** —— 没有一条真的执行过 render()。
 *
 *   🔑 **「文件传对了」≠「代码能跑」**。
 *      要看"能不能跑"，只有一条路：**真的跑一遍**。
 *
 * 这个脚本做的就是这件事：搭一个最小 DOM，把 store.js + app.js 真加载进来，
 * 真调云端接口，真执行 render()，然后检查 DOM 里有没有渲染出内容。
 *
 * ⚠️ 限制（诚实标注）：这是**模拟 DOM**，不是真浏览器。
 *    它抓不到 CSS 布局 / 视觉问题（那要靠 agent-browser）。
 *    但它能抓住"JS 抛异常导致页面空白"这类 —— 也就是今天这个 bug。
 *
 * 跑法：D:/node.exe check-day20-render.js
 * ===================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

let pass = 0, fail = 0;
const failed = [];
function ok(l) { pass++; console.log('  ✅ ' + l); }
function ng(l, e) { fail++; failed.push(l); console.log('  ❌ ' + l + (e ? '  → ' + e : '')); }
function check(l, c, e) { c ? ok(l) : ng(l, e); }

/* ------------------------------------------------------------------
 * ① 搭一个"够用就好"的最小 DOM
 * ------------------------------------------------------------------
 * 为什么不用 jsdom：
 *   装它是几百个包；而我们只需要"元素能存 innerHTML、能按 id 找"
 *   这么一点点能力。自己写 60 行，零依赖，还看得见每一行在干嘛。
 * ------------------------------------------------------------------ */
class FakeEl {
  constructor(tag, id) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = id || '';
    this.innerHTML = '';
    this.textContent = '';
    this.hidden = false;
    this.children = [];
    this.className = '';
    this._attrs = {};
    this.style = {};
    this.dataset = {};
    // classList：app.js 里用到了 add/remove/toggle/contains
    const self = this;
    this.classList = {
      add(c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); s.add(c); self.className = Array.from(s).join(' '); },
      remove(c) { self.className = self.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
      toggle(c, force) {
        const has = self.className.split(/\s+/).indexOf(c) >= 0;
        const want = force === undefined ? !has : !!force;
        want ? this.add(c) : this.remove(c);
        return want;
      },
      contains(c) { return self.className.split(/\s+/).indexOf(c) >= 0; },
    };
  }
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; }
  removeAttribute(k) { delete this._attrs[k]; }
  hasAttribute(k) { return k in this._attrs; }
  addEventListener() {}
  removeEventListener() {}
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
  click() {}
  insertAdjacentHTML() {}
  contains() { return false; }
}

// 页面里真实存在的 id（从 index.html 抄来的），够 render() 用
const IDS = [
  'week-range', 'sync-note', 'overdue-zone', 'overdue-list', 'week-list',
  'courses-state', 'courses-normal', 'filter-input', 'filter-clear',
  'filter-count', 'course-list', 'ddl-list', 'today-body', 'btn-add',
  'modal', 'modal-title', 'modal-body', 'form-course', 'form-ddl',
  'err-course', 'err-ddl', 'toast', 'toast-text',
  'c-name', 'c-day', 'c-start', 'c-end', 'c-location',
  'd-title', 'd-date', 'd-time', 'd-note',
];

const registry = {};
IDS.forEach(function (id) { registry[id] = new FakeEl('div', id); });

const documentFake = {
  readyState: 'complete',
  getElementById: function (id) { return registry[id] || null; },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  createElement: function (t) { return new FakeEl(t); },
  addEventListener: function () {},
  removeEventListener: function () {},
  body: new FakeEl('body'),
  documentElement: new FakeEl('html'),
};

/* ------------------------------------------------------------------
 * ② 把浏览器全局挂上
 * ------------------------------------------------------------------ */
globalThis.window = globalThis;
globalThis.document = documentFake;
// Node 20+ 的 globalThis.navigator 是只读的 getter → 得用 defineProperty 盖掉
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node-check' },
    configurable: true,
    writable: true,
  });
} catch (e) {
  // 盖不掉也没关系：app.js 不依赖 navigator
}
globalThis.location = {
  search: '',
  hash: '',
  href: 'http://localhost/',
  pathname: '/index.html',
};
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
globalThis.matchMedia = function () {
  return { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
};
globalThis.requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };
// app.js 的 bindEvents() 会往 window / document 上挂一堆监听 —— 给个空实现
globalThis.addEventListener = function () {};
globalThis.removeEventListener = function () {};
globalThis.dispatchEvent = function () { return true; };
globalThis.history = { pushState() {}, replaceState() {}, back() {}, forward() {} };
globalThis.CustomEvent = class CustomEvent { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };

// 把 console.error 收集起来 —— JS 抛的异常会被 app.js 的 .catch 打到这里
const consoleErrors = [];
const realError = console.error;
console.error = function () {
  const s = Array.prototype.map.call(arguments, function (a) {
    if (a && a.stack) return a.stack;
    return typeof a === 'string' ? a : JSON.stringify(a);
  }).join(' ');
  consoleErrors.push(s);
  realError.apply(console, arguments);
};
const realWarn = console.warn;

function silence() { console.warn = function () {}; }
function unsilence() { console.warn = realWarn; }

/* ------------------------------------------------------------------
 * ③ 真加载 store.js + app.js（不是读文本，是执行）
 * ------------------------------------------------------------------ */
(async function main() {
  console.log('════════════════════════════════════════════');
  console.log('  Day 20 运行时自检 · 真跑 render()');
  console.log('  ' + new Date().toISOString());
  console.log('════════════════════════════════════════════');

  console.log('\n【准备】加载 store.js 与 app.js');

  let storeSrc, appSrc;
  try {
    storeSrc = fs.readFileSync(path.join(ROOT, 'store.js'), 'utf8');
  } catch (e) {
    ng('读不到 store.js', e.message);
    process.exit(1);
  }
  try {
    appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  } catch (e) {
    ng('读不到 app.js', e.message);
    process.exit(1);
  }

  // store.js —— 必须成功挂上 window.Store
  try {
    new Function(storeSrc)();
    check('store.js 执行成功，window.Store 挂上了',
      !!globalThis.Store, 'window.Store 是 ' + typeof globalThis.Store);
  } catch (e) {
    ng('store.js 执行失败', e.message);
    process.exit(1);
  }

  // app.js —— 必须成功挂上 window.App
  silence();
  try {
    new Function(appSrc)();
    check('app.js 执行成功，window.App 挂上了',
      !!globalThis.App, 'window.App 是 ' + typeof globalThis.App);
  } catch (e) {
    unsilence();
    ng('app.js 执行失败（加载期就炸）', e.message);
    console.log('\n' + e.stack);
    process.exit(1);
  }
  unsilence();

  if (!globalThis.App || !globalThis.App.render) {
    ng('window.App.render 不存在 —— 没法继续验证');
    process.exit(1);
  }

  /* ----------------------------------------------------------------
   * ④ 【核心】真跑 render()
   * ---------------------------------------------------------------- */
  console.log('\n【核心】真调云端接口 + 真跑 render() —— 这是抓今天那个 bug 的一步');

  consoleErrors.length = 0;

  try {
    await globalThis.App.render();
    ok('render() 执行完毕，没有抛出异常');
  } catch (e) {
    ng('render() 抛异常了', e && e.message ? e.message : String(e));
    if (e && e.stack) console.log('\n' + e.stack);
  }

  // render() 内部是 async，异常会被它自己的 .catch 吞到 console.error
  await new Promise(r => setTimeout(r, 600));

  // app.js 里带 '[app]' 前缀的错误 = 渲染链路真的出事了
  const appErrors = consoleErrors.filter(s => s.indexOf('[app]') === 0 || s.indexOf('[app]') >= 0);
  check('控制台没有 [app] 渲染错误',
    appErrors.length === 0,
    appErrors.length ? appErrors[0].slice(0, 200) : '');

  /* ----------------------------------------------------------------
   * ⑤ 检查 DOM 里真的渲染出东西了
   * ---------------------------------------------------------------- */
  console.log('\n【结果】DOM 里有没有真内容（"没报错"不等于"画出来了"）');

  const weekList = registry['week-list'];
  const overdueList = registry['overdue-list'];
  const syncNote = registry['sync-note'];

  const weekHtml = weekList ? weekList.innerHTML : '';
  const overdueHtml = overdueList ? overdueList.innerHTML : '';

  check('week-list 有内容（不为空）',
    weekHtml.length > 0,
    '长度 ' + weekHtml.length + ' —— 空的话页面就是永远骨架屏');

  check('week-list 里渲染出了课程名（找到"高等数学"）',
    weekHtml.indexOf('高等数学') >= 0,
    '渲染出来的前 200 字：' + weekHtml.slice(0, 200));

  check('week-list 里渲染出了 7 个 day 块',
    (weekHtml.match(/class="day[ "]/g) || []).length === 7,
    '实际 ' + (weekHtml.match(/class="day[ "]/g) || []).length + ' 个');

  check('week-list 里没有残留骨架屏 class（sk-day）',
    weekHtml.indexOf('sk-day') < 0);

  check('overdue-list 渲染了过期区（有 DDL 数据）',
    overdueHtml.length > 0 || (registry['overdue-zone'] && registry['overdue-zone'].hidden === true),
    '过期区长度 ' + overdueHtml.length);

  check('sync-note 显示了同步时间（含"数据同步于"）',
    syncNote && String(syncNote.textContent).indexOf('数据同步于') >= 0,
    '实际内容："' + (syncNote ? syncNote.textContent : 'N/A') + '"');

  /* ----------------------------------------------------------------
   * ⑥ 反向验证：确认这个脚本真的能抓到"变量被删"这类 bug
   * ---------------------------------------------------------------- */
  console.log('\n【自证】把 courses/ddls 声明删掉，脚本应该报红（证明它测得住）');

  const broken = appSrc.replace(/^\s*const courses = .*$/m, '').replace(/^\s*const ddls = .*$/m, '');
  const removedCount = (appSrc.match(/const courses = /g) || []).length - (broken.match(/const courses = /g) || []).length;

  if (removedCount !== 1) {
    ng('无法构造"坏版本"来做自证（可能变量声明已改名）', '匹配到 ' + removedCount + ' 处');
  } else {
    // 单独一个沙箱里跑坏版本。
    // ⚠️ 沙箱里的 window 自己就是全局，所有 app.js 需要的全局都得给全 ——
    //    少一个（比如 addEventListener）就会在加载期炸掉，测不到我们要测的东西。
    const vm = require('vm');
    const sandboxErrors = [];
    const sandbox = {
      document: documentFake,
      localStorage: globalThis.localStorage,
      location: globalThis.location,
      navigator: { userAgent: 'node-check' },
      matchMedia: globalThis.matchMedia,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return true; },
      history: { pushState() {}, replaceState() {}, back() {}, forward() {} },
      CustomEvent: globalThis.CustomEvent,
      setTimeout: setTimeout, clearTimeout: clearTimeout,
      console: {
        log() {}, warn() {},
        error: function () { sandboxErrors.push(Array.prototype.join.call(arguments, ' ')); },
      },
      fetch: globalThis.fetch,
      AbortController: globalThis.AbortController,
      Promise: Promise, JSON: JSON, Math: Math, Date: Date, Set: Set, Map: Map,
      Array: Array, Object: Object, String: String, Number: Number,
      RegExp: RegExp, Error: Error, TypeError: TypeError, isNaN: isNaN,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    try {
      vm.createContext(sandbox);
      vm.runInContext(storeSrc, sandbox);
      vm.runInContext(broken, sandbox);
      if (sandbox.App && sandbox.App.render) {
        // 坏版本的 render() 会抛 ReferenceError。这里**故意接住它**——
        // 接住了才算"脚本能抓到这类 bug"。
        let caughtMsg = '';
        try {
          await sandbox.App.render();
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          caughtMsg = (e && e.message) ? e.message : String(e);
        }
        const fromThrow = caughtMsg.indexOf('ddls is not defined') >= 0;
        const fromConsole = sandboxErrors.some(s => s.indexOf('ddls is not defined') >= 0);
        check('坏版本确实被脚本抓到（ddls is not defined）',
          fromThrow || fromConsole,
          '抛出的：' + (caughtMsg || '(没抛)') + ' / 控制台：' + sandboxErrors.slice(0, 1).join('').slice(0, 150));
      } else {
        ng('坏版本的 App.render 没挂上');
      }
    } catch (e) {
      ng('自证过程本身出错', e.message);
    }
  }

  /* ---------------------------------------------------------------- */
  console.log('\n════════════════════════════════════════════');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('\n  失败清单：');
    failed.forEach(t => console.log('    · ' + t));
  }
  console.log('════════════════════════════════════════════');

  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('\n💥 脚本自己崩了（不是被测对象的问题）：');
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
