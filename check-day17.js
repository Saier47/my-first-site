#!/usr/bin/env node
/**
 * check-day17.js —— Day 17 自检：读接口是否真的读到了真数据库
 * =====================================================================
 * 这个脚本**要联网**（打公网接口），所以它和 check-day16.js 不一样 ——
 * 后者只查本地文件，随时能跑；这个必须云端活着才有意义。
 *
 * 验什么：
 *   A. 文件层  —— 云函数、部署配置、密钥防护脚本都在
 *   B. 安全层  —— 提交物里**没有**真实 Key（这条最重要）
 *   C. 接口层  —— 两个 GET 接口公网可访问、信封正确、数据是真实的
 *   D. 边界层  —— 405 / 404 行为正确，Day15 健康检查没被破坏
 *
 * ⚠️ 为什么 C/D 段必须打真接口、不能查本地：
 *   Day 15 的教训是「请求通了 ≠ 服务是好的」。
 *   今天再加一条：**「本地代码写对了 ≠ 线上跑的是这份代码」**。
 *   只有真打一次公网接口，才算验证过。
 *
 * 跑法：D:/node.exe check-day17.js
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BASE = process.env.API_BASE
  || 'https://my-first-site-d0g3re4p71560e327-1500310885.ap-shanghai.app.tcloudbase.com';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

console.log('========================================');
console.log('Day 17 自检：读接口 /api/courses 与 /api/ddls');
console.log('========================================\n');

// ---------------------------------------------------------------- A 文件层
console.log('【A】文件层');

const fnCode = read('cloudfunctions/api-func/index.js');
const rc = read('cloudbaserc.json');
const inject = read('scripts/inject-key.sh');
const guard = read('scripts/check-no-secrets.sh');
const gi = read('.gitignore');

ok('云函数 api-func/index.js 存在', fnCode !== null);
ok('云函数 scf_bootstrap 存在', fs.existsSync(path.join(ROOT, 'cloudfunctions/api-func/scf_bootstrap')));

if (fnCode) {
  ok('函数监听 9000 端口（平台规定）', /PORT\s*=\s*9000/.test(fnCode));
  ok('从环境变量读 Key（不是写死的）', /process\.env\.CLOUDBASE_API_KEY/.test(fnCode));
  ok('代码里没有写死的 JWT', !/eyJ[A-Za-z0-9_-]{10,}\./.test(fnCode));
  ok('两个路由都定义了', /'\/api\/courses'/.test(fnCode) && /'\/api\/ddls'/.test(fnCode));
  ok('成功信封 { ok, data, requestId }', /ok:\s*true,\s*data,\s*requestId/.test(fnCode));
  ok('失败信封 { ok:false, error:{code,message} }', /ok:\s*false,\s*error:\s*\{\s*code,\s*message/.test(fnCode));
  ok('空结果兜底成数组（不是 null）', /Array\.isArray\(rows\)\s*\?\s*rows\s*:\s*\[\]/.test(fnCode));
  ok('非 GET 返回 405', /405,\s*'METHOD_NOT_ALLOWED'/.test(fnCode));
  ok('未知路径返回 404', /404,\s*'NOT_FOUND'/.test(fnCode));
  ok('上游出错返回 502（不把内部错误抛给前端）', /502,\s*'UPSTREAM_ERROR'/.test(fnCode));
  ok('响应不缓存（改库能立刻看到）', /'Cache-Control':\s*'no-store'/.test(fnCode));
  ok('字段白名单（select 明确列出）', /select=id,name,day_of_week/.test(fnCode) && /select=id,title,due_date/.test(fnCode));
  // 🔑 这条断言 Day 18 修过，值得记一下：
  //    原来写的是 /apiKey=\$\{API_KEY \? '已配置' : / —— 它匹配的是
  //    **模板字符串的具体写法**。Day 18 重写函数时把 `${...}` 换成了字符串拼接，
  //    代码明明**依然不打印 Key**，断言却假失败了。
  //    → 断言要盯"意图"（日志里不泄露 Key），别盯"写法"（用模板串还是拼接）。
  //      这是"测试写得太死"的典型，会让你误以为改坏了东西。
  const logLines = fnCode.split('\n').filter(function (l) {
    return /console\.(log|error)/.test(l);
  });
  ok('日志不打印 Key 本身（所有 console 行都没直接插 API_KEY）',
     logLines.length > 0 && logLines.every(function (l) {
       return !/\$\{API_KEY\}/.test(l)
           && !/\+\s*API_KEY\b/.test(l)
           && !/,\s*API_KEY\s*[,)]/.test(l);
     }),
     '有 console 行直接插了 API_KEY（会把 Key 写进云端日志）');
}

if (rc) {
  ok('cloudbaserc.json 登记了 api-func', /"name":\s*"api-func"/.test(rc));
  ok('函数类型是 HTTP（Day15 踩过 Event 型的坑）', /"type":\s*"HTTP"/.test(rc));
  ok('公网可访问（public: true）', /"public":\s*true/.test(rc));
  ok('登记了网关路径 /api', /"gatewayPath":\s*"\/api"/.test(rc));
  ok('envVariables 里配了环境 ID', /"TCB_ENV_ID"/.test(rc));
  ok('api-health 配置还在（没被覆盖掉）', /"name":\s*"api-health"/.test(rc));
}

ok('inject-key.sh 存在', inject !== null);
ok('check-no-secrets.sh 存在', guard !== null);
ok('.gitignore 忽略了 .secrets/', gi !== null && /^\.secrets\//m.test(gi));

// ---------------------------------------------------------------- B 安全层
console.log('\n【B】安全层（最重要：提交物里不能有真 Key）');

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
ok('cloudbaserc.json 里是占位符不是真 Key',
   rc !== null && !JWT_RE.test(rc),
   rc && JWT_RE.test(rc) ? '发现真 Key！跑 bash scripts/inject-key.sh --restore' : '');
ok('函数代码里没有真 Key', fnCode !== null && !JWT_RE.test(fnCode));
ok('check-no-secrets 装了 pre-commit 钩子',
   fs.existsSync(path.join(ROOT, '.git/hooks/pre-commit')));

// ---------------------------------------------------------------- C 接口层
console.log('\n【C】接口层（打真公网接口）');

/**
 * 打一个 GET 请求。
 *
 * 🔴 为什么用内置 fetch 而不是 curl：
 *    本机沙箱**禁止 Node 派生任何子进程**（连 node 派生 node 都 EBUSY，
 *    见 check-day16.js 的注释）。所以不能 `execFileSync('curl', ...)`。
 *    Node 18+ 自带全局 fetch，正好零依赖、零子进程。
 *
 * @returns {Promise<{status:number, json:any|null, body:string}>}
 */
async function req(url, method = 'GET') {
  const r = await fetch(url, { method, headers: { Accept: 'application/json' } });
  const body = await r.text();
  let json = null;
  try { json = JSON.parse(body); } catch (e) { /* 保留 null */ }
  return { status: r.status, json, body };
}

let courses = null, ddls = null;

async function checkEndpoints() {
  for (const [name, p] of [['courses', '/api/courses'], ['ddls', '/api/ddls']]) {
    let r;
    try {
      r = await req(BASE + p);
    } catch (e) {
      ok(`GET ${p} 能访问`, false, String(e.message).slice(0, 120));
      continue;
    }
    ok(`GET ${p} 返回 HTTP 200`, r.status === 200, '实际 ' + r.status);
    ok(`GET ${p} 返回合法 JSON`, r.json !== null, r.body.slice(0, 80));
    if (!r.json) continue;
    ok(`GET ${p} 有 ok:true`, r.json.ok === true, JSON.stringify(r.json).slice(0, 150));
    ok(`GET ${p} data 是数组`, Array.isArray(r.json.data), typeof r.json.data);
    ok(`GET ${p} 有 requestId`, typeof r.json.requestId === 'string' && r.json.requestId.length > 0);
    ok(`GET ${p} 有数据（≥5 行，不是空壳）`, Array.isArray(r.json.data) && r.json.data.length >= 5,
       '实际 ' + (Array.isArray(r.json.data) ? r.json.data.length : '?') + ' 行');
    ok(`GET ${p} 中文没乱码`,
       Array.isArray(r.json.data) && !/\ufffd/.test(JSON.stringify(r.json.data)));
    if (name === 'courses') courses = r.json.data;
    else ddls = r.json.data;
  }

  // 字段完整性：契约第 3 节
  if (courses && courses.length) {
    const c = courses[0];
    ok('courses 字段齐全（契约第 3.1 节）',
       ['id','name','day_of_week','start_time','end_time','location','created_at','updated_at']
         .every(k => k in c), Object.keys(c).join(','));
    ok('courses 按 day_of_week 升序',
       courses.every((x, i) => i === 0 || courses[i-1].day_of_week <= x.day_of_week));
    // 同一天内按 start_time 升序
    let sameDayOrdered = true;
    for (let i = 1; i < courses.length; i++) {
      if (courses[i-1].day_of_week === courses[i].day_of_week
          && courses[i-1].start_time > courses[i].start_time) sameDayOrdered = false;
    }
    ok('courses 同一天按 start_time 升序', sameDayOrdered);
  }

  if (ddls && ddls.length) {
    const d = ddls[0];
    ok('ddls 字段齐全（契约第 3.2 节）',
       ['id','title','due_date','due_time','note','done','created_at','updated_at']
         .every(k => k in d), Object.keys(d).join(','));
    ok('ddls 按 due_date 升序',
       ddls.every((x, i) => i === 0 || ddls[i-1].due_date <= x.due_date));
    ok('ddls 的 done 是布尔值', typeof d.done === 'boolean', typeof d.done);
  }
}

// ---------------------------------------------------------------- D 边界层
async function checkBoundaries() {
  console.log('\n【D】边界层');

  // ⚠️ Day 18 改过这里：POST /api/courses 现在是**合法的写接口**，
  //    所以"用错方法"这个边界改用 PUT 来测（PUT 在本期仍是 405）。
  let put;
  try {
    put = await req(BASE + '/api/courses', 'PUT');
    ok('PUT 到接口返回 405（Day 18 起 POST 已合法，改用 PUT 测）',
       put.status === 405, '实际 ' + put.status);
    ok('405 也用统一失败信封', put.json && put.json.ok === false
       && put.json.error && put.json.error.code === 'METHOD_NOT_ALLOWED',
       JSON.stringify(put.json).slice(0, 120));
  } catch (e) { ok('PUT 边界测试', false, String(e.message).slice(0, 100)); }

  let nf;
  try {
    nf = await req(BASE + '/api/definitely-not-here');
    ok('未知路径返回 404', nf.status === 404, '实际 ' + nf.status);
    ok('404 也用统一失败信封', nf.json && nf.json.ok === false
       && nf.json.error && nf.json.error.code === 'NOT_FOUND',
       JSON.stringify(nf.json).slice(0, 120));
  } catch (e) { ok('404 边界测试', false, String(e.message).slice(0, 100)); }

  try {
    const h = await req(BASE + '/api/health');
    ok('Day15 的 /api/health 没被破坏', h.status === 200 && h.json && h.json.ok === true,
       '状态 ' + h.status);
  } catch (e) { ok('健康检查回归', false, String(e.message).slice(0, 100)); }
}

// ------------------------------------------------------------------ 主流程
(async () => {
  await checkEndpoints();
  await checkBoundaries();

  console.log('\n========================================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log('  ✗ ' + f));
  }
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
})();
