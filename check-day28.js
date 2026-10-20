#!/usr/bin/env node
/**
 * check-day28.js —— 结营验收清单（自拟版 · 附录 J 拿不到时用）
 * =====================================================================
 * 设计原则：**每一项都要"当场能打开或展示"**，不是打个勾就算。
 *   尤其是清单点名的三件：POST 后刷新还在 / PATCH 后刷新生效 / DELETE 后刷新没了 ——
 *   这三项要**真写进数据库**，验完再删干净。
 *
 * 分工（沿用 Day 23 摸清的规矩）：
 *   这个 JS 只做「纯 HTTP + 文件检查」，**不 spawn 任何子进程**（沙箱禁 Node 派生进程）。
 *   要起 git / python 的部分交给 preflight.sh（bash 驱动）。
 *
 * 用法：D:/node.exe check-day28.js
 * 退出码：0 = 全过；1 = 有项没过
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const WEB = 'https://my-first-site-d0g3re4p71560e327-1500310885.tcloudbaseapp.com';
const API = 'https://my-first-site-d0g3re4p71560e327-1500310885.ap-shanghai.app.tcloudbase.com';

// 测试数据：带随机后缀，避免和真实数据撞
const TAG = 'd28check_' + crypto.randomBytes(4).toString('hex');
const D_ID = TAG;

let pass = 0, fail = 0;
const failed = [];

function ok(name, detail) { pass++; console.log('  ✅ ' + name + (detail ? '　' + detail : '')); }
function no(name, detail) { fail++; failed.push(name + (detail ? ' → ' + detail : '')); console.log('  ❌ ' + name + (detail ? '　' + detail : '')); }
function skip(name, why) { console.log('  ⏭  ' + name + '　' + why); }

async function getText(url) {
  const r = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
  return { status: r.status, text: await r.text() };
}
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function sendJson(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

(async () => {
  console.log('\n════════════════════════════════════════════════════════');
  console.log('  结营验收清单（自拟 15 项）· my-first-site v1.0.0');
  console.log('════════════════════════════════════════════════════════\n');

  let page = '', html = '';
  try { html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'); } catch (e) {}

  // ---------- A. 能不能打开 ----------
  console.log('【A】能不能打开');

  let st = 0, len = 0;
  try {
    const r = await getText(WEB + '/index.html');
    st = r.status; page = r.text; len = page.length;
  } catch (e) { st = 0; }
  if (st === 200 && len > 1000 && page.indexOf('<title>') > -1) ok('1 公网首页能打开', `HTTP ${st} · ${len} 字节`);
  else no('1 公网首页能打开', `状态=${st} 长度=${len}`);

  if (page.indexOf('这一周') > -1 && page.indexOf('页面访问提示') === -1) {
    ok('2 打开的是应用，不是腾讯云中间页', '含「这一周」· 不含「页面访问提示」');
  } else {
    no('2 打开的是应用，不是腾讯云中间页', '被中间页挡住或内容不对');
  }

  try {
    const r = await getJson(API + '/api/courses');
    if (r.status === 200 && r.json && r.json.ok === true) ok('3 数据接口活着', `GET /api/courses → 200 · ${r.json.data.length} 条`);
    else no('3 数据接口活着', `状态=${r.status}`);
  } catch (e) { no('3 数据接口活着', String(e.message).slice(0, 40)); }

  // ---------- B. 能不能写（清单点名的三件） ----------
  console.log('\n【B】能不能写（真写进库，验完删掉）');

  // 4. POST 后"刷新"还在
  let created = false;
  try {
    const r = await sendJson('POST', API + '/api/ddls', {
      id: D_ID, title: 'Day28 验收测试（自删）', due_date: '2026-12-31', due_time: '23:59', note: TAG,
    });
    created = r.status === 200 && r.json && r.json.ok === true;

    const again = await getJson(API + '/api/ddls');           // 模拟"刷新后再读"
    const found = again.json && again.json.data.some(x => x.id === D_ID);

    if (created && found) ok('4 POST 写入后，重新读取还在', `id=${D_ID} 已入库并被再次读到`);
    else no('4 POST 写入后，重新读取还在', `写入=${created} 再读=${found}`);
  } catch (e) { no('4 POST 写入后，重新读取还在', String(e.message).slice(0, 40)); }

  // 5. PATCH 后"刷新"生效
  if (created) {
    try {
      const NEW = 'Day28 改了名（自删）';
      const r = await sendJson('PATCH', API + '/api/ddls/' + D_ID, { title: NEW });
      const again = await getJson(API + '/api/ddls');
      const row = again.json && again.json.data.find(x => x.id === D_ID);
      if (r.status === 200 && row && row.title === NEW) ok('5 PATCH 改完，重新读取是新值', `标题已变成「${NEW}」`);
      else no('5 PATCH 改完，重新读取是新值', `状态=${r.status} 读回=${row ? row.title : '没找到'}`);
    } catch (e) { no('5 PATCH 改完，重新读取是新值', String(e.message).slice(0, 40)); }
  } else {
    skip('5 PATCH 改完，重新读取是新值', '（第 4 项没写进去，跳过）');
  }

  // 6. DELETE 后"刷新"没了
  if (created) {
    try {
      const r = await sendJson('DELETE', API + '/api/ddls/' + D_ID);
      const again = await getJson(API + '/api/ddls');
      const found = again.json && again.json.data.some(x => x.id === D_ID);
      if (r.status === 200 && !found) ok('6 DELETE 删完，重新读取没有了', `已从库里消失`);
      else no('6 DELETE 删完，重新读取没有了', `状态=${r.status} 还在=${found}`);
    } catch (e) { no('6 DELETE 删完，重新读取没有了', String(e.message).slice(0, 40)); }
  } else {
    skip('6 DELETE 删完，重新读取没有了', '（第 4 项没写进去，跳过）');
  }

  // ---------- C. 功能完整 ----------
  console.log('\n【C】功能完整');

  // ⚠️ 写这个检查时踩的坑（记下来防止再犯）：
  //    视图路由和状态类**大半在 app.js 里**，只搜 index.html 会误报"什么都没有"。
  //    —— 「找不到元素」时先怀疑尺子，别急着判代码有罪。
  let appJs = '';
  try { appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'); } catch (e) {}
  const allSrc = html + '\n' + appJs;

  const views = ['#/week', '#/courses', '#/today'];
  const hitViews = views.filter(v => allSrc.indexOf(v) > -1);
  if (hitViews.length === 3) ok('7 三个视图都在（一周 / 清单 / 今天）', hitViews.join(' '));
  else no('7 三个视图都在', '只找到 ' + hitViews.join(' '));

  // 状态类名按**实际实现**来（index.html 里写明了：加载=骨架屏 / 空=empty-guide / 错=state-error）
  const states = [
    ['skeleton', '加载中（骨架屏）'],
    ['empty-guide', '空'],
    ['state-error', '出错'],
  ];
  const hitStates = states.filter(s => allSrc.indexOf(s[0]) > -1).map(s => s[1]);
  if (hitStates.length === 3) ok('8 四种状态的样式都在（加载 / 空 / 出错）', hitStates.join(' / '));
  else no('8 状态样式不全', '只有 ' + hitStates.join(' / '));

  // 手机宽度：需要真浏览器才能量。Day 27 已用 390×844 实测过，这里只做提示
  skip('9 手机宽度不溢出', '（需真浏览器；Day 27 已实测 390/390 无溢出，见 docs/day27 截图）');

  // 错误文案是不是人话：抓 app.js 里的中文提示（appJs 已在上面读过）
  const humanMsgs = ['没成功', '请填', '请选', '连不上', '刷新一下', '已经开始'];
  const hitMsgs = humanMsgs.filter(m => appJs.indexOf(m) > -1);
  if (hitMsgs.length >= 3) ok('10 错误提示是人话（中文、可操作）', '找到 ' + hitMsgs.length + ' 类：' + hitMsgs.slice(0, 4).join('、'));
  else no('10 错误提示是人话', '只找到 ' + hitMsgs.join('、'));

  if (page.indexOf('class="ver"') > -1 && page.indexOf('v1.0.0') > -1) ok('11 页面上能看到版本号', 'v1.0.0');
  else no('11 页面上能看到版本号');

  // ---------- D. 交付与运维 ----------
  console.log('\n【D】交付与运维');

  const docs = [
    ['README.md', '项目说明'],
    ['PRD.md', '产品定义'],
    ['api-contract.md', '接口契约'],
    ['AGENTS.md', '协作规则'],
    ['docs/day26/回滚手册.md', '回滚手册'],
    ['.workbuddy/skills/preflight-check/SKILL.md', '发布前检查规则'],
  ];
  const missing = docs.filter(([f]) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length === 0) ok('15 关键文档齐全', docs.length + ' 份都在');
  else no('15 关键文档齐全', '缺：' + missing.map(x => x[0]).join('、'));

  // 12/13/14 交给 bash（要起 git / python）
  console.log('\n【E】需要起子进程的三项 → 交给 preflight.sh 与下面单独跑');
  skip('12 发布前检查 8/8', '（见本日输出后面的 preflight 段）');
  skip('13 密钥 0 命中', '（见 audit-secrets 段）');
  skip('14 回滚流程可执行', '（见 rollback dry-run 段）');

  // ---------- 收尾：确保测试数据被清干净 ----------
  try {
    const again = await getJson(API + '/api/ddls');
    const left = again.json.data.filter(x => (x.note || '') === TAG || x.id === D_ID);
    if (left.length) {
      for (const x of left) await sendJson('DELETE', API + '/api/ddls/' + x.id);
      console.log('\n  ⚠️ 清理了 ' + left.length + ' 条残留测试数据');
    } else {
      console.log('\n  🧹 测试数据已清干净（' + again.json.data.length + ' 条）');
    }
  } catch (e) { console.log('\n  ⚠️ 清理检查失败：' + String(e.message).slice(0, 40)); }

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`  本脚本覆盖 12 项：${pass} 通过 · ${fail} 失败`);
  console.log('  （另 3 项由 preflight / audit-secrets / rollback 单独验）');
  console.log('════════════════════════════════════════════════════════');
  if (fail) { console.log('\n失败项：'); failed.forEach(f => console.log('  · ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
})();
