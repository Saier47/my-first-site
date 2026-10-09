/* index.js —— HTTP 层（Day 19 起，数据库的事搬到了 db.js）
 * ===================================================================
 * 这个函数对外提供两条接口：
 *   GET  /api/courses   GET  /api/ddls      —— 读出数据
 *   POST /api/courses   POST /api/ddls      —— 写进一条
 *
 * 数据流：
 *   app.js → store.js → fetch('/api/courses') → 这个云函数 → db.js → 云数据库
 *
 * -------------------------------------------------------------------
 * 🧱 分层（Day 19 做的重构）
 *
 *   index.js（本文件） = **HTTP 层**：收请求 · 认路由 · 验字段 · 包信封 · 定状态码
 *   db.js              = **数据访问层**：连数据库 · 拼查询 · 读写 · 翻译数据库的错
 *
 *   怎么判断一段代码该放哪层？问一句：
 *     「哪天换掉数据库（或换语言重写这一层），这段代码还要不要？」
 *        要  → 它是 HTTP 的事，留在本文件。
 *        不要 → 它是数据库的事，搬去 db.js。
 *
 *   具体地说，下面这些**全在 db.js 里，本文件一行都没有**：
 *     · 数据库地址、API Key
 *     · PostgREST 的 URL 长什么样、select / order 怎么拼
 *     · `Prefer: return=representation` 是干嘛的
 *     · SQLSTATE 23505 是什么
 *   → 所以本文件里**没有一处**调用上游、没有一处拼查询串、没有一处判断 SQLSTATE。
 *     这不是漏了，是分层生效了。
 *     （上面这几段注释里之所以出现那些词，是在"说它们不该在这层" ——
 *       真要核对，搜代码即可：grep 出来的命中全在注释里。）
 *
 *   ⚠️ 但有一件事**故意留在本层**：**校验**。
 *      因为"课程名不能超过 50 字"是**业务规则**，不是数据库知识 ——
 *      换数据库它也不变。分层不是"按位置切"，是"按变化的理由切"。
 *
 * -------------------------------------------------------------------
 * 为什么是一个函数管四条路由，而不是每个接口一个函数
 *
 *   它们长得几乎一样（都是"读一张表 / 写一张表"），拆成四个云函数
 *   等于把同一套信封、同一段错误处理抄四遍 —— 抄四遍就有不一致的一天
 *   （比如一个返回 []、另一个返回 null）。所以合成一个，按**路径分发**。
 *
 * -------------------------------------------------------------------
 * 🔴 路径归一化（Day 17 部署后实测出来的）
 *
 *   部署配置里 gatewayPath 写的是 `/api`，意思是"整个 /api 交给这个函数"。
 *   实测发现：**网关会把 /api 前缀剥掉再转发** ——
 *     公网请求 /api/courses  →  函数里 req.url 收到的是 /courses
 *   所以下面做了一次归一化：不管带不带前缀，都补成完整路径再查路由表。
 *
 * -------------------------------------------------------------------
 * 🛡️ 防重复提交（Day 18 加，三条线）
 *
 *   线 1 · id 冲突   —— 同一个 id 已经存在 → 409
 *   线 2 · 内容查重   —— 同一门课 / 同一条 DDL 已经录过 → 409
 *   线 3 · 唯一约束   —— 数据库兜底（见 db/alter-day18.sql）
 *
 *   为什么三条都要：
 *     · 只做线 1 是**纸糊的** —— id 由前端随机生成，用户连点两次会生成
 *       两个不同 id，线 1 根本拦不住（我们实测过）。
 *     · 线 2 防住"手滑连点"；线 1 防住"网络重试把同一请求发了两遍"。
 *     · 线 3 防住"线 1、2 查完之后、写入之前"那点并发窗口 ——
 *       应用层判断是软的，数据库约束是硬的。
 *
 * -------------------------------------------------------------------
 * 🔒 关于那个 API Key
 *
 *   它是 service_role，**绕过所有行级权限（RLS）** = 数据库的万能钥匙。
 *   所以它只存在云函数的环境变量里（现在由 db.js 读取），
 *   绝不进前端、绝不进 git、绝不进日志。
 * =================================================================== */

'use strict';

const http = require('http');
const db = require('./db');

// 端口必须是 9000 —— 腾讯云 SCF 平台规定来这里找你（Day 15 踩过）
const PORT = 9000;

// Day 19：拆出数据访问层（0.3.0 → 0.4.0）。对外行为一个字没变。
const VERSION = '0.4.0';

// 请求体上限。课表一条记录最多几百字节，64KB 绰绰有余。
// 设上限是为了防止有人发个巨大请求把内存撑爆（一种最朴素的攻击）。
const MAX_BODY = 64 * 1024;

// id 的形状（客户端传了 id 才校验；没传就由 db.js 生成）
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------
// 路由表
//
// 📌 Day 19 之前，这里还写着 `select=...` 和 `order=...` ——
//    那些是**数据库的知识**（"这张表有哪些字段、默认怎么排"），
//    现在搬到 db.js 的 TABLES 里了。本层只保留"对外"的部分：
//    路径、表名、以及这件业务特有的**校验**和**什么是重复**。
// ---------------------------------------------------------------------
const ROUTES = {
  '/api/courses': {
    table: 'courses',
    write: {
      validate: validateCourse,
      // 同一门课 + 同一天 + 同一开始时间 = 同一节课
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
    write: {
      validate: validateDdl,
      // 同名任务 + 同一天到期 = 同一件事
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
function sendOk(res, data, requestId) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    // 不缓存：在控制台改了数据，刷新页面必须能看到变化。
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
// 🔑 为什么校验留在这一层、不搬去 db.js：
//    "课程名不能超过 50 字"是**业务规则**，换数据库它也不变。
//    判断标准还是那句：「换掉数据库，这段代码还要不要？」
//
// 约定：返回 { ok:true, value:{...} } 或 { ok:false, message:'中文人话' }
//       message 要**说清缺了什么 / 哪里不对**，用户看得懂，不用猜。
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
// 处理读（GET）
//
// 📌 Day 19 之前，这里还写着 fetch、select、JSON.parse 上游响应、
//    判断 'UPSTREAM_BAD_RESPONSE'…… 现在只剩三行：
//    调 db.list → 失败就 502 → 成功就包信封。
//    这就是分层的收益：**本层不再需要知道"数据是怎么取回来的"**。
// =====================================================================
async function handleGet(res, route, pathname, requestId) {
  const result = await db.list(route.table);

  if (!result.ok) {
    // 上游的错误细节已经在 db.js 里打进云端日志了，这儿只回人话。
    sendErr(res, 502, 'UPSTREAM_ERROR', '数据库暂时读不到数据，请稍后再试', requestId);
    return;
  }

  // 空数组的保证现在由 db.js 负责（契约第 5.1 节）。
  sendOk(res, result.rows, requestId);
}

// =====================================================================
// 处理写（POST）
//
// 顺序（每一步失败都立刻返回，不进下一步）：
//   1 读 body        2 解析 JSON     3 校验字段与格式
//   4 定 id          5 查 id 冲突    6 查内容重复
//   7 写入          8 返回完整记录
//
// 🔑 为什么"查重"要排在"写入"前面：
//    为了给用户**人话**（"这门课已经录过了" 比 "duplicate key" 有用得多）。
//    真正的硬保险是数据库唯一约束 —— 万一第 5/6 步之后、写入之前
//    有并发请求钻过去，第 7 步会被数据库挡住，那时 db.js 会把
//    23505 翻译成 'CONFLICT'，我们照旧回 409（见下面的判断）。
// =====================================================================
async function handlePost(req, res, route, pathname, requestId) {
  const write = route.write;
  if (!write) {
    sendErr(res, 405, 'METHOD_NOT_ALLOWED', '这个接口不支持写入', requestId);
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
  //    不能让它掉进最外层的 catch 变成 500 —— 500 的意思是"我崩了"，
  //    会把排查方向带偏。
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

  // ---- 3. 校验（校验函数给的是中文人话）----
  const checked = write.validate(input);
  if (!checked.ok) {
    sendErr(res, 400, 'VALIDATION_FAILED', checked.message, requestId);
    return;
  }
  const record = checked.value;

  // ---- 4. 定 id ----
  // 传了就用（校验形状），没传就交给 db.js 生成 —— 契约说"后端生成"，
  // store.js 现状是前端生成，这样两种说法都成立、前端一行不用改。
  if (!isMissing(input.id)) {
    if (!isStr(input.id) || !ID_RE.test(input.id)) {
      sendErr(res, 400, 'VALIDATION_FAILED',
        'id 格式不正确（只允许字母、数字、下划线、短横线，最长 64 位）', requestId);
      return;
    }
    record.id = input.id;
  }

  // ---- 5. 线 1：id 冲突 ----
  if (record.id) {
    const sameId = await db.findBy(route.table, { id: record.id });
    if (!sameId.ok) {
      sendErr(res, 502, 'UPSTREAM_ERROR', '数据库暂时查不了，请稍后再试', requestId);
      return;
    }
    if (sameId.rows.length > 0) {
      sendErr(res, 409, 'CONFLICT',
        '已经有一条相同 id 的记录了（' + record.id + '），请刷新后重试', requestId);
      return;
    }
  }

  // ---- 6. 线 2：内容重复 ----
  const dupConds = {};
  write.dupKey.forEach(function (k) { dupConds[k] = record[k]; });
  const dup = await db.findBy(route.table, dupConds);
  if (!dup.ok) {
    sendErr(res, 502, 'UPSTREAM_ERROR', '数据库暂时查不了，请稍后再试', requestId);
    return;
  }
  if (dup.rows.length > 0) {
    sendErr(res, 409, 'CONFLICT', write.dupMessage(record), requestId);
    return;
  }

  // ---- 7 + 8. 写入并拿回完整记录 ----
  // db.insert 负责：没 id 就生成、POST 过去、把插入后的完整那一行拿回来。
  const written = await db.insert(route.table, record);

  if (!written.ok) {
    // 🔑 这里只判断"语义"，不去看 23505 那种数据库细节 ——
    //    db.js 已经把它翻译成 reason 了。这就是分层的意思。
    if (written.reason === 'CONFLICT') {
      sendErr(res, 409, 'CONFLICT',
        '这条记录已经存在了（可能是刚才重复提交了），请刷新看看', requestId);
      return;
    }
    sendErr(res, 502, 'UPSTREAM_ERROR', '数据库暂时写不进去，请稍后再试', requestId);
    return;
  }

  // 契约第 5.2 节写的是 **200**。
  // 🎓 值得想一秒：HTTP 语义上 `201 Created` 其实更准确（"建出来了"）。
  //    但**契约是这个项目唯一的约定** —— 实现跟着契约走，不跟着"更优雅"走。
  //    少一处"说好的和做的不一样"，就少一个将来排查到半夜的夜晚。
  sendOk(res, written.row, requestId);
}

// =====================================================================
// HTTP 服务
// =====================================================================
const server = http.createServer(async (req, res) => {
  const requestId = newRequestId();
  const t0 = Date.now();

  // 去掉查询串，只留路径
  let pathname = (req.url || '/').split('?')[0];

  // 路径归一化：不管带不带 /api 前缀，都补成完整路径（见文件头第 3 段）
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

  // ---- 配置检查：钥匙没配上就直说，别让前端猜 ----
  if (!db.isConfigured()) {
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
  console.log('[api-func] env=' + db.ENV_ID + ' apiKey=' + (db.isConfigured() ? '已配置' : '❗未配置'));
});
