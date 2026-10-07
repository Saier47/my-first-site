/* /api/courses 与 /api/ddls —— 读 + 写接口 HTTP 云函数
 * Day 17 建（读）· Day 18 加写（POST）
 * ===================================================================
 * 这个函数干两件事：
 *   读：把数据库里的真实数据读出来，交给前端
 *   写：把前端新录的一条记录，校验后写进数据库
 *
 * 数据流（Day 18 完整版）：
 *     app.js → store.js → fetch('/api/courses') → 这个云函数 → 云数据库
 *                                    ↕
 *                          GET 读 / POST 写（今天加的）
 *
 * -------------------------------------------------------------------
 * 为什么是「一个函数管两个接口」而不是建两个函数
 *
 *   两个接口长得几乎一样（都是"读一张表/写一张表"），
 *   拆成两个云函数，等于把同一份配置、同一套信封、同一段错误处理写两遍。
 *   写两遍就有不一致的一天 —— 比如一个返回 `[]`、另一个返回 `null`。
 *   所以合成一个函数，按**路径分发**。行话叫「路由」。
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
 *      读：用 URL 查询参数表达"要哪些列、怎么排"（select= / order=）
 *      写：把一个 JSON 对象 POST 过去，网关翻成 INSERT
 *      这就是为什么这个文件里看不到 `SELECT` / `INSERT` 字样 —— 换了表达方式。
 *
 * -------------------------------------------------------------------
 * 🔒 关于 API Key 的权限（必须知道）
 *
 *   我们的 Key 角色是 service_role —— 它**绕过所有行级权限（RLS）**。
 *   换句话说：它就是数据库的万能钥匙。
 *   所以它只存在**云函数的环境变量**里，绝不进前端、绝不进 git。
 *
 * -------------------------------------------------------------------
 * 🛡️ Day 18 的核心：防重复提交（两条线）
 *
 *   线 1 · id 冲突      —— 同一个 id 已经存在 → 409
 *   线 2 · 内容查重      —— 同一门课/同一条 DDL 已经录过 → 409
 *
 *   为什么两条都要（只做一条是纸糊的防线）：
 *     · 只做线 1：id 是**前端随机生成**的，用户连点两次会生成两个不同 id，
 *       库里就留下两条一模一样的课 —— 线 1 根本拦不住。（我们实测过）
 *     · 只做线 2：防不住"网络重试把同一个请求发了两遍"这种底层重复。
 *   两条一起，才既管住"用户手滑"、又管住"网络抖动"。
 *
 *   而且线上还有第三层：数据库的**唯一约束**（见 db/alter-day18.sql）。
 *   应用层判断是"软"的（查完到写入之间有时间窗），数据库约束是"硬"的。
 *   Day 16 学过的道理在这里再应验一次：**约束写在文件里 ≠ 约束真的生效**，
 *   所以要靠接口返回的 409 来证明它真的挡住了。
 * =================================================================== */

'use strict';

const http = require('http');

// 端口必须是 9000 —— 腾讯云 SCF 平台规定来这里找你（Day 15 踩过）
const PORT = 9000;

// Day 18：加写接口，版本从 0.2.0 升到 0.3.0
const VERSION = '0.3.0';

// 请求体上限。课表的一条记录最多几百字节，64KB 绰绰有余。
// 设上限是为了防止有人发一个巨大的请求把内存撑爆（一种最朴素的攻击）。
const MAX_BODY = 64 * 1024;

// ---------------------------------------------------------------------
// 从环境变量拿配置
//
// 🔴 为什么不写死在代码里：
//    cloudfunctions/api-func/index.js 是**要进 git 的**。
//    把 Key 写在这儿 = 把它永久留在 GitHub 上 = 谁都能操作你的数据库。
// ---------------------------------------------------------------------
const ENV_ID = process.env.TCB_ENV_ID || 'my-first-site-d0g3re4p71560e327';
const API_KEY = process.env.CLOUDBASE_API_KEY || '';

// REST 网关的基地址（CloudBase PG 的 PostgREST 端点）
const REST_BASE = `https://${ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest`;

// ---------------------------------------------------------------------
// 两条接口的配置
//
// 🔑 顶层 `select` 是**字段白名单**：只把前端需要的字段发出去，不多发。
//    将来给表加了内部字段（比如 owner_id），不会自动泄露给前端。
// ---------------------------------------------------------------------
const ROUTES = {
  '/api/courses': {
    table: 'courses',
    select: 'id,name,day_of_week,start_time,end_time,location,created_at,updated_at',

    // 契约第 5.1 节：按 day_of_week 升序，同一天按 start_time 升序
    readQuery: 'select=id,name,day_of_week,start_time,end_time,location,created_at,updated_at'
             + '&order=day_of_week.asc,start_time.asc',

    write: {
      idPrefix: 'c',
      validate: validateCourse,
      // 内容查重键：同一门课 + 同一天 + 同一开始时间 = 同一节课
      // ⚠️ 刻意**不含** location：换个教室重录一遍，仍然是"这门课已经录过了"
      dupKey: ['name', 'day_of_week', 'start_time'],
      dupMessage: function (r) {
        return '这门课已经在课表里了（' + r.name + ' · ' + WEEKDAY[r.day_of_week]
             + ' ' + r.start_time + '），不用重复添加';
      },
    },
  },

  '/api/ddls': {
    table: 'ddls',
    select: 'id,title,due_date,due_time,note,done,created_at,updated_at',

    // DDL 按截止时间排。due_date 是文本但定长零填充，"字典序 = 时间序"成立
    readQuery: 'select=id,title,due_date,due_time,note,done,created_at,updated_at'
             + '&order=due_date.asc,due_time.asc',

    write: {
      idPrefix: 'd',
      validate: validateDdl,
      // 内容查重键：同名任务 + 同一天到期
      // ⚠️ 刻意**不含** note：备注改了也还是同一件事
      dupKey: ['title', 'due_date'],
      dupMessage: function (r) {
        return '这条 DDL 已经记过了（' + r.title + ' · ' + r.due_date + '），不用重复添加';
      },
    },
  },
};

// 星期几的中文，用来拼"人话"错误提示。下标 0 空着，让 1 = 周一 直接对上。
const WEEKDAY = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// ---------------------------------------------------------------------
// 统一的响应信封（契约第 2.3 节）
//
// 成功：{ ok: true,  data: ..., requestId }
// 失败：{ ok: false, error: { code, message }, requestId }
//
// ⚠️ 契约里 error 是**对象**（有 code 有人话），不是字符串。
//    前端靠 code 分支、靠 message 显示给用户，两个都需要。
// ---------------------------------------------------------------------
function sendOk(res, data, requestId, httpStatus) {
  res.writeHead(httpStatus || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    // 不缓存：用户在控制台改了数据，刷新页面必须能看到变化。
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
  return 'req_' + Math.random().toString(36).slice(2, 10)
       + Date.now().toString(36);
}

// ---------------------------------------------------------------------
// 生成 id（契约第 3 节）
//
// ⚠️ 和 store.js 第 52 行的 newId() 是**同一套算法**（前缀 + 时间戳36进制 + 随机）。
//    为什么这里也要有一份：契约说 id 可以"后端生成"。
//    前端传了 id 就用前端的（现状如此）；没传就这里补一个 ——
//    这样两种说法都不违背，前端也一行不用改。
// ---------------------------------------------------------------------
function newId(prefix) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return prefix + '_' + stamp + rand;
}

// ---------------------------------------------------------------------
// 读请求体
//
// 云函数的 req 是一个流，body 不是现成的字符串，要一段段收。
// 用 Promise 包一下，让上面能用 await。
// ---------------------------------------------------------------------
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

// =====================================================================
// 校验（契约第 5.2 节）
//
// 🔴 为什么后端必须再校验一遍（前端已经校验过了）：
//    前端的校验是"帮用户少犯错"；后端的校验是"防止脏数据进数据库"。
//    前端能被绕过（改代码、直接用 curl 打接口）——
//    **后端不能假设调用者是善意的。**
//
// 约定：返回 { ok:true, value:{...} } 或 { ok:false, message:'中文人话' }
//       message 要**说清缺了什么/哪里不对**，用户看得懂，不用猜。
// =====================================================================

// 时间：HH:MM（24 小时制）。00-23 时、00-59 分，必须两位。
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// 日期：YYYY-MM-DD。先卡形状，再卡范围。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isStr(v) { return typeof v === 'string'; }

// 「这个字段是不是没给」：undefined / null / 空字符串 都算没给。
// 注意 0 和 false 不算没给 —— 它们在业务上是有意义的值。
function isMissing(v) {
  return v === undefined || v === null || (isStr(v) && v.trim() === '');
}

function validateCourse(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: '请求内容必须是一个 JSON 对象' };
  }

  // ---- name：必填、文字、非空、不超 50 字 ----
  if (isMissing(input.name)) {
    return { ok: false, message: '缺少必填字段 name（课程名），比如「高等数学」' };
  }
  if (!isStr(input.name)) {
    return { ok: false, message: 'name（课程名）必须是文字' };
  }
  const name = input.name.trim();
  if (name.length > 50) {
    return { ok: false, message: '课程名太长了（最多 50 个字，你给了 ' + name.length + ' 个）' };
  }

  // ---- day_of_week：必填、1–7 的整数 ----
  if (isMissing(input.day_of_week)) {
    return { ok: false, message: '缺少必填字段 day_of_week（星期几），应为 1 到 7 的整数（1 = 周一）' };
  }
  const dow = input.day_of_week;
  if (typeof dow !== 'number' || !Number.isInteger(dow) || dow < 1 || dow > 7) {
    return { ok: false, message: 'day_of_week（星期几）必须是 1 到 7 的整数（1 = 周一），你给的是「' + String(dow) + '」' };
  }

  // ---- start_time / end_time：必填、HH:MM、结束晚于开始 ----
  if (isMissing(input.start_time)) {
    return { ok: false, message: '缺少必填字段 start_time（开始时间），格式 HH:MM，比如「08:00」' };
  }
  if (!isStr(input.start_time) || !TIME_RE.test(input.start_time)) {
    return { ok: false, message: 'start_time（开始时间）格式不对，应该是 HH:MM 24 小时制，比如「08:00」，你给的是「' + String(input.start_time) + '」' };
  }
  if (isMissing(input.end_time)) {
    return { ok: false, message: '缺少必填字段 end_time（结束时间），格式 HH:MM，比如「09:40」' };
  }
  if (!isStr(input.end_time) || !TIME_RE.test(input.end_time)) {
    return { ok: false, message: 'end_time（结束时间）格式不对，应该是 HH:MM 24 小时制，比如「09:40」，你给的是「' + String(input.end_time) + '」' };
  }
  // 定长 HH:MM 的字符串比较等价于时间比较（08:00 < 09:40）
  if (input.end_time <= input.start_time) {
    return { ok: false, message: '结束时间（' + input.end_time + '）必须晚于开始时间（' + input.start_time + '）' };
  }

  // ---- location：可选 ----
  // 契约没规定长度上限，这里补一个（防止有人塞一整篇文章进来）。
  let location = input.location;
  if (location === undefined || location === null) location = '';
  if (!isStr(location)) {
    return { ok: false, message: 'location（上课地点）必须是文字' };
  }
  location = location.trim();
  if (location.length > 50) {
    return { ok: false, message: '上课地点太长了（最多 50 个字）' };
  }

  return { ok: true, value: {
    name: name,
    day_of_week: dow,
    start_time: input.start_time,
    end_time: input.end_time,
    location: location,
  } };
}

function validateDdl(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: '请求内容必须是一个 JSON 对象' };
  }

  // ---- title：必填、非空、不超 50 字 ----
  if (isMissing(input.title)) {
    return { ok: false, message: '缺少必填字段 title（任务名），比如「交数据结构实验报告」' };
  }
  if (!isStr(input.title)) {
    return { ok: false, message: 'title（任务名）必须是文字' };
  }
  const title = input.title.trim();
  if (title.length > 50) {
    return { ok: false, message: '任务名太长了（最多 50 个字，你给了 ' + title.length + ' 个）' };
  }

  // ---- due_date：必填、YYYY-MM-DD、真日期 ----
  if (isMissing(input.due_date)) {
    return { ok: false, message: '缺少必填字段 due_date（截止日期），格式 YYYY-MM-DD，比如「2026-10-15」' };
  }
  if (!isStr(input.due_date) || !DATE_RE.test(input.due_date)) {
    return { ok: false, message: 'due_date（截止日期）格式不对，应该是 YYYY-MM-DD，比如「2026-10-15」，你给的是「' + String(input.due_date) + '」' };
  }
  // 光形状对不够 —— 2026-13-45 也符合 \d{4}-\d{2}-\d{2}，要真查月份天数
  const parts = input.due_date.split('-');
  const y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
  // new Date(y, m, 0).getDate() = 第 m 个月的天数（下个月第 0 天 = 本月最后一天）
  const daysInMonth = new Date(y, m, 0).getDate();
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth) {
    return { ok: false, message: '截止日期不存在（' + input.due_date + '），请检查月份和日期' };
  }

  // ---- due_time：可选，空字符串 = 当天结束前 ----
  let dueTime = input.due_time;
  if (dueTime === undefined || dueTime === null) dueTime = '';
  if (!isStr(dueTime)) {
    return { ok: false, message: 'due_time（截止时刻）必须是文字' };
  }
  dueTime = dueTime.trim();
  if (dueTime !== '' && !TIME_RE.test(dueTime)) {
    return { ok: false, message: 'due_time（截止时刻）格式不对，应该是 HH:MM 或留空，你给的是「' + dueTime + '」' };
  }

  // ---- note：可选 ----
  let note = input.note;
  if (note === undefined || note === null) note = '';
  if (!isStr(note)) {
    return { ok: false, message: 'note（备注）必须是文字' };
  }
  note = note.trim();
  if (note.length > 200) {
    return { ok: false, message: '备注太长了（最多 200 个字）' };
  }

  // ⚠️ done 故意不读客户端传的值 —— 契约第 3.2 节：新建时固定 false。
  //    "新建一条已完成的记录"没有意义，允许它只会带来奇怪的状态。
  return { ok: true, value: {
    title: title,
    due_date: input.due_date,
    due_time: dueTime,
    note: note,
    done: false,
  } };
}

// =====================================================================
// 访问上游（REST 网关）的薄封装
// =====================================================================
async function callUpstream(method, pathAndQuery, options) {
  const opts = options || {};
  const headers = { Authorization: 'Bearer ' + API_KEY, Accept: 'application/json' };
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

// 查一下某张表里有没有满足条件的行。返回数组；出错抛异常。
async function findRows(table, query) {
  const r = await callUpstream('GET', '/' + table + '?' + query);
  if (!r.ok) {
    console.error('[api-func] 查重失败 upstream ' + r.status + ': ' + r.text.slice(0, 300));
    throw new Error('UPSTREAM_' + r.status);
  }
  try {
    const rows = JSON.parse(r.text);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error('[api-func] 查重返回的不是 JSON: ' + r.text.slice(0, 200));
    throw new Error('UPSTREAM_BAD_RESPONSE');
  }
}

// 按 PostgREST 的过滤语法拼一个"字段 = 值"的条件
function eqCond(field, value) {
  return field + '=eq.' + encodeURIComponent(String(value));
}

// =====================================================================
// 处理读（GET）
// =====================================================================
async function handleGet(res, route, pathname, requestId) {
  const upstream = await callUpstream('GET', '/' + route.table + '?' + route.readQuery);

  if (!upstream.ok) {
    // 🔴 不把上游的原始错误直接抛给前端 —— 里面可能含表名、SQL 细节。
    //    但要**写进云端日志**，那是给排查用的。
    console.error('[api-func] upstream ' + upstream.status + ' on ' + pathname + ': ' + upstream.text.slice(0, 500));
    sendErr(res, 502, 'UPSTREAM_ERROR', '数据库暂时读不到数据，请稍后再试', requestId);
    return;
  }

  let rows;
  try {
    rows = JSON.parse(upstream.text);
  } catch (e) {
    console.error('[api-func] 上游返回的不是 JSON: ' + upstream.text.slice(0, 300));
    sendErr(res, 502, 'UPSTREAM_BAD_RESPONSE', '数据库返回了无法识别的内容', requestId);
    return;
  }

  // 契约第 5.1 节：没有数据时返回 **空数组**，不是 null。
  // 前端拿到 [] 直接 .length === 0 就行，少一个分支就少一个 bug。
  sendOk(res, Array.isArray(rows) ? rows : [], requestId);
}

// =====================================================================
// 处理写（POST）—— Day 18 的主角
//
// 顺序（每一步失败都立刻返回，不进下一步）：
//   1 读 body        2 解析 JSON     3 校验字段与格式
//   4 定 id          5 查 id 冲突    6 查内容重复
//   7 写入          8 返回完整记录
//
// 🔑 为什么"查重"要在"写入"之前：这是给用户的**人话解释**用的
//    （"这门课已经录过了" 比 "duplicate key" 有用得多）。
//    真正的硬保险是数据库唯一约束 —— 万一第 5/6 步之间有并发请求钻过去，
//    第 7 步会被数据库挡住，那时再转成 409（见下面的 23505 处理）。
// =====================================================================
async function handlePost(req, res, route, pathname, requestId) {
  const write = route.write;
  if (!write) {
    sendErr(res, 405, 'METHOD_NOT_ALLOWED',
      '这个接口不支持写入', requestId);
    return;
  }

  // ---- 1. 读 body ----
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    if (e && e.message === 'TOO_LARGE') {
      sendErr(res, 413, 'PAYLOAD_TOO_LARGE',
        '请求内容太大了（超过 64KB），请检查是不是发错了东西', requestId);
      return;
    }
    console.error('[api-func] 读取请求体失败:', e);
    sendErr(res, 400, 'BAD_REQUEST', '没能读取请求内容，请重试', requestId);
    return;
  }

  // ---- 2. 解析 JSON ----
  // ⚠️ body 不是合法 JSON 是**客户端的问题**，要返回 400，
  //    不能让它掉进下面的 catch 变成 500 —— 500 的意思是"我崩了"，会误导排查方向。
  if (raw.trim() === '') {
    sendErr(res, 400, 'VALIDATION_FAILED',
      '请求内容是空的，请提供要新建的记录（JSON 格式）', requestId);
    return;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    sendErr(res, 400, 'BAD_JSON',
      '请求内容不是合法的 JSON，请检查括号、引号、逗号', requestId);
    return;
  }

  // ---- 3. 校验（校验函数会给出中文人话）----
  const checked = write.validate(input);
  if (!checked.ok) {
    sendErr(res, 400, 'VALIDATION_FAILED', checked.message, requestId);
    return;
  }
  const record = checked.value;

  // ---- 4. 定 id ----
  // 契约说 id 是"后端生成"，但 store.js 现状是前端 newId() 生成。
  // 折中：传了就用（校验形状），没传就补一个 —— 两种说法都成立。
  if (!isMissing(input.id)) {
    if (!isStr(input.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) {
      sendErr(res, 400, 'VALIDATION_FAILED',
        'id 格式不正确（只允许字母、数字、下划线、短横线，最长 64 位）', requestId);
      return;
    }
    record.id = input.id;
  } else {
    record.id = newId(write.idPrefix);
  }

  // ---- 5. 线 1：id 冲突 ----
  const sameId = await findRows(route.table, 'select=id&' + eqCond('id', record.id));
  if (sameId.length > 0) {
    sendErr(res, 409, 'CONFLICT',
      '已经有一条相同 id 的记录了（' + record.id + '），请刷新后重试', requestId);
    return;
  }

  // ---- 6. 线 2：内容重复 ----
  const dupQuery = 'select=id&' + write.dupKey.map(function (k) {
    return eqCond(k, record[k]);
  }).join('&');
  const dup = await findRows(route.table, dupQuery);
  if (dup.length > 0) {
    sendErr(res, 409, 'CONFLICT', write.dupMessage(record), requestId);
    return;
  }

  // ---- 7. 写入 ----
  // Prefer: return=representation → 让网关把**插入后的完整那一行**返回回来，
  // 这样前端拿到就能直接塞进列表，不用自己拼 created_at。
  const upstream = await callUpstream('POST', '/' + route.table, {
    body: JSON.stringify(record),
    prefer: 'return=representation',
  });

  if (!upstream.ok) {
    const bodyLower = upstream.text || '';
    // 唯一约束冲突（SQLSTATE 23505）—— 说明第 5/6 步之后、这一步之前，
    // 有另一个请求抢先写了同样的数据（并发），或者唯一约束抓到了我们没查的键。
    // 这**不是**服务出错，是"重复" —— 所以翻译成 409，不是 502。
    if (upstream.status === 409 || bodyLower.indexOf('23505') >= 0) {
      console.error('[api-func] 唯一约束拦下了一次写入 on ' + pathname + ': ' + bodyLower.slice(0, 300));
      sendErr(res, 409, 'CONFLICT',
        '这条记录已经存在了（可能是刚才重复提交了），请刷新看看', requestId);
      return;
    }
    console.error('[api-func] 写入失败 upstream ' + upstream.status + ' on ' + pathname + ': ' + bodyLower.slice(0, 500));
    sendErr(res, 502, 'UPSTREAM_ERROR', '数据库暂时写不进去，请稍后再试', requestId);
    return;
  }

  // ---- 8. 返回完整记录 ----
  let created;
  try {
    const parsed = JSON.parse(upstream.text);
    created = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (e) {
    created = null;
  }

  // 兜底：万一上游没回完整行（Prefer 没生效），回查一次，保证响应形状稳定。
  // 契约第 5.2 节：返回的是"完整的那条记录" —— 这个承诺不能因为上游行为变化而破。
  if (!created || !created.id) {
    try {
      const rows = await findRows(route.table, 'select=' + route.select + '&' + eqCond('id', record.id));
      created = rows[0] || record;
    } catch (e) {
      created = record;
    }
  }

  // 契约第 5.2 节写的是 **200**。
  // 🎓 这里值得想一秒：HTTP 语义上 `201 Created` 其实**更准确**（"建出来了"）。
  //    但**契约是这个项目唯一的约定** —— 实现跟着契约走，不跟着"更优雅"走。
  //    少一处"说好的和做的不一样"，就少一个将来排查到半夜的夜晚。
  sendOk(res, created, requestId);
}

// =====================================================================
// HTTP 服务
// =====================================================================
const server = http.createServer(async (req, res) => {
  const requestId = newRequestId();
  const t0 = Date.now();

  // 去掉查询串，只留路径
  let pathname = (req.url || '/').split('?')[0];

  // -------------------------------------------------------------------
  // 🔴 路径前缀的处理（Day 17 部署后实测出来的）
  //
  // 部署配置里 gatewayPath 写的是 `/api`，意思是"整个 /api 交给这个函数"。
  // 实测发现：**网关会把 /api 前缀剥掉再转发** ——
  //   公网请求 /api/courses  →  函数里 req.url 收到的是 /courses
  //
  // 所以这里做一次归一化：不管带不带 /api 前缀，都补成完整路径再查路由表。
  // -------------------------------------------------------------------
  if (!pathname.startsWith('/api/')) {
    pathname = '/api' + (pathname === '/' ? '' : pathname);
  }

  const method = String(req.method || 'GET').toUpperCase();

  // ---- 服务端日志（Day 18 余力加练）----
  // 每次请求结束后打一行：编号 · 方法 · 路径 · 状态码 · 耗时。
  // 为什么有用：用户报"保存不上"，让他给 requestId，
  // 这一行就能告诉你"那次到底是 409 还是 502"，不用猜。
  res.on('finish', function () {
    console.log('[api-func] ' + requestId + ' ' + method + ' ' + pathname
      + ' → ' + res.statusCode + ' ' + (Date.now() - t0) + 'ms');
  });

  // ---- 路径不认识 → 404（先判路径，再判方法）----
  // 顺序有讲究：不存在的路径，不管用什么方法都是"没有这个接口"，
  // 说 404 比说 405 更准确。
  const route = ROUTES[pathname];
  if (!route) {
    sendErr(res, 404, 'NOT_FOUND', '没有这个接口：' + pathname, requestId);
    return;
  }

  // ---- 配置检查：Key 没配上就直说，别让前端猜 ----
  if (!API_KEY) {
    sendErr(res, 500, 'SERVER_MISCONFIGURED',
      '服务端没有配置数据库密钥，请联系管理员检查云函数环境变量', requestId);
    return;
  }

  try {
    if (method === 'GET') {
      await handleGet(res, route, pathname, requestId);
    } else if (method === 'POST') {
      await handlePost(req, res, route, pathname, requestId);
    } else {
      // PUT / PATCH / DELETE —— 契约第 2.4 节：用错方法就是 405
      sendErr(res, 405, 'METHOD_NOT_ALLOWED',
        '这个接口只支持 GET 和 POST，你用的是 ' + method, requestId);
    }
  } catch (err) {
    // 网络断了、DNS 挂了、超时……都落这里。
    // 同样：日志留全，给用户的只说人话。
    console.error('[api-func] 处理请求失败 on ' + pathname + ':', err && err.stack ? err.stack : err);
    sendErr(res, 500, 'INTERNAL_ERROR', '服务内部出错了，请稍后再试', requestId);
  }
});

server.listen(PORT, function () {
  console.log('[api-func] v' + VERSION + ' listening on http://0.0.0.0:' + PORT);
  // 只报告"配了没"，绝不打印 Key 本身 —— 日志也是会被人看到的
  console.log('[api-func] env=' + ENV_ID + ' apiKey=' + (API_KEY ? '已配置' : '❗未配置'));
});
