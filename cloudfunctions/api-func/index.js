/* /api/courses 与 /api/ddls —— 读接口 HTTP 云函数（Day 17）
 * ===================================================================
 * 这个函数干一件事：**把数据库里的真实数据读出来，交给前端**。
 *
 * 前 16 天的数据流是：
 *     app.js → store.js → localStorage（你自己电脑的浏览器里）
 *
 * 从今天起变成：
 *     app.js → store.js → fetch('/api/courses') → 这个云函数 → 云数据库
 *
 * -------------------------------------------------------------------
 * 为什么是「一个函数管两个接口」而不是建两个函数
 *
 *   两个接口长得几乎一样（都是"读一张表、返回数组"），
 *   拆成两个云函数，等于把同一份配置、同一套信封、同一段错误处理写两遍。
 *   写两遍就有不一致的一天 —— 比如一个返回 `[]`、另一个返回 `null`。
 *   所以合成一个函数，按**路径分发**。行话叫「路由」。
 *
 *   什么时候该拆？等两边逻辑真的分道扬镳时（比如 DDL 要按用户过滤、
 *   课程是全公开）再拆。现在拆是过早优化。
 *
 * -------------------------------------------------------------------
 * 🔴 关键设计：不直连数据库，走 REST 网关
 *
 *   CloudBase PostgreSQL 有三种访问方式（见官方文档）：
 *     ① 客户端 SDK / REST API（PostgREST）  ← 用这个
 *     ② 云 API ExecutePGSql（要 SecretKey + TC3 签名，麻烦）
 *     ③ pg 包直连（要 host/port/账号/密码，还要开公网连接）
 *
 *   选 ① 的理由，三条都很实在：
 *     · 只要一个 API Key（存在环境变量里），**不用把数据库密码到处放**
 *     · **不用开公网连接** —— 绕过了「开外网 IPv4 + 配安全组」那一串坑
 *     · **不用装 pg 依赖** —— 云函数冷启动更快，`installDependency` 也不用开
 *
 *   ⚠️ 但也因为它走的是 REST 网关，**SQL 不是我们直接写的**：
 *      我们通过 URL 查询参数表达"要哪些列、怎么排、取几条"
 *      （select= / order= / limit=），网关负责翻成 SQL。
 *      这就是为什么这个文件里看不到 `SELECT` 字样 —— 不是漏了，是换了表达方式。
 *
 * -------------------------------------------------------------------
 * 🔒 关于 API Key 的权限（必须知道）
 *
 *   我们的 Key 角色是 service_role —— 它**绕过所有行级权限（RLS）**。
 *   换句话说：它就是数据库的万能钥匙。
 *
 *   所以：
 *     · 它只存在于**云函数的环境变量**里（腾讯云加密保存，前端拿不到）
 *     · **绝对不能**发给浏览器、写进前端代码、提交进 git
 *     · 如果哪天它泄露了 → 立刻去控制台删掉重建
 *
 *   本期没有账号体系（PRD 第 2.2 节砍掉），所有数据是"这台设备的一份"，
 *   所以 service_role 恰好够用，也暂时没有"按用户隔离"的需求。
 * =================================================================== */

'use strict';

const http = require('http');

// 端口必须是 9000 —— 腾讯云 SCF 平台规定来这里找你（Day 15 踩过）
const PORT = 9000;

const VERSION = '0.2.0';

// ---------------------------------------------------------------------
// 从环境变量拿配置
//
// 🔴 为什么不写死在代码里：
//    cloudfunctions/api-func/index.js 是**要进 git 的**。
//    把 Key 写在这儿 = 把它永久留在 GitHub 上 = 谁都能操作你的数据库。
//    环境变量存在云端（腾讯云加密保存），代码里只有一个"占位名字"。
// ---------------------------------------------------------------------
const ENV_ID = process.env.TCB_ENV_ID || 'my-first-site-d0g3re4p71560e327';
const API_KEY = process.env.CLOUDBASE_API_KEY || '';

// REST 网关的基地址（CloudBase PG 的 PostgREST 端点）
const REST_BASE = `https://${ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest`;

// ---------------------------------------------------------------------
// 两个接口各自"要什么数据"的定义
//
// 把它写成数据（而不是散在代码里），好处是：
//   加第三个接口 = 加一个对象，不用动下面的处理逻辑。
//
// 🔑 注意 select 里列出的字段 —— 这是**白名单**：
//   只把前端需要的字段发出去，不多发。
//   将来给表加了内部字段（比如 owner_id），不会自动泄露给前端。
// ---------------------------------------------------------------------
const ROUTES = {
  '/api/courses': {
    table: 'courses',
    // 契约第 5.1 节：按 day_of_week 升序，同一天按 start_time 升序
    query: 'select=id,name,day_of_week,start_time,end_time,location,created_at,updated_at'
         + '&order=day_of_week.asc,start_time.asc',
  },
  '/api/ddls': {
    table: 'ddls',
    // DDL 按截止时间排。due_date 是文本但定长零填充，"字典序 = 时间序"成立
    query: 'select=id,title,due_date,due_time,note,done,created_at,updated_at'
         + '&order=due_date.asc,due_time.asc',
  },
};

// ---------------------------------------------------------------------
// 统一的响应信封（契约第 2.3 节）
//
// 成功：{ ok: true,  data: [...], requestId }
// 失败：{ ok: false, error: { code, message }, requestId }
//
// ⚠️ 契约里 error 是**对象**（有 code 有人话），不是字符串。
//    前端靠 code 分支、靠 message 显示给用户，两个都需要。
// ---------------------------------------------------------------------
function sendOk(res, data, requestId) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    // 读接口不缓存：用户在控制台改了数据，刷新页面必须能看到变化。
    // （今天的验证步骤之一就是"改一行数据库，确认接口跟着变"。）
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ ok: true, data, requestId }));
}

function sendErr(res, httpStatus, code, message, requestId) {
  res.writeHead(httpStatus, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ ok: false, error: { code, message }, requestId }));
}

// ---------------------------------------------------------------------
// 请求 ID：每次请求给个唯一编号
//
// 为什么需要：用户说"我这儿打不开"，你没法问"哪一次请求？"。
// 让他把这个编号发来，就能去云端日志里精确定位那一次。
// ---------------------------------------------------------------------
function newRequestId() {
  // 用随机串而非依赖第三方库：够用、零依赖。
  return 'req_' + Math.random().toString(36).slice(2, 10)
       + Date.now().toString(36);
}

const server = http.createServer(async (req, res) => {
  const requestId = newRequestId();

  // 去掉查询串，只留路径（契约第 4 节：:id 走路径，本期读接口无参数）
  let pathname = (req.url || '/').split('?')[0];

  // -------------------------------------------------------------------
  // 🔴 路径前缀的处理（Day 17 部署后实测出来的）
  //
  // 部署配置里 gatewayPath 写的是 `/api`，意思是"整个 /api 交给这个函数"。
  // 实测发现：**网关会把 /api 前缀剥掉再转发** ——
  //   公网请求 /api/courses  →  函数里 req.url 收到的是 /courses
  //
  // 所以这里做一次归一化：不管带不带 /api 前缀，都补成完整路径再查路由表。
  // 为什么两种都认：网关这个行为是实现细节，官方文档没有明确承诺。
  // 万一将来它改成不剥前缀，这个函数也不会突然全挂 —— 增加的是容错。
  // -------------------------------------------------------------------
  if (!pathname.startsWith('/api/')) {
    pathname = '/api' + (pathname === '/' ? '' : pathname);
  }

  // ---- 只认 GET。别的明确拒绝（契约第 2.4 节：405）----
  if (req.method !== 'GET') {
    sendErr(res, 405, 'METHOD_NOT_ALLOWED',
      `这个接口只支持 GET，你用的是 ${req.method}`, requestId);
    return;
  }

  const route = ROUTES[pathname];
  if (!route) {
    sendErr(res, 404, 'NOT_FOUND',
      `没有这个接口：${pathname}`, requestId);
    return;
  }

  // ---- 配置检查：Key 没配上就直说，别让前端猜 ----
  if (!API_KEY) {
    sendErr(res, 500, 'SERVER_MISCONFIGURED',
      '服务端没有配置数据库密钥，请联系管理员检查云函数环境变量', requestId);
    return;
  }

  try {
    const url = `${REST_BASE}/${route.table}?${route.query}`;

    const upstream = await fetch(url, {
      method: 'GET',
      headers: {
        // 认证头：Bearer + API Key。网关靠它判断"你是谁、能看哪些行"
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json',
      },
    });

    const bodyText = await upstream.text();

    if (!upstream.ok) {
      // 🔴 不把上游的原始错误直接抛给前端 ——
      //    里面可能含表名、SQL 细节等内部信息。
      //    但**要写进云端日志**，那是给排查用的。
      console.error(`[api-func] upstream ${upstream.status} on ${pathname}: ${bodyText.slice(0, 500)}`);
      sendErr(res, 502, 'UPSTREAM_ERROR',
        '数据库暂时读不到数据，请稍后再试', requestId);
      return;
    }

    let rows;
    try {
      rows = JSON.parse(bodyText);
    } catch (e) {
      console.error(`[api-func] 上游返回的不是 JSON: ${bodyText.slice(0, 300)}`);
      sendErr(res, 502, 'UPSTREAM_BAD_RESPONSE',
        '数据库返回了无法识别的内容', requestId);
      return;
    }

    // 契约第 5.1 节：没有数据时返回 **空数组**，不是 null。
    // 前端拿到 [] 直接 .length === 0 就行，少一个分支就少一个 bug。
    const data = Array.isArray(rows) ? rows : [];

    sendOk(res, data, requestId);

  } catch (err) {
    // 网络断了、DNS 挂了、超时……都落这里。
    // 同样：日志留全，给用户的只说人话。
    console.error(`[api-func] 请求上游失败 on ${pathname}:`, err && err.stack ? err.stack : err);
    sendErr(res, 500, 'INTERNAL_ERROR',
      '服务内部出错了，请稍后再试', requestId);
  }
});

server.listen(PORT, () => {
  console.log(`[api-func] v${VERSION} listening on http://0.0.0.0:${PORT}`);
  // 只报告"配了没"，绝不打印 Key 本身 —— 日志也是会被人看到的
  console.log(`[api-func] env=${ENV_ID} apiKey=${API_KEY ? '已配置' : '❗未配置'}`);
});
