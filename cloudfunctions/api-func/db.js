/* db.js —— 数据访问层（Day 19 从 index.js 拆出来的）
 * ===================================================================
 * 这个文件只回答一个问题：**怎么跟数据库说话。**
 *
 * 它**不知道**：
 *   · 什么是 HTTP（这里没有 req / res / 状态码）
 *   · 路由长什么样（不知道 /api/courses 这种路径）
 *   · 什么算"合法输入"（那是校验的事，留在 index.js）
 *   · 响应信封长什么样（{ ok, data, error } 是 index.js 的事）
 *
 * 它**知道**：
 *   · 数据库在哪、钥匙是什么
 *   · 每张表有哪些字段、默认怎么排
 *   · 怎么把"读 / 写"翻译成 PostgREST 的请求
 *   · 上游报的错是什么意思（比如 SQLSTATE 23505 = 重复）
 *
 * -------------------------------------------------------------------
 * 为什么要拆（Day 19）
 *
 *   拆之前，这些"数据库的事"和"HTTP 的事"混在 index.js 的 659 行里。
 *   混着的代价是：改任何一边都得读整个文件，
 *   而且很容易在改接口的时候不小心碰坏数据库那段逻辑（或者反过来）。
 *
 *   拆完之后——
 *     index.js = 对外的服务生（收请求 · 校验 · 回话）
 *     db.js    = 对内的库管（取货 · 存货）
 *   谁换活儿都不用重学对方的规矩。行话叫「分层」。
 *
 * -------------------------------------------------------------------
 * 🔑 返回值的约定（很重要，index.js 全靠它）
 *
 *   每个函数都返回 { ok:true, ... } 或 { ok:false, reason, ... }，
 *   **不抛异常**（网络异常除外，那个由 index.js 兜底）。
 *
 *   `reason` 是**语义**，不是状态码：
 *     'CONFLICT'      东西已经存在（唯一约束拦下的）
 *     'UPSTREAM'      上游（网关/数据库）出错
 *     'BAD_RESPONSE'  上游回的不是能认的 JSON
 *
 *   为什么不直接把 HTTP 状态码和原始报错丢出去：
 *     ① 23505 这种是**数据库的知识**，不该漏到 HTTP 层去判断；
 *     ② "上游回了个 500 的字面文本"对 index.js 毫无意义 ——
 *        它只想知道"这是重复还是故障"，因为这两件事要回不同的码。
 *   → 分层的关键不是"把代码切成两个文件"，而是**每一层只暴露对方能用的词**。
 * =================================================================== */

'use strict';

// ---------------------------------------------------------------------
// 配置：数据库在哪、钥匙是什么
//
// 🔴 为什么不写死在代码里：
//    这几个文件是**要进 git 的**。把 Key 写在这儿 = 把它永久留在 GitHub 上
//    = 谁都能操作你的数据库。所以 Key 只从环境变量读
//    （腾讯云加密保存，前端拿不到）。
// ---------------------------------------------------------------------
const ENV_ID = process.env.TCB_ENV_ID || 'my-first-site-d0g3re4p71560e327';
const API_KEY = process.env.CLOUDBASE_API_KEY || '';

// REST 网关的基地址（CloudBase PostgreSQL 的 PostgREST 端点）
const REST_BASE = 'https://' + ENV_ID + '.api.tcloudbasegateway.com/v1/rdb/rest';

// ---------------------------------------------------------------------
// 每张表"长什么样、默认怎么读"
//
// 🔑 `select` 是**字段白名单**：只把前端需要的字段发出去，不多发。
//    将来表里加了内部字段（比如 owner_id），不会自动泄露给前端。
//
// 📌 Day 19 之前，这两段定义散在 index.js 的 ROUTES 里，
//    和"路由""校验""信封"混在一起。现在它们回到这儿 ——
//    **"这张表有哪些字段"本来就是数据库的知识。**
// ---------------------------------------------------------------------
const TABLES = {
  courses: {
    select: 'id,name,day_of_week,start_time,end_time,location,created_at,updated_at',
    // 契约第 5.1 节：按星期排，同一天按开始时间排
    order: 'day_of_week.asc,start_time.asc',
    // 主键前缀：自动生成 id 时用（和 store.js 的 newId('c') 保持一致）
    idPrefix: 'c',
  },
  ddls: {
    select: 'id,title,due_date,due_time,note,done,created_at,updated_at',
    // DDL 按截止时间排。due_date 是文本但定长零填充，"字典序 = 时间序"成立
    order: 'due_date.asc,due_time.asc',
    idPrefix: 'd',
  },
};

// 钥匙配了没。index.js 用它决定要不要直接回 500（而不是白跑一趟数据库）。
function isConfigured() {
  return API_KEY !== '';
}

function table(name) {
  const t = TABLES[name];
  if (!t) throw new Error('未知的表：' + name);
  return t;
}

// ---------------------------------------------------------------------
// 生成主键
//
// ⚠️ 和 store.js 第 52 行的 newId() 是**同一套算法**（前缀 + 时间戳36进制 + 随机）。
//    契约说 id 可以"后端生成"；前端传了就用前端的（现状如此），没传就这里补一个
//    —— 两种说法都不违背，前端一行不用改。
// ---------------------------------------------------------------------
function newId(prefix) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return prefix + '_' + stamp + rand;
}

// ---------------------------------------------------------------------
// 往上游网关发一个请求。这是本文件唯一碰网络的地方。
// ---------------------------------------------------------------------
async function request(method, pathAndQuery, options) {
  const opts = options || {};
  const headers = {
    // 认证头：Bearer + API Key。网关靠它判断"你是谁、能看哪些行"。
    // ⚠️ 这个 Key 是 service_role，绕过所有行级权限 —— 绝不打印它。
    Authorization: 'Bearer ' + API_KEY,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.prefer) headers['Prefer'] = opts.prefer;

  const upstream = await fetch(REST_BASE + pathAndQuery, {
    method: method,
    headers: headers,
    body: opts.body,
  });
  const text = await upstream.text();
  return { ok: upstream.ok, status: upstream.status, text: text };
}

// ---------------------------------------------------------------------
// 把上游的报错翻译成"我们自己的词"
//
// 🔴 最关键的一条：**SQLSTATE 23505 = 唯一约束冲突 = 重复**。
//    这不是"服务坏了"，而是"东西已经在那了" —— 两件事要回不同的状态码，
//    所以必须在这儿分清楚，别让 index.js 去看字符串瞎猜。
// ---------------------------------------------------------------------
function classify(status, text) {
  const t = String(text || '');
  // PostgREST 遇到唯一约束一般回 409；但也有版本回 400 并在正文里带 SQLSTATE。
  // 两个都认，是为了不依赖上游具体版本的行为。
  if (status === 409 || t.indexOf('23505') >= 0) return 'CONFLICT';
  return 'UPSTREAM';
}

// 统一处理"上游没回好"的情况：写日志（给排查），返回语义化的失败。
function upstreamFailed(action, name, r) {
  const reason = classify(r.status, r.text);
  console.error('[db] ' + action + ' ' + name + ' 失败（' + reason + '）upstream '
    + r.status + ': ' + String(r.text).slice(0, 300));
  return { ok: false, reason: reason, status: r.status };
}

// ---------------------------------------------------------------------
// 读一张表的全部（按表定义的顺序）
// ---------------------------------------------------------------------
async function list(name) {
  const t = table(name);
  const r = await request('GET', '/' + name + '?select=' + t.select + '&order=' + t.order);

  if (!r.ok) return upstreamFailed('读', name, r);

  let rows;
  try {
    rows = JSON.parse(r.text);
  } catch (e) {
    console.error('[db] 读 ' + name + ' 返回的不是 JSON: ' + String(r.text).slice(0, 200));
    return { ok: false, reason: 'BAD_RESPONSE' };
  }

  // 契约第 5.1 节：没有数据时是**空数组**，不是 null。
  // 前端拿到 [] 直接 .length === 0 就行，少一个分支就少一个 bug。
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

// ---------------------------------------------------------------------
// 按条件查（查重用的就是它）
//
// conds 形如 { id: 'c_xxx' } 或 { name: '数据结构', day_of_week: 2 }
// → 拼成 PostgREST 的 `name=eq.数据结构&day_of_week=eq.2`
//
// ⚠️ 值一定要 encodeURIComponent：中文课程名、时间里的冒号（08:00）
//    不编码会让 URL 结构错乱。这是"用 URL 表达查询条件"的代价。
// ---------------------------------------------------------------------
async function findBy(name, conds) {
  const t = table(name);
  const where = Object.keys(conds).map(function (k) {
    return k + '=eq.' + encodeURIComponent(String(conds[k]));
  }).join('&');

  const r = await request('GET', '/' + name + '?select=' + t.select + '&' + where);

  if (!r.ok) return upstreamFailed('查', name, r);

  let rows;
  try {
    rows = JSON.parse(r.text);
  } catch (e) {
    console.error('[db] 查 ' + name + ' 返回的不是 JSON: ' + String(r.text).slice(0, 200));
    return { ok: false, reason: 'BAD_RESPONSE' };
  }
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

// ---------------------------------------------------------------------
// 写一条
//
// · record 里没有 id → 自动生成一个（"后端生成"那条路）
// · 拿到的那一行**来自数据库**（含 created_at / updated_at），不是我们拼的
//   —— 契约第 5.2 节承诺"返回完整的那条记录"，前端可以直接塞进列表
// ---------------------------------------------------------------------
async function insert(name, record) {
  const t = table(name);
  const row = Object.assign({}, record);
  if (!row.id) row.id = newId(t.idPrefix);

  const r = await request('POST', '/' + name, {
    body: JSON.stringify(row),
    // 让网关把**插入后的完整那一行**返回回来
    prefer: 'return=representation',
  });

  if (!r.ok) return upstreamFailed('写', name, r);

  let created = null;
  try {
    const parsed = JSON.parse(r.text);
    created = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (e) {
    created = null;
  }

  // 兜底：万一上游没回完整行（Prefer 没生效），回查一次，保证响应形状稳定。
  // 契约承诺的"完整记录"不能因为上游行为变化而破。
  if (!created || !created.id) {
    const back = await findBy(name, { id: row.id });
    created = (back.ok && back.rows[0]) ? back.rows[0] : row;
  }

  return { ok: true, row: created };
}

module.exports = {
  ENV_ID: ENV_ID,
  isConfigured: isConfigured,
  list: list,
  findBy: findBy,
  insert: insert,
  newId: newId,
};
