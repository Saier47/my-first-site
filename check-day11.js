/* Day 11 反馈与连续操作验证（check-day11.js）
   ⚠️ 关于等待时间（本日最大的坑，写在最前面免得下次再犯）：
   实测每个操作从"点击"到"界面真的变了"要 ~1800ms，不是 600ms。
   拆开是：写数据 600ms + render 里 loadData 600ms + 后续渲染余量。
   所以断言前一律等 ≥2000ms；宁多等，别把"还没生效"当成"没生效"。
   （今天因为这个误判了三次，三次都以为是产品 bug。）

   板块③：连续操作测试。重点验：
     1. 保存时按钮真的被禁用 + 有 saving 锁（防连点）
     2. 疯狂连点「保存」会不会存进多条
     3. 连续保存多次，提示条会不会互相掐断
   另外验一下原来的功能没被弄坏（保存 / 编辑 / 删除 / 勾选）。
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
  // ⚠️ 2026-09-30：产品默认已改成"真数据"（DATA_SOURCE='off'），
  // 测试要的是可复现的固定输入，所以这里统一覆盖成假数据。
  const mock = mockJs.replace(/var DATA_SOURCE = '[^']*';/, "var DATA_SOURCE = 'normal';");
  return rawHtml
    .replace('<script src="store.js"></script>', '<script>' + storeJs + '</script>')
    .replace('<script src="mock-data.js"></script>', '<script>' + mock + '</script>')
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

async function boot(waitMs) {
  const dom = new JSDOM(makeHtml(), {
    runScripts: 'dangerously',
    url: 'http://localhost:8000/',
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
  await sleep(waitMs || 1500);
  return dom.window;
}

function fillCourse(w, name) {
  const doc = w.document;
  doc.getElementById('c-name').value = name;
  doc.getElementById('c-day').value = '3';
  doc.getElementById('c-start').value = '16:00';
  doc.getElementById('c-end').value = '17:40';
  const loc = doc.getElementById('c-location');
  if (loc) loc.value = 'D210';
}

(async () => {
  const w = await boot(1500);
  const doc = w.document;

  console.log('\n=== 场景 1：保存 -> 立刻检查按钮是否被禁用 ===');
  {
    click(w, doc.getElementById('btn-add'));
    await sleep(300);
    const form = doc.getElementById('form-course');
    const btn = form.querySelector('button[type="submit"]');
    fillCourse(w, '反馈测试课A');

    const beforeText = btn.textContent.trim();
    const beforeDisabled = btn.disabled;

    // 提交，然后**立刻**（不等）看按钮状态
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    const justAfterDisabled = btn.disabled;
    const justAfterText = btn.textContent.trim();
    const justAfterBusy = btn.classList.contains('is-busy');

    ok('提交前按钮可点', beforeDisabled === false, 'disabled=' + beforeDisabled);
    ok('提交前按钮文案是「保存」', beforeText === '保存', '实际「' + beforeText + '」');
    ok('刚提交按钮立刻被禁用（防连点）', justAfterDisabled === true, 'disabled=' + justAfterDisabled);
    ok('刚提交按钮立刻变「保存中…」', justAfterText === '保存中…', '实际「' + justAfterText + '」');
    ok('刚提交按钮带上 .is-busy（转圈）', justAfterBusy === true);

    // 等保存走完
    await sleep(2000);
    const afterDisabled = btn.disabled;
    const afterText = btn.textContent.trim();
    ok('保存完成后按钮恢复可点', afterDisabled === false, 'disabled=' + afterDisabled);
    ok('保存完成后文案恢复「保存」', afterText === '保存', '实际「' + afterText + '」');
    ok('弹层已关闭', doc.getElementById('modal').hidden === true);

    const cs = await w.MockStore.listCourses();
    ok('课程确实存进去了（1 条）', cs.filter(c => c.name === '反馈测试课A').length === 1);
  }

  console.log('\n=== 场景 2：疯狂连点「保存」10 次，只能存 1 条 ===');
  {
    const before = (await w.MockStore.listCourses()).length;
    click(w, doc.getElementById('btn-add'));
    await sleep(300);
    const form = doc.getElementById('form-course');
    const btn = form.querySelector('button[type="submit"]');
    fillCourse(w, '连点测试课B');

    // 模拟用户狂点：同一帧内连发 10 次 submit + 10 次 click
    for (let i = 0; i < 10; i++) {
      form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      click(w, btn);
    }
    await sleep(2500);

    const after = (await w.MockStore.listCourses()).length;
    const dup = (await w.MockStore.listCourses()).filter(c => c.name === '连点测试课B').length;
    ok('连点 10 次后总课程数只 +1', after === before + 1, before + ' -> ' + after);
    ok('没有存出重复记录', dup === 1, '同名记录 ' + dup + ' 条');
  }

  console.log('\n=== 场景 3：提示条（toast）真的出现、文案带名字 ===');
  {
    const toast = doc.getElementById('toast');
    const toastText = doc.getElementById('toast-text');
    // 上一次保存后 2.4 秒内应该还在显示（场景 2 刚等 2.5 秒，可能已消失）
    // 重新存一条来观察
    click(w, doc.getElementById('btn-add'));
    await sleep(300);
    const form = doc.getElementById('form-course');
    fillCourse(w, '提示条测试课C');
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    // 保存 = createCourse(600ms) + render(600ms)，严格等够再断言
    await sleep(1800);

    ok('保存后提示条已显示（hidden=false）', toast.hidden === false);
    ok('提示条带 .is-on（已淡入）', toast.classList.contains('is-on'));
    ok('提示条文案说清存了什么', (toastText.textContent || '').indexOf('提示条测试课C') >= 0, '实际「' + toastText.textContent + '」');
    ok('提示条有 role=status（屏幕阅读器能播报）', toast.getAttribute('role') === 'status');

    // 等它自己消失
    await sleep(3200);
    ok('约 2.4 秒后提示条自动淡出并隐藏', toast.hidden === true && !toast.classList.contains('is-on'),
      'hidden=' + toast.hidden + ' is-on=' + toast.classList.contains('is-on'));
  }

  console.log('\n=== 场景 4：连续保存 3 次，提示条不互相掐断 ===');
  {
    const names = ['连续1', '连续2', '连续3'];
    let lastSeen = '';
    for (const nm of names) {
      click(w, doc.getElementById('btn-add'));
      await sleep(300);
      fillCourse(w, nm);
      doc.getElementById('form-course').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await sleep(1300);      // 保存完成
      lastSeen = doc.getElementById('toast-text').textContent || '';
      const shown = doc.getElementById('toast').hidden === false;
      ok('保存「' + nm + '」后提示条显示且文案对得上', shown && lastSeen.indexOf(nm) >= 0, '文案「' + lastSeen + '」');
    }
    // 最后一次的提示条应该还能待满自己的时长
    await sleep(1500);
    ok('最后一条提示条没有被前一条提前掐断', doc.getElementById('toast').hidden === false,
      '提前消失了');
    const cs = await w.MockStore.listCourses();
    ok('3 条课程都存进去了', names.every(n => cs.some(c => c.name === n)));
  }

  console.log('\n=== 场景 5：原来的功能没被弄坏 ===');
  {
    // 勾选（每次重渲染后 DOM 会换新，所以每一步都重新查）
    click(w, doc.querySelector('.tab[data-view="courses"]'));
    await sleep(400);
    const beforeDone = (await w.MockStore.listDdls()).filter(x => x.done).length;
    const box = [...doc.getElementById('ddl-list').querySelectorAll('input.row-check')].filter(b => !b.checked)[0];
    if (box) {
      click(w, box);
      await sleep(2200);
      const afterDone = (await w.MockStore.listDdls()).filter(x => x.done).length;
      ok('勾选完成仍然生效', afterDone === beforeDone + 1, beforeDone + ' -> ' + afterDone);
    } else { ok('有可勾选的 DDL', false, '没有找到未勾选项'); }

    // 删除
    const beforeCnt = (await w.MockStore.listDdls()).length;
    const delBtn = doc.getElementById('ddl-list').querySelector('[data-action="delete"]');
    if (delBtn) {
      click(w, delBtn);
      await sleep(2400);
      const afterCnt = (await w.MockStore.listDdls()).length;
      ok('删除仍然生效', afterCnt === beforeCnt - 1, beforeCnt + ' -> ' + afterCnt);
    } else { ok('找到删除按钮', false); }

    // 编辑：回填 + 保存
    // ⚠️ 必须先重新查 DOM！上面的删除操作会触发重渲染，
    //    之前抓到的 ddlList / editBtn 已经是「脱离文档的旧节点」，
    //    点它不会有任何反应 —— 这不是产品 bug，是脚本用了过期引用。
    const editBtn = doc.getElementById('ddl-list').querySelector('[data-action="edit"]');
    if (editBtn) {
      click(w, editBtn);
      // 点编辑后要等 openEdit 读一次数据 + 弹层渲染，给足余量
      await sleep(2400);
      const m = doc.getElementById('modal');
      ok('点编辑弹层打开且带出原值', m.hidden === false && (doc.getElementById('d-title').value || '').length > 0,
        'title=「' + doc.getElementById('d-title').value + '」');
      const t = doc.getElementById('d-title');
      t.value = '编辑后标题';
      doc.getElementById('form-ddl').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await sleep(3000);      // update + render + 余量
      const all = await w.MockStore.listDdls();
      ok('编辑保存生效（标题已更新）', all.some(x => x.title === '编辑后标题'));
      ok('编辑走的是「已更新」文案', (doc.getElementById('toast-text').textContent || '').indexOf('已更新') >= 0,
        '实际「' + doc.getElementById('toast-text').textContent + '」');
    } else { ok('找到编辑按钮', false); }
  }

  console.log('\n=== 场景 6：校验失败时不进入「保存中」 ===');
  {
    click(w, doc.getElementById('btn-add'));
    await sleep(300);
    // 故意不填必填项就提交
    const form = doc.getElementById('form-course');
    const btn = form.querySelector('button[type="submit"]');
    doc.getElementById('c-name').value = '';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(400);
    ok('校验失败时按钮没被禁用（不该假装在保存）', btn.disabled === false, 'disabled=' + btn.disabled);
    ok('校验失败时按钮文案没变成「保存中…」', btn.textContent.trim() === '保存', '实际「' + btn.textContent.trim() + '」');
    const errBox = doc.getElementById('err-course');
    ok('校验失败有错误提示', errBox && errBox.hidden === false && (errBox.textContent || '').length > 0,
      '「' + (errBox ? errBox.textContent : '') + '」');
  }

  console.log('\n=== 场景 7：运行期错误 ===');
  {
    ok('全程没有 console.error', (w.__errors || []).length === 0, (w.__errors || []).join(' | '));
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fails.length) {
    console.log('\n失败明细：');
    fails.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})();
