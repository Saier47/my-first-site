#!/usr/bin/env node
/**
 * check-day22.js —— Day 22 自检：改（PATCH）和删（DELETE）到底通没通
 * =====================================================================
 * 这个脚本**要联网**，会往真数据库里写数据 —— 但和 check-day18 不同：
 *
 *   ✅ **它自己会收尾。**
 *   DELETE 上线之前，脚本造的数据只能靠人手跑 SQL 清（Day 18 就留了两行，
 *   还得专门写 db/cleanup-day18.sql）。现在删接口有了 ——
 *   脚本造的数据，脚本自己删掉。**收尾这件事从此不用人工兜底。**
 *   （这也顺带是 DELETE 的第 N 次实测：跑这个脚本本身就在用它。）
 *
 * ---------------------------------------------------------------------
 * 验什么（对应清单「增删改查四类操作闭环」）：
 *
 *   A. 改（PATCH）    —— 只改传的字段 · id/created_at 改不了 · 不存在 → 404
 *                        · 跨字段规则还拦得住 · 撞唯一约束 → 409 · 坏请求 → 400
 *   B. 勾选完成       —— PATCH /api/ddls/<id> { done:true }（契约 5.5：不另开 /toggle）
 *   C. 删（DELETE）   —— 200 + {id,deleted:true} · **删完 GET 里真没了** · 再删 → 404
 *   D. 方法边界       —— 集合路径 vs 单条路径**支持的方法不一样**（Day 22 才有的区分）
 *   E. 四类闭环       —— 建 → 读 → 改 → 读 → 删 → 读，一路串下来
 *   F. 前端源码层     —— store.js 那 4 个函数真的在用 PATCH/DELETE；app.js 不打听接口
 *   G. 收尾           —— 脚本造的数据全部删干净，条数回到起始值
 *
 * ---------------------------------------------------------------------
 * 🔑 本脚本最硬的一类断言：**每一步都重新 GET 一次**
 *
 *   响应说"我改成功了"不算数 —— 那是接口自己说的话。
 *   只有**重新读一遍数据源**、看到值真的变了，才算证据。
 *   （这正是这个项目反复踩出来的那条：工具的"成功"是可以说谎的。）
 *
 * 🔴 数据都带时间戳：写死的数据第二次跑会被自己上次写的挡住 409，
 *    看起来像"功能坏了"。带时间戳 = 每次都是全新数据 = 可反复跑。
 *
 * 跑法：D:/node.exe check-day22.js
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

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

function hasChinese(s) {
  return typeof s === 'string' && /[\u4e00-\u9fa5]/.test(s);
}

async function req(p, method = 'GET', body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 保留 null */ }
  return { status: r.status, json, text };
}

const okEnv = (j) => !!j && j.ok === true;
const errEnv = (j) => !!j && j.ok === false && !!j.error && typeof j.error.code === 'string';
const listCourses = () => req('/api/courses').then(r => (r.json && r.json.data) || []);
const listDdls = () => req('/api/ddls').then(r => (r.json && r.json.data) || []);

// ---------------------------------------------------------------------
// 本次测试数据（时间戳保证可反复跑）
// ---------------------------------------------------------------------
const STAMP = Date.now().toString(36);
const C_ID = 'c_d22check_' + STAMP;
const C_NAME = 'Day22验证课 ' + STAMP;
const D_ID = 'd_d22check_' + STAMP;
const D_TITLE = 'Day22验证DDL ' + STAMP;
const DUE = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

const mkCourse = (over) => Object.assign({
  id: C_ID, name: C_NAME, day_of_week: 7, start_time: '23:00', end_time: '23:50',
  location: '测试（自删）',
}, over || {});

const mkDdl = (over) => Object.assign({
  id: D_ID, title: D_TITLE, due_date: DUE, due_time: '23:00', note: '测试（自删）',
}, over || {});

(async () => {
  console.log('========================================');
  console.log('Day 22 自检 · PATCH / DELETE');
  console.log('========================================');

  const c0 = await listCourses();
  const d0 = await listDdls();
  const total0 = c0.length + d0.length;
  console.log('起始：courses = ' + c0.length + '，ddls = ' + d0.length + '\n');

  // =================================================================
  console.log('【A】改（PATCH）');
  // =================================================================
  const created = await req('/api/courses', 'POST', mkCourse());
  ok('A1 POST 先建一条课当靶子 → 200', created.status === 200 && okEnv(created.json));

  const t0 = (await listCourses()).find(x => x.id === C_ID);
  ok('A2 建完 GET 得到它（拿到"改之前"的样子）', !!t0, t0 ? '' : '没找到 ' + C_ID);

  const p1 = await req('/api/courses/' + encodeURIComponent(C_ID), 'PATCH', { location: 'A101（改过）' });
  ok('A3 PATCH 只改 location → 200', p1.status === 200 && okEnv(p1.json));
  ok('A4 响应里 location 已经是新值', p1.json && p1.json.data.location === 'A101（改过）',
     p1.json && JSON.stringify(p1.json.data.location));
  ok('A5 响应里 name 没被顺手改', p1.json && p1.json.data.name === C_NAME);
  ok('A6 响应里 id 没变', p1.json && p1.json.data.id === C_ID);
  ok('A7 响应里 created_at 没变', p1.json && p1.json.data.created_at === t0.created_at);
  ok('A8 响应里 updated_at 变了', p1.json && p1.json.data.updated_at !== t0.updated_at);

  // ★ 不看响应，去看数据源
  const t1 = (await listCourses()).find(x => x.id === C_ID);
  ok('A9 ★ 重新 GET：库里 location 真的变了', !!t1 && t1.location === 'A101（改过）',
     t1 && JSON.stringify(t1.location));
  ok('A10 ★ 重新 GET：库里 created_at 真没变', !!t1 && t1.created_at === t0.created_at);
  ok('A11 其他字段没被改坏（名字/星期/时间）',
     !!t1 && t1.name === C_NAME && t1.day_of_week === 7 && t1.start_time === '23:00' && t1.end_time === '23:50');
  ok('A12 总条数没变（改不该增删行）', (await listCourses()).length === c0.length + 1);

  const p2 = await req('/api/courses/' + encodeURIComponent(C_ID), 'PATCH',
    { name: C_NAME, start_time: '22:00', end_time: '22:50' });
  ok('A13 PATCH 一次改多个字段 → 200', p2.status === 200 && okEnv(p2.json));
  const t2 = (await listCourses()).find(x => x.id === C_ID);
  ok('A14 两个字段都真的改了', !!t2 && t2.start_time === '22:00' && t2.end_time === '22:50');

  // id / created_at 改不了（契约 5.3）
  const p3 = await req('/api/courses/' + encodeURIComponent(C_ID), 'PATCH',
    { id: 'HACKED', created_at: '2000-01-01T00:00:00Z' });
  ok('A15 只传 id/created_at → 400（没有可修改的字段）', p3.status === 400 && errEnv(p3.json));
  ok('A15b 提示是中文且列出了能改哪些字段',
     hasChinese(p3.json && p3.json.error.message) && /location/.test(p3.json.error.message));
  const t3 = (await listCourses()).find(x => x.id === C_ID);
  ok('A16 ★ 重新 GET：id 和 created_at 都没被改掉',
     !!t3 && t3.id === C_ID && t3.created_at === t0.created_at);

  const p4 = await req('/api/courses/c_not_exist_' + STAMP, 'PATCH', { location: 'x' });
  ok('A17 PATCH 不存在的 id → 404', p4.status === 404);
  ok('A18 错误码是 NOT_FOUND', errEnv(p4.json) && p4.json.error.code === 'NOT_FOUND');
  ok('A19 404 提示是中文', hasChinese(p4.json && p4.json.error.message));

  const p5 = await req('/api/courses/' + encodeURIComponent(C_ID), 'PATCH', { day_of_week: 9 });
  ok('A20 PATCH 非法值（星期几=9）→ 400', p5.status === 400 && errEnv(p5.json));
  ok('A21 提示是中文人话', hasChinese(p5.json && p5.json.error.message));

  const p6 = await req('/api/courses/' + encodeURIComponent(C_ID), 'PATCH', { end_time: '00:01' });
  ok('A22 PATCH 跨字段规则：结束早于开始 → 400', p6.status === 400);
  ok('A22b 提示说清了是"结束必须晚于开始"',
     /结束时间/.test((p6.json && p6.json.error.message) || ''));
  const t4 = (await listCourses()).find(x => x.id === C_ID);
  ok('A23 ★ 被拦下的那次：库里 end_time 没被改坏', !!t4 && t4.end_time === '22:50');

  // 撞唯一约束：改成和另一条课完全一样
  const other = c0[0];
  const p7 = await req('/api/courses/' + encodeURIComponent(C_ID), 'PATCH',
    { name: other.name, day_of_week: other.day_of_week, start_time: other.start_time, end_time: other.end_time });
  ok('A24 PATCH 改成已存在的组合 → 409', p7.status === 409);
  ok('A25 409 错误码是 CONFLICT', errEnv(p7.json) && p7.json.error.code === 'CONFLICT');
  ok('A26 409 提示是中文', hasChinese(p7.json && p7.json.error.message));

  const p8 = await req('/api/courses/' + encodeURIComponent(C_ID), 'PATCH', '');
  ok('A27 PATCH 空 body → 400（不是 500）', p8.status === 400);
  const p9 = await req('/api/courses/' + encodeURIComponent(C_ID), 'PATCH', '{不是JSON');
  ok('A28 PATCH body 不是 JSON → 400（不是 500）', p9.status === 400);

  // =================================================================
  console.log('\n【B】勾选完成也走 PATCH（契约 5.5：不另开 /toggle）');
  // =================================================================
  const db0 = await req('/api/ddls', 'POST', mkDdl());
  ok('B1 POST 建一条 DDL 当靶子 → 200', db0.status === 200 && okEnv(db0.json));
  ok('B2 新建时 done 固定 false', db0.json && db0.json.data.done === false);

  const b1 = await req('/api/ddls/' + encodeURIComponent(D_ID), 'PATCH', { done: true });
  ok('B3 PATCH { done:true } → 200', b1.status === 200 && okEnv(b1.json));
  const dd1 = (await listDdls()).find(x => x.id === D_ID);
  ok('B4 ★ 重新 GET：库里 done 真的是 true', !!dd1 && dd1.done === true);

  for (const bad of ['yes', 1, 'true', null]) {
    const b = await req('/api/ddls/' + encodeURIComponent(D_ID), 'PATCH', { done: bad });
    ok('B5 done=' + JSON.stringify(bad) + ' 非布尔 → 400（不能静默写成 false）',
       b.status === 400 && errEnv(b.json));
  }
  const dd2 = (await listDdls()).find(x => x.id === D_ID);
  ok('B6 ★ 那几次被拦下的请求：库里 done 还是 true（没被写坏）', !!dd2 && dd2.done === true);

  const b2 = await req('/api/ddls/' + encodeURIComponent(D_ID), 'PATCH', { done: false });
  ok('B7 PATCH { done:false } → 200，且库里回到 false',
     b2.status === 200 && (await listDdls()).find(x => x.id === D_ID).done === false);

  // =================================================================
  console.log('\n【C】删（DELETE）');
  // =================================================================
  const dBefore = await listDdls();
  ok('C1 删之前 GET 里能找到它', dBefore.some(x => x.id === D_ID));

  const del = await req('/api/ddls/' + encodeURIComponent(D_ID), 'DELETE');
  ok('C2 DELETE → 200', del.status === 200 && okEnv(del.json));
  ok('C3 响应体是 { id, deleted: true }（契约 5.4）',
     del.json && del.json.data && del.json.data.id === D_ID && del.json.data.deleted === true,
     del.json && JSON.stringify(del.json.data));

  const dAfter = await listDdls();
  ok('C4 ★ 重新 GET：按 id 找不到了（契约要的"不再返回"）', !dAfter.some(x => x.id === D_ID));
  ok('C5 ★ 重新 GET：按标题也找不到了', !dAfter.some(x => x.title === D_TITLE));
  ok('C6 ★ 总条数回到删除前的起始值', dAfter.length === d0.length);

  const del2 = await req('/api/ddls/' + encodeURIComponent(D_ID), 'DELETE');
  ok('C7 再删同一条 → 404（不能假装成功）', del2.status === 404);
  ok('C8 错误码是 NOT_FOUND', errEnv(del2.json) && del2.json.error.code === 'NOT_FOUND');
  ok('C9 提示是中文', hasChinese(del2.json && del2.json.error.message));

  const ghost = await req('/api/ddls/d_never_' + STAMP, 'DELETE');
  ok('C10 删一个压根不存在的 id → 404', ghost.status === 404 && errEnv(ghost.json));

  // =================================================================
  console.log('\n【D】方法边界：集合路径 vs 单条路径（Day 22 才有的区分）');
  // =================================================================
  const m1 = await req('/api/courses', 'PATCH', { location: 'x' });
  ok('D1 PATCH 打到集合路径（忘了带 id）→ 405', m1.status === 405);
  ok('D2 文案点出了"请带上它的 id"', /id/.test((m1.json && m1.json.error.message) || ''));
  const m2 = await req('/api/courses', 'DELETE');
  ok('D3 DELETE 打到集合路径 → 405', m2.status === 405);
  const m3 = await req('/api/courses/' + encodeURIComponent(C_ID), 'GET');
  ok('D4 GET 打到单条路径 → 405', m3.status === 405);
  const m4 = await req('/api/courses/' + encodeURIComponent(C_ID), 'POST', {});
  ok('D5 POST 打到单条路径 → 405', m4.status === 405);
  const m5 = await req('/api/nope', 'GET');
  ok('D6 未知路径 → 404', m5.status === 404);
  const m6 = await req('/api/nope/' + STAMP, 'PATCH', {});
  ok('D7 未知路径带 id → 404（路径优先于方法）', m6.status === 404);
  ok('D8 405 也是统一失败信封', errEnv(m1.json) && m1.json.error.code === 'METHOD_NOT_ALLOWED');
  ok('D9 404 也是统一失败信封', errEnv(m5.json) && m5.json.error.code === 'NOT_FOUND');

  // =================================================================
  console.log('\n【E】四类闭环：建 → 读 → 改 → 读 → 删 → 读');
  // =================================================================
  const loopId = 'c_d22loop_' + STAMP;
  const e1 = await req('/api/courses', 'POST', mkCourse({ id: loopId, name: '闭环验证课 ' + STAMP }));
  ok('E1 建：POST → 200', e1.status === 200 && okEnv(e1.json));
  const e2 = await listCourses();
  ok('E2 读：GET 里能查到', e2.some(x => x.id === loopId));
  const e3 = await req('/api/courses/' + encodeURIComponent(loopId), 'PATCH', { location: '闭环教室' });
  ok('E3 改：PATCH → 200', e3.status === 200 && okEnv(e3.json));
  ok('E4 读：GET 里值真的变了',
     (await listCourses()).find(x => x.id === loopId).location === '闭环教室');
  const e5 = await req('/api/courses/' + encodeURIComponent(loopId), 'DELETE');
  ok('E5 删：DELETE → 200', e5.status === 200 && okEnv(e5.json));
  ok('E6 读：GET 里没了', !(await listCourses()).some(x => x.id === loopId));

  // =================================================================
  console.log('\n【F】前端源码层：接线对不对');
  // =================================================================
  const root = __dirname;
  const storeSrc = fs.readFileSync(path.join(root, 'store.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

  ok('F1 store.js 的 updateCourse 用 PATCH', /updateCourse[\s\S]{0,400}?PATCH/.test(storeSrc));
  ok('F2 store.js 的 deleteCourse 用 DELETE', /deleteCourse[\s\S]{0,300}?DELETE/.test(storeSrc));
  ok('F3 store.js 的 updateDdl 用 PATCH', /updateDdl[\s\S]{0,400}?PATCH/.test(storeSrc));
  ok('F4 store.js 的 deleteDdl 用 DELETE', /deleteDdl[\s\S]{0,300}?DELETE/.test(storeSrc));
  ok('F5 store.js 里 update/delete 都拼了 /<id> 路径', /'\/api\/courses\/' \+ encodeURIComponent\(id\)/.test(storeSrc)
     && /'\/api\/ddls\/' \+ encodeURIComponent\(id\)/.test(storeSrc));
  ok('F6 app.js 里没有 API_BASE（视图层不打听接口地址）', !/API_BASE/.test(appSrc));
  ok('F7 app.js 里没有 fetch 直调接口', !/fetch\s*\(\s*['"`]/.test(appSrc));

  // =================================================================
  console.log('\n【G】收尾：脚本自己把造的数据删干净（DELETE 上线后第一次能做到）');
  // =================================================================
  const cleanup = [];
  const stillCourses = (await listCourses()).filter(x => /_d22(check|loop)_/.test(x.id));
  for (const x of stillCourses) cleanup.push(await req('/api/courses/' + encodeURIComponent(x.id), 'DELETE'));
  const stillDdls = (await listDdls()).filter(x => /_d22check_/.test(x.id));
  for (const x of stillDdls) cleanup.push(await req('/api/ddls/' + encodeURIComponent(x.id), 'DELETE'));

  ok('G1 本脚本造的数据已全部删除（每一条都回 200）',
     cleanup.length > 0 && cleanup.every(r => r.status === 200), '删了 ' + cleanup.length + ' 条');

  const cFin = await listCourses();
  const dFin = await listDdls();
  ok('G2 ★ 最终条数回到最初', cFin.length + dFin.length === total0,
     cFin.length + '+' + dFin.length + ' vs ' + total0);
  ok('G3 ★ 库里没有任何本脚本的残留',
     !cFin.some(x => /_d22(check|loop)_/.test(x.id)) && !dFin.some(x => /_d22check_/.test(x.id)));

  // =================================================================
  console.log('\n========================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log('  · ' + f));
  } else {
    console.log('\n📌 起始 ' + total0 + ' 条 → 结束 ' + (cFin.length + dFin.length) + ' 条，一行没多。');
    console.log('   这次不用再跑 SQL 清理脚本了 —— 删接口自己就能收尾。');
  }
  process.exit(fail === 0 ? 0 : 1);
})();
