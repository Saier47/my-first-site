#!/usr/bin/env node
/**
 * check-day18.js —— Day 18 自检：写接口能不能真的写进去、防重复管不管用
 * =====================================================================
 * 这个脚本**要联网**，而且**会往真数据库里写两行数据**（一条课 + 一条 DDL）。
 *
 * ⚠️ 它写入的两行是**故意的**：
 *    清单要求"数据库多一行"作为证据，截图也要拍"表里新增的那条记录"。
 *    所以这两行是**交付物的一部分**，脚本跑完会把它们的 id 打出来，
 *    方便你截图、也方便以后想删的时候删。
 *
 * ---------------------------------------------------------------------
 * 验什么（对应清单第一句「你防了哪一种重复提交或错误输入？怎么测的？」）：
 *
 *   A. 方法边界  —— PUT/DELETE 该 405、未知路径该 404（且路径优先于方法）
 *   B. 正常写入  —— POST 一门课 → 200 + {ok:true} + 返回完整记录
 *   C. 读回闭环  —— 再 GET 一次，确认刚才写的那条**真的在库里**（这是硬证据）
 *   D. 防重复·线1 —— 同一个 id 再 POST → 409
 *   E. 防重复·线2 —— 同样内容、不同 id 再 POST → 409  ← **这条才是防住"连点两次"的**
 *   F. 错误输入  —— 7 类非法字段 → 400 + **中文**人话
 *   G. 坏请求    —— body 不是 JSON / 是空的 → 400（**不能是 500**）
 *   H. DDL 对称  —— 上面那套在 DDL 上也走一遍（防止"只做了一半"）
 *
 * ---------------------------------------------------------------------
 * 🔴 为什么用带时间戳的数据（STAMP）：
 *    如果用写死的数据，第一次跑能过，第二次跑就会被自己上次写的数据挡住 409，
 *    看起来像"功能坏了"。**加时间戳 = 每次都是全新的数据 = 脚本可反复跑。**
 *    这是写自动化测试的一个通用技巧。
 *
 * 跑法：D:/node.exe check-day18.js
 * =====================================================================
 */

const BASE = process.env.API_BASE
  || 'https://my-first-site-d0g3re4p71560e327-1500310885.ap-shanghai.app.tcloudbase.com';

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

// 清单要求"提示是中文" —— 这条断言要真的检查有没有汉字，不能只看"message 非空"
function hasChinese(s) {
  return typeof s === 'string' && /[\u4e00-\u9fa5]/.test(s);
}

/**
 * 发一个请求。
 *
 * 🔴 为什么用内置 fetch 而不是 curl：
 *    本机沙箱**禁止 Node 派生任何子进程**（连 node→node 都 EBUSY，
 *    见 check-day16.js 的注释）。Node 18+ 自带全局 fetch，零依赖零子进程。
 *
 * @param {string} path
 * @param {string} [method]
 * @param {object|string} [body]  字符串则原样发（用来测"body 不是 JSON"）
 */
async function req(path, method = 'GET', body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 保留 null */ }
  return { status: r.status, json, text };
}

// ---------------------------------------------------------------------
// 本次要用的测试数据（时间戳保证每次跑都不一样）
// ---------------------------------------------------------------------
const STAMP = Date.now().toString(36);
const C_ID = 'c_d18check_' + STAMP;
const C_NAME = 'Day18验证课 ' + STAMP;
const C_BODY = {
  day_of_week: 7,          // 周日 —— 和 10 条种子课程都不撞
  start_time: '23:00',     // 深夜时段 —— 不会和任何真实课冲突
  end_time: '23:50',
  location: '测试（可删）',
};
const D_ID = 'd_d18check_' + STAMP;
const D_TITLE = 'Day18验证DDL ' + STAMP;
// 截止日放在 30 天后（避开种子的日期，也避免和"今天"撞上）
const D_DUE = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

console.log('========================================');
console.log('Day 18 自检：POST 写接口 + 防重复');
console.log('========================================');
console.log('本次测试数据（跑完会留在库里当证据）：');
console.log('  课程 id = ' + C_ID);
console.log('  DDL  id = ' + D_ID);
console.log('');

(async () => {

  // ================================================================ A
  console.log('【A】方法边界');
  const put = await req('/api/courses', 'PUT', {});
  ok('PUT 到写接口 → 405', put.status === 405, '实际 ' + put.status);
  ok('405 用统一失败信封 + 中文',
     put.json && put.json.ok === false && put.json.error
     && put.json.error.code === 'METHOD_NOT_ALLOWED' && hasChinese(put.json.error.message),
     JSON.stringify(put.json).slice(0, 120));

  // ⚠️ Day 22 改过这条标签：DELETE 现在已经能用了。
  //    它测的是**不带 id 的集合路径** —— 删除必须指明删哪一条，
  //    所以打集合路径仍然是 405。
  //    （旧标签写的是「DELETE 到写接口 → 405（本期不做删除）」——
  //      "本期不做删除" 这句话从 Day 22 起就不成立了，属于
  //      **断言绑了实现细节**：代码变了，标签变成了假话。）
  const del = await req('/api/courses', 'DELETE');
  ok('DELETE 打到集合路径（忘了带 id）→ 405', del.status === 405, '实际 ' + del.status);
  ok('405 文案提示"要带上 id"',
     hasChinese(del.json && del.json.error && del.json.error.message)
     && /id/.test((del.json && del.json.error && del.json.error.message) || ''));

  const nf1 = await req('/api/day18-not-here', 'GET');
  ok('未知路径 → 404', nf1.status === 404, '实际 ' + nf1.status);

  const nf2 = await req('/api/day18-not-here', 'POST', {});
  ok('未知路径 + POST → 也是 404（路径判断优先于方法）',
     nf2.status === 404, '实际 ' + nf2.status);

  // ================================================================ B
  console.log('\n【B】正常写入课程');

  // 先数一下现在有几条，待会儿对比
  const before = await req('/api/courses');
  const nBefore = Array.isArray(before.json && before.json.data) ? before.json.data.length : -1;
  ok('写入前能读到课程列表', nBefore >= 0, '拿到 ' + nBefore + ' 条');

  const created = await req('/api/courses', 'POST',
    Object.assign({ id: C_ID, name: C_NAME }, C_BODY));

  ok('POST 正常数据 → 200（契约第 5.2 节）', created.status === 200, '实际 ' + created.status);
  ok('返回 ok:true', created.json && created.json.ok === true,
     JSON.stringify(created.json).slice(0, 150));

  const row = created.json && created.json.data;
  ok('返回的是完整那条记录（契约第 5.2 节）',
     row && ['id','name','day_of_week','start_time','end_time','location','created_at','updated_at']
       .every(k => k in row),
     row ? Object.keys(row).join(',') : '没有 data');
  ok('id 就是请求里给的那个', row && row.id === C_ID, row && row.id);
  ok('name 存对了', row && row.name === C_NAME, row && row.name);
  ok('中文没乱码', row && !/\ufffd/.test(JSON.stringify(row)));
  ok('created_at 由数据库生成（不是前端传的）',
     row && typeof row.created_at === 'string' && row.created_at.length > 10,
     row && row.created_at);
  ok('有 requestId（出错时能定位那一次）',
     created.json && typeof created.json.requestId === 'string' && created.json.requestId.length > 0);

  // ================================================================ C
  console.log('\n【C】读回闭环（写入 → 再读一次确认真的在库里）');

  const after = await req('/api/courses');
  const list = Array.isArray(after.json && after.json.data) ? after.json.data : [];
  const found = list.filter(function (x) { return x.id === C_ID; });

  ok('GET 里能找到刚写的那条', found.length === 1,
     '找到 ' + found.length + ' 条');
  ok('总数 +1（数据库真的多了一行）', list.length === nBefore + 1,
     nBefore + ' → ' + list.length);
  ok('读回来字段一致（不是写了个空壳）',
     found[0] && found[0].name === C_NAME && found[0].location === '测试（可删）',
     JSON.stringify(found[0] || {}).slice(0, 120));

  // ================================================================ D
  console.log('\n【D】防重复 · 线 1：同一个 id 再 POST');

  const dupId = await req('/api/courses', 'POST',
    Object.assign({ id: C_ID, name: C_NAME + '（改个名）' }, C_BODY));
  ok('同 id 重复写入 → 409', dupId.status === 409, '实际 ' + dupId.status);
  ok('409 码是 CONFLICT', dupId.json && dupId.json.error
     && dupId.json.error.code === 'CONFLICT',
     JSON.stringify(dupId.json).slice(0, 120));
  ok('409 提示是中文', dupId.json && dupId.json.error && hasChinese(dupId.json.error.message),
     dupId.json && dupId.json.error && dupId.json.error.message);

  // ================================================================ E
  console.log('\n【E】防重复 · 线 2：同样内容、换一个 id 再 POST');
  console.log('     （⚠️ 这条才是真正防住"用户连点两次保存"的那道线 ——');
  console.log('       因为 id 是前端每次新生成的，线 1 拦不住这种）');

  const dupContent = await req('/api/courses', 'POST',
    Object.assign({ id: C_ID + '_x', name: C_NAME }, C_BODY));
  ok('同内容不同 id → 409', dupContent.status === 409, '实际 ' + dupContent.status);
  ok('409 码是 CONFLICT（不是 500）', dupContent.json && dupContent.json.error
     && dupContent.json.error.code === 'CONFLICT',
     JSON.stringify(dupContent.json).slice(0, 120));
  ok('提示里说了"已经在课表里了"',
     dupContent.json && dupContent.json.error
     && dupContent.json.error.message.indexOf('已经') >= 0,
     dupContent.json && dupContent.json.error && dupContent.json.error.message);

  // 确认这两次被拒的操作**没有偷偷写进去**
  const afterDup = await req('/api/courses');
  const listAfterDup = Array.isArray(afterDup.json && afterDup.json.data) ? afterDup.json.data : [];
  ok('被拒的两次都没落库（总数还是 +1，不是 +3）',
     listAfterDup.length === nBefore + 1,
     '现在 ' + listAfterDup.length + ' 条（期望 ' + (nBefore + 1) + '）');

  // ================================================================ F
  console.log('\n【F】错误输入（全部要 400 + 中文，且说清缺了什么）');

  const badCases = [
    ['缺 name',        { day_of_week: 1, start_time: '08:00', end_time: '09:40' }, 'name'],
    ['name 全是空格',   { name: '   ', day_of_week: 1, start_time: '08:00', end_time: '09:40' }, ''],
    ['name 超 50 字',   { name: '课'.repeat(51), day_of_week: 1, start_time: '08:00', end_time: '09:40' }, ''],
    ['day_of_week 越界',{ name: '测试课', day_of_week: 9, start_time: '08:00', end_time: '09:40' }, ''],
    ['day_of_week 是字符串', { name: '测试课', day_of_week: '3', start_time: '08:00', end_time: '09:40' }, ''],
    ['start_time 格式错',{ name: '测试课', day_of_week: 3, start_time: '8:00', end_time: '09:40' }, ''],
    ['结束早于开始',     { name: '测试课', day_of_week: 3, start_time: '10:15', end_time: '09:40' }, ''],
  ];

  for (const [label, body] of badCases) {
    const r = await req('/api/courses', 'POST', body);
    const msg = r.json && r.json.error && r.json.error.message;
    const isOk = r.status === 400
      && r.json && r.json.ok === false
      && r.json.error && r.json.error.code === 'VALIDATION_FAILED'
      && hasChinese(msg);
    ok(label + ' → 400 + 中文「' + String(msg).slice(0, 40) + '」', isOk,
       '实际 ' + r.status + ' / ' + String(msg).slice(0, 60));
  }

  // ================================================================ G
  console.log('\n【G】坏请求（这类是**客户端**的错，必须是 400 不是 500）');

  const badJson = await req('/api/courses', 'POST', '{这不是合法的 JSON');
  ok('body 不是 JSON → 400（不是 500）', badJson.status === 400, '实际 ' + badJson.status);
  ok('提示是中文', badJson.json && badJson.json.error && hasChinese(badJson.json.error.message),
     badJson.json && badJson.json.error && badJson.json.error.message);

  const emptyBody = await req('/api/courses', 'POST', '');
  ok('body 是空的 → 400', emptyBody.status === 400, '实际 ' + emptyBody.status);

  const arrBody = await req('/api/courses', 'POST', '[]');
  ok('body 是数组而不是对象 → 400', arrBody.status === 400, '实际 ' + arrBody.status);

  // ================================================================ H
  console.log('\n【H】DDL 那一套对称走一遍（防止"只做了一半"）');

  const dBefore = await req('/api/ddls');
  const dnBefore = Array.isArray(dBefore.json && dBefore.json.data) ? dBefore.json.data.length : -1;

  const dCreated = await req('/api/ddls', 'POST',
    { id: D_ID, title: D_TITLE, due_date: D_DUE, note: '验证用' });
  ok('DDL 正常写入 → 200 + ok:true',
     dCreated.status === 200 && dCreated.json && dCreated.json.ok === true,
     '实际 ' + dCreated.status);
  ok('done 固定是 false（契约第 3.2 节）',
     dCreated.json && dCreated.json.data && dCreated.json.data.done === false,
     dCreated.json && dCreated.json.data && String(dCreated.json.data.done));
  ok('due_date 存对了', dCreated.json && dCreated.json.data && dCreated.json.data.due_date === D_DUE,
     dCreated.json && dCreated.json.data && dCreated.json.data.due_date);

  const dAfter = await req('/api/ddls');
  const dList = Array.isArray(dAfter.json && dAfter.json.data) ? dAfter.json.data : [];
  ok('DDL 读回闭环（总数 +1）', dList.length === dnBefore + 1,
     dnBefore + ' → ' + dList.length);
  ok('DDL 读回能按 id 找到', dList.some(function (x) { return x.id === D_ID; }));

  const dDup = await req('/api/ddls', 'POST', { id: D_ID + '_x', title: D_TITLE, due_date: D_DUE });
  ok('DDL 同内容重复 → 409', dDup.status === 409, '实际 ' + dDup.status);
  ok('DDL 409 提示是中文',
     dDup.json && dDup.json.error && hasChinese(dDup.json.error.message),
     dDup.json && dDup.json.error && dDup.json.error.message);

  const dBad = await req('/api/ddls', 'POST', { title: '缺日期' });
  ok('DDL 缺 due_date → 400 + 中文',
     dBad.status === 400 && dBad.json && dBad.json.error && hasChinese(dBad.json.error.message),
     dBad.status + ' / ' + (dBad.json && dBad.json.error && dBad.json.error.message));

  const dBadDate = await req('/api/ddls', 'POST', { title: '日期不存在', due_date: '2026-02-30' });
  ok('DDL 日期 2026-02-30 → 400（形状对但日子不存在）',
     dBadDate.status === 400,
     dBadDate.status + ' / ' + (dBadDate.json && dBadDate.json.error && dBadDate.json.error.message));

  // =============================================================== 汇总
  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('\n失败明细：');
    failures.forEach(function (f) { console.log('  ✗ ' + f); });
  }
  console.log('========================================');
  console.log('');
  console.log('📌 本次写进库里当证据的两行：');
  console.log('   课程：' + C_ID + '  「' + C_NAME + '」 周日 23:00–23:50');
  console.log('   DDL ：' + D_ID + '  「' + D_TITLE + '」 截止 ' + D_DUE);
  console.log('   → 截图就拍这两行。以后想删，见 db/cleanup-day18.sql');
  console.log('');
  process.exit(fail > 0 ? 1 : 0);

})();
