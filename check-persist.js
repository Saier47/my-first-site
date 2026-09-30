/* 数据持久化回归测试（check-persist.js）
 * ---------------------------------------------------------------------
 * 锁住 2026-09-30 修的 P0：
 *   **默认设置下，用户录入的数据必须真的存下来 —— 关掉网页再打开还在。**
 *
 * 为什么单独一个文件：
 *   这个 bug 的特征是"不报错、不异常，只是数据没了" —— 而且保存时
 *   页面上照样弹「✓ 已保存」。光靠人看是看不出来的，必须有条自动测试盯着。
 *   以后谁要是把 mock 的默认开关又拨回 'normal'，这里立刻会红。
 *
 * 跑法（项目文件夹里）：node check-persist.js
 *
 * 关键点：**不做任何 DATA_SOURCE 覆盖** —— 测的就是产品原封不动的默认行为。
 * （check-day8/11/13 是反过来，它们显式打开假数据求可复现。）
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = __dirname;
const rawHtml = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const storeJs = fs.readFileSync(path.join(DIR, 'store.js'), 'utf8');
const mockJs = fs.readFileSync(path.join(DIR, 'mock-data.js'), 'utf8');
const appJs = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

function makeHtml() {
  return rawHtml
    .replace('<script src="store.js"></script>', '<script>' + storeJs + '</script>')
    .replace('<script src="mock-data.js"></script>', '<script>' + mockJs + '</script>')
    .replace('<script src="app.js"></script>', '<script>' + appJs + '</script>');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; fails.push(name + (extra ? ' -> ' + extra : '')); console.log('  \u274c ' + name + (extra ? ' -> ' + extra : '')); }
}

// 内存版 localStorage，可以在两次"会话"之间传递 —— 这就是"关掉网页再打开"
function newStorage(initial) {
  const mem = Object.assign({}, initial || {});
  return {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; },
    clear: () => { Object.keys(mem).forEach(k => delete mem[k]); },
    dump: () => JSON.parse(JSON.stringify(mem))
  };
}

async function waitFor(fn, timeout) {
  const t0 = Date.now();
  for (;;) {
    try { if (fn()) return true; } catch (e) {}
    if (Date.now() - t0 > (timeout || 5000)) return false;
    await sleep(10);
  }
}

// 注意 url 是干净的、不带 ?src= —— 测的就是"用户直接打开"的那条路
async function open(snapshot, waitMs) {
  let st;
  const dom = new JSDOM(makeHtml(), {
    runScripts: 'dangerously',
    url: 'http://localhost:8000/',
    pretendToBeVisual: true,
    beforeParse(w) {
      st = newStorage(snapshot);
      Object.defineProperty(w, 'localStorage', { value: st, configurable: true });
      w.scrollTo = () => {};
      w.confirm = () => true;
      w.console.error = () => {};
      w.console.warn = () => {};
    }
  });
  await sleep(waitMs || 2200);
  return { w: dom.window, st };
}

function shownCourses(w) {
  return Array.prototype.map.call(
    w.document.querySelectorAll('#course-list .row-title'),
    n => n.textContent.trim()
  );
}

(async () => {
  const NAME = '持久化测试课';

  console.log('=== 1. 默认打开：必须走真数据 ===');
  const s1 = await open(null);

  ok('MockStore 存在，但默认是 off（假数据默认关着）',
    !!(s1.w.MockStore && s1.w.MockStore.source === 'off'),
    s1.w.MockStore ? ('source = ' + s1.w.MockStore.source) : 'MockStore 不存在');

  const guide = s1.w.document.querySelector('#week-list .empty-guide');
  ok('本机没数据时 → 看到空状态引导（而不是演示用的假课程）',
    !!guide,
    guide ? '' : '没找到 .empty-guide');

  console.log('\n=== 2. 录一门课 → 必须真的落到本机存储 ===');
  const tab = s1.w.document.querySelector('.tab[data-view="courses"]');
  if (tab) tab.click();
  await sleep(300);
  s1.w.document.getElementById('btn-add').click();
  await sleep(300);
  s1.w.document.getElementById('c-name').value = NAME;
  s1.w.document.getElementById('c-day').value = '3';
  s1.w.document.getElementById('c-start').value = '10:00';
  s1.w.document.getElementById('c-end').value = '11:40';
  s1.w.document.getElementById('form-course').dispatchEvent(
    new s1.w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(function () {
    const t = s1.w.document.getElementById('toast');
    return t && !t.hidden;
  }, 5000);

  const snap = s1.st.dump();
  ok('录入之后 localStorage 里出现了 mfs:courses',
    !!snap['mfs:courses'],
    '实际的键：[' + Object.keys(snap).join(', ') + ']');

  let stored = [];
  try { stored = JSON.parse(snap['mfs:courses'] || '[]').map(c => c.name); } catch (e) {}
  ok('存进去的就是刚录的那门课', stored.indexOf(NAME) >= 0, JSON.stringify(stored));

  console.log('\n=== 3. 关掉网页、明天再打开（同一份本机存储）===');
  const s2 = await open(snap);
  const tab2 = s2.w.document.querySelector('.tab[data-view="courses"]');
  if (tab2) tab2.click();
  await sleep(600);
  const names = shownCourses(s2.w);

  ok('重新打开后，那门课还在', names.indexOf(NAME) >= 0, JSON.stringify(names));
  ok('也没有混进演示用的假数据（高等数学 / 数据结构 / 大学英语）',
    names.indexOf('高等数学') < 0 && names.indexOf('数据结构') < 0 && names.indexOf('大学英语') < 0,
    JSON.stringify(names));

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fails.length) {
    console.log('\n失败明细：');
    fails.forEach(f => console.log('  - ' + f));
  }
  process.exitCode = fail ? 1 : 0;
})();
