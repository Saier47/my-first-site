/* Day 13 验证：多级视图切换 + 四种状态（check-day13.js）

   ⚠️ 等待时间：本产品"点一下 → 界面变"约需 1800ms（Day 11 的教训），
   所以一律等 ≥2000ms 再断言。宁多等，别把"还没生效"当成"没生效"。

   板块②：3 个视图互相切换不出错（一级 week/courses + 二级 today）
   板块③：空 / 加载 / 错误 / 正常 四种状态
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
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, view: w }));

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name + (extra ? ' -> ' + extra : '')); console.log('  ❌ ' + name + (extra ? ' -> ' + extra : '')); }
}
function head(t) { console.log('\n=== ' + t + ' ==='); }

async function boot(waitMs, startUrl) {
  const dom = new JSDOM(makeHtml(), {
    runScripts: 'dangerously',
    url: startUrl || 'http://localhost:8000/',
    pretendToBeVisual: true,
    beforeParse(w) {
      const mem = {};
      Object.defineProperty(w, 'localStorage', {
        value: {
          getItem: k => (k in mem ? mem[k] : null),
          setItem: (k, v) => { mem[k] = String(v); },
          removeItem: k => { delete mem[k]; },
          clear: () => { Object.keys(mem).forEach(k => delete mem[k]); }
        }, configurable: true
      });
      w.scrollTo = function () {};
      w.confirm = function () { return true; };
      w.__errors = [];
      w.console.error = (...a) => { w.__errors.push(a.map(String).join(' ')); };
    }
  });
  await sleep(waitMs || 2200);
  return dom.window;
}

// 当前显示的是哪个视图 —— 顺便能查出"两个同时露出来"这种 bug
function visibleView(w) {
  const ids = ['view-week', 'view-courses', 'view-today'];
  const shown = ids.filter(function (id) {
    const n = w.document.getElementById(id);
    return n && !n.hidden;
  });
  return shown.length === 1 ? shown[0] : ('异常:' + (shown.join('+') || '全隐藏'));
}

function txt(w, sel) {
  const n = w.document.querySelector(sel);
  return n ? n.textContent.trim() : '(不存在)';
}

(async () => {

  /* ============ A. 路由基础：地址 ↔ 视图 ============ */
  head('A. 路由基础：地址决定显示哪个视图');

  {
    const w = await boot(2200, 'http://localhost:8000/');
    ok('A1 打开时没有地址 → 自动补成 #/week', w.location.hash === '#/week', '实际 ' + w.location.hash);
    ok('A2 打开时没有地址 → 显示一周视图', visibleView(w) === 'view-week', '实际 ' + visibleView(w));
    ok('A3 任何时刻只有一个视图可见', !visibleView(w).startsWith('异常'), visibleView(w));
  }
  {
    const w = await boot(2200, 'http://localhost:8000/#/courses');
    ok('A4 直接开 #/courses → 显示清单页', visibleView(w) === 'view-courses', '实际 ' + visibleView(w));
    ok('A5 直接开 #/courses → 该视图真的渲染出了条目',
      w.document.querySelectorAll('#course-list .row').length > 0,
      '课程行数 ' + w.document.querySelectorAll('#course-list .row').length);
  }
  {
    const w = await boot(2200, 'http://localhost:8000/#/today');
    ok('A6 直接开 #/today → 显示今天视图', visibleView(w) === 'view-today', '实际 ' + visibleView(w));
  }
  {
    const w = await boot(2200, 'http://localhost:8000/#/nope-not-a-view');
    ok('A7 未知地址 → 不白屏，回落到一周视图', visibleView(w) === 'view-week', '实际 ' + visibleView(w));
  }

  /* ============ B. 一级切换（底部导航 + 地址联动） ============ */
  head('B. 一级切换：点导航 ↔ 地址跟着变');

  {
    const w = await boot(2200, 'http://localhost:8000/#/week');
    click(w, w.document.querySelector('.tab[data-view="courses"]'));
    await sleep(300);
    ok('B1 点「清单」→ 地址变成 #/courses', w.location.hash === '#/courses', '实际 ' + w.location.hash);
    ok('B2 点「清单」→ 界面切到清单页', visibleView(w) === 'view-courses', '实际 ' + visibleView(w));

    click(w, w.document.querySelector('.tab[data-view="week"]'));
    await sleep(300);
    ok('B3 点「一周视图」→ 地址回到 #/week', w.location.hash === '#/week', '实际 ' + w.location.hash);
    ok('B4 点「一周视图」→ 界面切回', visibleView(w) === 'view-week', '实际 ' + visibleView(w));
  }
  {
    // 模拟"后退键"：不改 UI，只把地址改掉，看视图会不会自己跟上
    const w = await boot(2200, 'http://localhost:8000/#/week');
    w.location.hash = '#/courses';
    await sleep(300);
    ok('B5 地址被改（等价于后退/前进）→ 视图自动跟上',
      visibleView(w) === 'view-courses', '实际 ' + visibleView(w));
  }

  /* ============ C. 二级视图：今天 ============ */
  head('C. 二级视图「今天」：层级与回去的路');

  {
    const w = await boot(2200, 'http://localhost:8000/#/today');
    const activeTabs = Array.prototype.filter.call(
      w.document.querySelectorAll('.tab'),
      t => t.classList.contains('is-active')
    ).map(t => t.getAttribute('data-view'));
    ok('C1 停在今天视图时，底部仍高亮「一周视图」（说明它是 week 的分支）',
      activeTabs.length === 1 && activeTabs[0] === 'week', '高亮的是 ' + JSON.stringify(activeTabs));

    const crumb = w.document.querySelector('#view-today .crumb-link');
    ok('C2 有面包屑「← 这一周」', !!crumb, '没找到 .crumb-link');
    ok('C3 面包屑指向 #/week', crumb && crumb.getAttribute('href') === '#/week',
      crumb ? crumb.getAttribute('href') : '(无)');

    ok('C4 今天视图里真的渲染了内容', w.document.querySelectorAll('#today-body *').length > 0,
      '#today-body 子节点数 ' + w.document.querySelectorAll('#today-body *').length);
  }

  /* ============ D. 筛选词进地址（多级的"参数"那一层） ============ */
  head('D. 筛选词进出地址');

  {
    const w = await boot(2200, 'http://localhost:8000/#/courses?q=%E9%AB%98%E6%95%B0');  // q=高数
    const input = w.document.getElementById('filter-input');
    ok('D1 地址里带 q=高数 → 搜索框自动填上', input && input.value === '高数',
      '输入框实际 "' + (input ? input.value : '(无)') + '"');
  }
  {
    const w = await boot(2200, 'http://localhost:8000/#/courses');
    const input = w.document.getElementById('filter-input');
    input.value = '英语';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(300);
    ok('D2 在清单页打字 → 地址同步带上 q', /q=/.test(w.location.hash) && /%E8%8B%B1%E8%AF%AD|英语/.test(decodeURIComponent(w.location.hash)),
      '实际 ' + w.location.hash);

    const before = w.history.length;
    input.value = '英语作';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(300);
    ok('D3 继续打字不会往历史里塞新条目（否则后退键就废了）',
      w.history.length === before, before + ' → ' + w.history.length);
  }

  /* ============ F. 四种状态：三个视图都要有 ============ */
  head('F. 四种状态：三个视图都要有');

  // —— 正常 ——
  {
    const w = await boot(2200, 'http://localhost:8000/#/week');
    ok('F1 正常：一周视图是 7 列，有内容',
      w.document.querySelectorAll('#week-list .day').length === 7,
      '列数 ' + w.document.querySelectorAll('#week-list .day').length);

    w.location.hash = '#/courses';
    await sleep(300);
    ok('F2 正常：清单页有内容，且状态位是收起的',
      w.document.querySelectorAll('#course-list .row').length > 0
      && w.document.getElementById('courses-normal').hidden === false
      && w.document.getElementById('courses-state').hidden === true,
      '课程行 ' + w.document.querySelectorAll('#course-list .row').length);

    w.location.hash = '#/today';
    await sleep(300);
    ok('F3 正常：今天视图有内容',
      w.document.querySelectorAll('#today-body .zone').length > 0,
      '区块数 ' + w.document.querySelectorAll('#today-body .zone').length);
  }

  // —— 加载中（趁 600ms 延迟还没回来） ——
  {
    const w = await boot(200, 'http://localhost:8000/#/week');
    ok('F4 加载中：一周视图是 7 列骨架屏',
      w.document.querySelectorAll('#week-list .sk-day').length === 7,
      '骨架列 ' + w.document.querySelectorAll('#week-list .sk-day').length);
    ok('F5 加载中：清单页也有骨架（不是一片空白）',
      w.document.querySelectorAll('#courses-state .sk-row').length > 0,
      '骨架行 ' + w.document.querySelectorAll('#courses-state .sk-row').length);
    ok('F6 加载中：今天视图也有骨架',
      w.document.querySelectorAll('#today-body .sk-row').length > 0,
      '骨架行 ' + w.document.querySelectorAll('#today-body .sk-row').length);
    ok('F7 加载中：清单页的筛选框先收起来（没数据可筛，留着会误导）',
      w.document.getElementById('courses-normal').hidden === true,
      'courses-normal.hidden = ' + w.document.getElementById('courses-normal').hidden);
  }

  // —— 空 ——
  {
    const w = await boot(2200, 'http://localhost:8000/?src=empty');
    ok('F8 空状态：一周视图给的是引导（不是骨架、不是白屏）',
      !!w.document.querySelector('#week-list .empty-guide'), '');
    ok('F9 空状态：清单页说"还没有课程"',
      /还没有课程/.test(txt(w, '#course-list')), txt(w, '#course-list').slice(0, 30));

    w.location.hash = '#/today';
    await sleep(300);
    ok('F10 空状态：今天视图说"今天很干净"（和上面两句都不一样）',
      /今天很干净/.test(txt(w, '#today-body')), txt(w, '#today-body').slice(0, 30));
  }

  // —— 出错 ——
  {
    const w = await boot(2200, 'http://localhost:8000/?src=error#/week');
    ok('F11 出错：一周视图有错误框 + 重试按钮',
      !!w.document.querySelector('#week-list .state-error')
      && !!w.document.querySelector('#week-list [data-action="retry"]'), '');

    w.location.hash = '#/courses';
    await sleep(300);
    ok('F12 出错：切到清单页也有错误框 + 重试按钮',
      !!w.document.querySelector('#courses-state .state-error')
      && !!w.document.querySelector('#courses-state [data-action="retry"]'), '');

    const shownErrors = ['view-week', 'view-courses', 'view-today'].reduce(function (n, id) {
      const v = w.document.getElementById(id);
      if (!v || v.hidden) return n;
      return n + v.querySelectorAll('.state-error').length;
    }, 0);
    ok('F13 出错：当前这个视图里只有 1 个错误框（不要两个重试按钮）',
      shownErrors === 1, '可见错误框数 ' + shownErrors);

    w.location.hash = '#/today';
    await sleep(300);
    ok('F14 出错：切到今天视图也有错误框',
      !!w.document.querySelector('#today-body .state-error'), '');
  }

  // —— 地址通道本身 ——
  {
    const w = await boot(2200, 'http://localhost:8000/?src=empty#/courses');
    ok('F15 ?src=empty 确实把数据源拨过去了（MockStore.source）',
      w.MockStore && w.MockStore.source === 'empty',
      w.MockStore ? w.MockStore.source : '(无 MockStore)');
    ok('F16 query 写在 hash 前面 → 切视图后 src 仍保留（所以四种状态能在任意视图看）',
      /src=empty/.test(w.location.search), 'search = "' + w.location.search + '"');
  }

  /* ============ E. 运行期错误 ============ */
  head('E. 运行期错误');
  {
    const w = await boot(2200, 'http://localhost:8000/#/today');
    w.location.hash = '#/courses';
    await sleep(400);
    w.location.hash = '#/week';
    await sleep(400);
    ok('E1 三个视图来回切，全程没有 console.error',
      w.__errors.length === 0, w.__errors.join(' | '));
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fails.length) {
    console.log('\n失败明细：');
    fails.forEach(f => console.log('  - ' + f));
  }
})();
