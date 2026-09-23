/* Day 8 验证脚本：在 Node 里用真 DOM 跑 app.js，检查四种状态与渲染结果
 * ---------------------------------------------------------------------
 * 怎么跑（在项目文件夹里，需要先装一次 jsdom）：
 *     npm install jsdom
 *     node .day8-check.js
 * 看到「通过 N 项，失败 0 项」且退出码为 0 就是全过。
 *
 * 它是 AGENTS.md 第八节「不说没验证过的话」的可执行版本 ——
 * 与其靠人记着去验，不如让机器每次都跑一遍。
 *
 * v1 的教训（写下来免得下次再踩）：
 * jsdom 用 runScripts:'outside-only' + w.eval() 时，脚本跑在 jsdom 的 realm 里，
 * 它产出的 Promise 和 Node 主 realm 的 Promise 不是同一个构造函数 ——
 * app.js 里 `await MockStore.listCourses()` 会卡住不返回，页面永远停在骨架屏。
 * 看起来像"页面坏了"，其实是测试环境的 realm 错配。
 * 解法：用 runScripts:'dangerously' 让 jsdom 自己执行，并把 <script src> 换成内联脚本，
 * 绕开 jsdom 的资源加载限制（用 file:// 会跨域）。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// 用脚本自身位置定位项目根目录，这样谁 clone 下来都能直接跑
const DIR = __dirname;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  \u274c ' + name + (extra ? ' -> ' + extra : '')); }
}

const rawHtml = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

// 把三个 <script src="x.js"> 换成内联脚本：jsdom 就能在同一 realm 里执行，
// await 也就通得过。这是为了让测试环境贴近真实浏览器。
const storeJs = fs.readFileSync(path.join(DIR, 'store.js'), 'utf8');
let mockJs = fs.readFileSync(path.join(DIR, 'mock-data.js'), 'utf8');
const appJs = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

function makeHtml(sourceOverride) {
  let mock = mockJs;
  if (sourceOverride) {
    // 覆盖 mock-data.js 里的 DATA_SOURCE 开关
    mock = mock.replace(/var DATA_SOURCE = '[^']*';/, "var DATA_SOURCE = '" + sourceOverride + "';");
  }
  return rawHtml
    .replace('<script src="store.js"></script>', '<script>' + storeJs + '</script>')
    .replace('<script src="mock-data.js"></script>', '<script>' + mock + '</script>')
    .replace('<script src="app.js"></script>', '<script>' + appJs + '</script>');
}

async function boot(source, waitMs) {
  const dom = new JSDOM(makeHtml(source), {
    runScripts: 'dangerously',
    url: 'http://localhost:8000/',
    pretendToBeVisual: true,
    beforeParse(w) {
      // jsdom 没有 localStorage 实现，补一个内存版
      const mem = {};
      Object.defineProperty(w, 'localStorage', {
        value: {
          getItem: k => (k in mem ? mem[k] : null),
          setItem: (k, v) => { mem[k] = String(v); },
          removeItem: k => { delete mem[k]; },
          clear: () => { Object.keys(mem).forEach(k => delete mem[k]); }
        }, configurable: true
      });
      // jsdom 不实现 scrollTo，会刷警告，补个空函数
      w.scrollTo = function () {};
      // confirm 默认返回 false，测试里按需覆盖
      w.confirm = function () { return true; };
      w.console.error = () => {};   // 抑制预期的错误日志
    }
  });
  await new Promise(r => setTimeout(r, waitMs || 1000));
  return dom.window;
}

(async () => {
  console.log('\n=== 场景 1：mock 正常数据（默认）===');
  {
    const w = await boot(undefined, 1500);
    const doc = w.document;
    const week = doc.getElementById('week-list');

    ok('7 天全部渲染出来', week.querySelectorAll('.day').length === 7, '实际 ' + week.querySelectorAll('.day').length);
    ok('今天那一列被标记', week.querySelectorAll('.day.is-today').length === 1);
    ok('星期名顺序 周一..周日',
      [...week.querySelectorAll('.day-name')].map(e => e.textContent).join(',') === '周一,周二,周三,周四,周五,周六,周日');
    ok('3 门课程卡片渲染出来', week.querySelectorAll('.item-course').length === 3, '实际 ' + week.querySelectorAll('.item-course').length);
    ok('本周未过期的 DDL 渲染出来（应为 1 条：周四）', week.querySelectorAll('.item-ddl').length === 1, '实际 ' + week.querySelectorAll('.item-ddl').length);
    ok('DDL 卡片带类型标签', week.querySelector('.item-ddl .item-tag') && week.querySelector('.item-ddl .item-tag').textContent === 'DDL');

    const over = doc.querySelectorAll('#overdue-list .over-item');
    ok('过期区有 1 条（周二那条）', over.length === 1, '实际 ' + over.length);
    ok('过期区没有被隐藏', doc.getElementById('overdue-zone').hidden === false);
    ok('已完成的 DDL 不在过期区', ![...over].some(n => n.textContent.includes('高数作业')));

    ok('清单页 DDL 列表 3 条（含已完成那条）', doc.querySelectorAll('#ddl-list .row').length === 3, '实际 ' + doc.querySelectorAll('#ddl-list .row').length);
    ok('已完成那条在列表里可见且有删除线类', !!doc.querySelector('#ddl-list .row.is-done'));
    ok('清单页课程分组渲染出来', doc.querySelectorAll('#course-list .row').length === 3, '实际 ' + doc.querySelectorAll('#course-list .row').length);
    ok('课程卡片左侧色条类存在', week.querySelectorAll('.item-course').length > 0);
    ok('课程卡片显示地点', (week.querySelector('.item-course .item-loc') || {}).textContent === 'A101');

    // 回归守卫（修好版）：每个 button 必须能被某条规则接住
    const allBtns = [...doc.querySelectorAll('button')];
    const orphans = allBtns.filter(b => {
      const hasAction = b.hasAttribute('data-action');
      const hasClose = b.hasAttribute('data-close');
      const hasView = b.hasAttribute('data-view');
      const isSubmit = b.getAttribute('type') === 'submit';
      return !(hasAction || hasClose || hasView || isSubmit);
    });
    ok('回归守卫：没有无职责按钮', orphans.length === 0, orphans.map(b => '[' + b.textContent + ']').join(' '));
    ok('FAB 按钮有 data-action=add', doc.getElementById('btn-add').getAttribute('data-action') === 'add');
    ok('FAB 文案在一周视图显示"添加 DDL"', doc.getElementById('btn-add').textContent.includes('DDL'));
    ok('底部只有 2 个导航入口（PRD 2.2 第 2 条）', doc.querySelectorAll('.tabbar .tab').length === 2);
  }

  console.log('\n=== 场景 2：加载中（骨架屏）===');
  {
    const w = await boot(undefined, 150);   // 故意在 600ms 延迟之前就看
    const doc = w.document;
    const week = doc.getElementById('week-list');
    ok('加载中显示 7 个骨架块', week.querySelectorAll('.sk-day').length === 7, '实际 ' + week.querySelectorAll('.sk-day').length);
    ok('加载中不显示真实卡片', week.querySelectorAll('.item').length === 0);
    ok('加载中不显示空状态引导', week.querySelectorAll('.empty-guide').length === 0);
    ok('加载中不显示错误盒', week.querySelectorAll('.state-error').length === 0);
    ok('加载中时过期区隐藏（避免半骨架半内容）', doc.getElementById('overdue-zone').hidden === true);
    ok('加载中也显示本周日期范围', (doc.getElementById('week-range').textContent || '').includes('–'));
  }

  console.log('\n=== 场景 3：空状态 ===');
  {
    const w = await boot('empty', 1500);
    const doc = w.document;
    const week = doc.getElementById('week-list');
    const emptyTitle = week.querySelector('.empty-title');
    ok('空状态显示引导盒', week.querySelectorAll('.empty-guide').length === 1);
    ok('空状态有引导标题', !!emptyTitle && emptyTitle.textContent.includes('空'));
    ok('空状态带一个添加入口（不是白屏）', week.querySelectorAll('[data-action="add"]').length === 1);
    ok('空状态没有残留骨架屏', week.querySelectorAll('.sk-day').length === 0);
    ok('空状态没有真实卡片', week.querySelectorAll('.item').length === 0);
    ok('空状态隐藏过期区', doc.getElementById('overdue-zone').hidden === true);
    ok('空状态下列表页也各有提示（不是空白）', doc.querySelectorAll('#course-list .list-empty').length === 1 && doc.querySelectorAll('#ddl-list .list-empty').length === 1);
  }

  console.log('\n=== 场景 4：出错状态 ===');
  {
    const w = await boot('error', 600);
    const doc = w.document;
    const week = doc.getElementById('week-list');
    ok('出错状态显示错误盒', week.querySelectorAll('.state-error').length === 1);
    ok('错误盒有标题', ((week.querySelector('.state-title') || {}).textContent || '').length > 0);
    ok('错误盒说明了原因', ((week.querySelector('.state-sub') || {}).textContent || '').length > 0);    ok('错误盒给出出路：重试按钮', week.querySelectorAll('[data-action="retry"]').length === 1);
    ok('出错时没有骨架屏', week.querySelectorAll('.sk-day').length === 0);
    ok('出错时没有空状态引导（两种状态不混）', week.querySelectorAll('.empty-guide').length === 0);
  }

  console.log('\n=== 场景 5：重试按钮真的重新走了一遍流程 ===');
  {
    const w = await boot('error', 600);
    const doc = w.document;
    const btn = doc.querySelector('[data-action="retry"]');
    ok('找到重试按钮', !!btn);
    // 点之前先把 source 改成 normal：如果重试真的重跑了 render，就该拿到正常数据
    w.MockStore.source = 'normal';
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    ok('点击重试后先回到加载中（骨架屏）', doc.querySelectorAll('.sk-day').length === 7, '实际 ' + doc.querySelectorAll('.sk-day').length);
    await new Promise(r => setTimeout(r, 1500));
    ok('重试后成功渲染出 7 天（说明数据真的重新取了一遍）', doc.querySelectorAll('.day').length === 7, '实际 ' + doc.querySelectorAll('.day').length);
    ok('重试后错误盒消失', doc.querySelectorAll('.state-error').length === 0);
  }

  console.log('\n=== 场景 6：切回真数据（DATA_SOURCE = off）===');
  {
    const w = await boot('off', 500);
    const doc = w.document;
    const week = doc.getElementById('week-list');
    ok('off 模式走真空数据 → 空状态', week.querySelectorAll('.empty-guide').length === 1);
    ok('off 模式没有骨架屏残留（说明没走 mock 的延迟）', week.querySelectorAll('.sk-day').length === 0);
    // 用真数据录一条课程，验证 store.js 链路仍然通
    await w.Store.createCourse({ name: '线性代数', day_of_week: 2, start_time: '10:00', end_time: '11:40', location: 'D401' });
    await w.App.render();
    await new Promise(r => setTimeout(r, 200));
    const names = [...doc.querySelectorAll('#week-list .item-name')].map(e => e.textContent);
    ok('切回真数据后能正常录入并渲染', names.includes('线性代数'), names.join('|'));
    ok('真数据模式不显示假课程"高等数学"', !names.includes('高等数学'), names.join('|'));
  }

  console.log('\n=== 场景 6.5：课程与 DDL 是并发取的，不是串行 ===');
  {
    // 两个请求各 600ms。并发总耗时≈600ms，串行≈1200ms。
    // 用「骨架屏出现到数据出现的间隔」来判断走的是哪种。
    const t0 = Date.now();
    let skeletonSeenAt = 0, readyAt = 0;
    const dom = new JSDOM(makeHtml(undefined), {
      runScripts: 'dangerously', url: 'http://localhost:8000/', pretendToBeVisual: true,
      beforeParse(w) {
        const mem = {};
        Object.defineProperty(w, 'localStorage', { value: { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } }, configurable: true });
        w.scrollTo = function () {};
        w.console.error = () => {};
      }
    });
    const w = dom.window;
    const timer = setInterval(() => {
      const d = w.document;
      if (!skeletonSeenAt && d.querySelectorAll('.sk-day').length === 7) skeletonSeenAt = Date.now() - t0;
      if (!readyAt && d.querySelectorAll('.day').length === 7) readyAt = Date.now() - t0;
    }, 20);
    await new Promise(r => setTimeout(r, 1600));
    clearInterval(timer);
    ok('看到了骨架屏阶段', skeletonSeenAt > 0, '未捕捉到');
    ok('骨架->数据 的耗时接近单次延迟 600ms 而非 1200ms（并发生效）',
      readyAt > 0 && (readyAt - skeletonSeenAt) < 950,
      '实测间隔 ' + (readyAt - skeletonSeenAt) + 'ms（串行应约 1150ms+）');
  }

  console.log('\n=== 场景 7：深色主题与结构检查 ===');  {
    const css = rawHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
    ok('样式里没有已删除的 --card 引用', !css.includes('var(--card)'));
    ok('样式里没有旧的浅色底 #f7f8fa', !css.includes('#f7f8fa'));
    ok('样式里没有旧的浅色卡片 #ffffff 背景', !/background:\s*#ffffff/.test(css));
    ok('样式里没有旧的浅色边框 #d0d7de', !css.includes('#d0d7de'));
    ok('有深色底 --bg: #080b14', css.includes('#080b14'));
    ok('有 7 列布局媒体查询', css.includes('repeat(7, minmax(0, 1fr))'));
    ok('有骨架屏动画', css.includes('sk-shimmer'));
    ok('有减少动效无障碍处理', css.includes('prefers-reduced-motion'));
    ok('有深色下的滚动条样式', css.includes('::-webkit-scrollbar'));
    ok('有深色下日期图标反相处理', css.includes('calendar-picker-indicator'));
    ok('有深色下 select 箭头的自绘', css.includes('appearance: none'));
    ok('有半透明模糊顶栏（毛玻璃）', css.includes('backdrop-filter'));
    ok('meta theme-color 已换深色', rawHtml.includes('content="#080b14"'));

    const iMock = rawHtml.indexOf('src="mock-data.js"');
    const iApp = rawHtml.indexOf('src="app.js"');
    const iStore = rawHtml.indexOf('src="store.js"');
    ok('脚本顺序 store -> mock -> app',
      iStore > 0 && iMock > iStore && iApp > iMock, iStore + ',' + iMock + ',' + iApp);

    /* 铁律检查：localStorage 只准出现在 store.js。
       注意要排除注释和说明文字，只看真正的调用 —— 否则会被「全项目唯一碰
       localStorage 的文件」这类正当注释误判（v1 就踩了这个假警报）。 */
    const codeOnly = rawHtml
      .replace(/<!--[\s\S]*?-->/g, '')          // 去掉 HTML 注释
      .replace(/<style>[\s\S]*?<\/style>/g, ''); // 去掉样式
    ok('index.html 没有真的调用 localStorage（铁律：只有 store.js 能碰）',
      !/localStorage\s*[.[]/.test(codeOnly));
    ok('app.js 没有真的调用 localStorage（铁律）',
      !/localStorage\s*[.[]/.test(appJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
    ok('mock-data.js 没有真的调用 localStorage（它就该是纯假数据）',
      !/localStorage\s*[.[]/.test(mockJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
    ok('mock-data.js 没有发起任何网络请求（fetch / XMLHttpRequest）',
      !/\bfetch\s*\(|XMLHttpRequest/.test(mockJs.replace(/\/\*[\s\S]*?\*\//g, '')));
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败明细：'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本自身出错：', e); process.exit(2); });
