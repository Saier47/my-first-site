/* =====================================================================
 * store.js —— 数据读写层（Day 20 起：数据在云上）
 * ---------------------------------------------------------------------
 * 铁律（TECH_DESIGN 第 2.3 节）：
 *   整个项目只有这个文件可以碰"数据从哪来"。
 *   app.js / index.html 想要数据，只能调这里暴露的函数。
 *
 * 🔴 Day 20 的变化（就是今天要做的事）：
 *   本文件的**内部实现**从「读 localStorage」换成了「调后端接口」。
 *   但下面 8 个函数的**名字、参数、返回值一个字没改** ——
 *   所以 app.js 一行都没动（它只认 Store.listCourses() 这个名字）。
 *
 *   改前：app.js → Store.listCourses() → localStorage
 *   改后：app.js → Store.listCourses() → fetch('/api/courses') → 云函数 → 数据库
 *
 *   这就是 Day 5 埋的那条线今天收网 ——
 *   "将来只重写 store.js 内部，app.js 一行不改" 从口号变成了事实。
 *
 * 为什么所有函数本来就是 async：
 *   网络请求天生是异步的。Day 8 写这个文件时就把函数写成 async 了，
 *   所以今天换实现不需要改签名 —— 如果当初写成同步函数，今天必然要回头改 app.js。
 *
 * 🔀 两套数据源，靠地址开关切（Day 8 就留好的口子）：
 *   · 默认            → 调公网接口（数据在云数据库里）
 *   · index.html?src=normal|empty|error  → 用 mock-data.js 的假数据
 *     （演示 / 截图 / 看四种状态用，走的是 MockStore，根本不进本文件）
 *   app.js 里的 usingMock() 负责判断走哪条路 —— 本文件只管"真数据"这条路。
 *
 * 本文件只干两件事：读、写。
 *   不做业务校验（必填项、"结束时间晚于开始时间"由表单层和后端各自负责），
 *   不做排序、不过期判定（那是展示层 app.js 现场算的，见 TECH_DESIGN 第 3 节）。
 * ===================================================================== */

(function () {
  'use strict';

  /* ======================= 接口地址（Day 20） =======================
   *
   * 云端接口的"门牌号"。部署在腾讯云 CloudBase 上。
   *
   * ⚠️ 为什么不写绝对地址，而是"能相对就相对"：
   *   页面本身也部署在云上（静态托管），接口也部署在同一片云上。
   *   用绝对地址意味着**地址写死在代码里**，将来换环境就得改源码。
   *   但这里两者域名不同（tcloudbaseapp.com vs app.tcloudbase.com），
   *   没法用相对路径直接调，所以还是得写全 —— 但只写在这一个地方，
   *   将来要换环境，改下面这一行就够。
   *
   * TODO（本期接受，记在案）：更干净的做法是把地址放一个 api-base.js，
   *   或者用构建时注入。本期只有一套环境，一行常量最省事。 */
  const API_BASE = 'https://my-first-site-d0g3re4p71560e327-1500310885.ap-shanghai.app.tcloudbase.com';

  /* ---------------------- 底层工具（不对外暴露） ---------------------- */

  /* 统一发一个请求，把后端那套"信封"拆开。
     ------------------------------------------------------------------
     后端所有接口都返回同一个形状（见 api-contract.md 第 2.3 节）：
       成功  { ok: true,  data: ...,  requestId: "req_xxx" }
       失败  { ok: false, error: { code, message }, requestId: "req_xxx" }

     为什么要在这里统一拆信封（而不是每个函数各写一遍）：
       8 个接口信封一模一样，抄 8 遍就一定有抄歪的一天。
       集中成一个函数，将来后端换形状只改这里。

     出错时抛出的是 Error，message 是**后端给的中文人话** ——
     app.js 直接把 message 显示在出错状态里，用户看到的不是英文堆栈。 */
  async function callApi(path, options) {
    const opt = options || {};
    let res;
    try {
      res = await fetch(API_BASE + path, {
        method: opt.method || 'GET',
        headers: opt.body
          ? { 'Content-Type': 'application/json' }
          : undefined,
        body: opt.body ? JSON.stringify(opt.body) : undefined,
      });
    } catch (err) {
      // 网络层就挂了：断网、DNS 失败、被墙、网址写错 —— 请求根本没到服务器。
      // 这条和"服务器返回了错误"要分清楚，告诉用户的话也不一样。
      console.error('[store] 请求发不出去', path, err);
      throw new Error('连不上服务器，请检查网络后重试');
    }

    // 后端有可能会返回非 JSON（比如网关的警告页）—— 别让 JSON.parse 直接炸
    let payload = null;
    try {
      payload = await res.json();
    } catch (err) {
      console.error('[store] 返回的不是 JSON', path, res.status);
      throw new Error('服务器返回的内容看不懂（' + res.status + '）');
    }

    // 信封拆开：成功取 data，失败用后端的 message
    if (!payload || payload.ok !== true) {
      const msg = (payload && payload.error && payload.error.message)
        || ('请求失败（' + res.status + '）');
      console.warn('[store] 接口报错', path, res.status, payload && payload.error);
      throw new Error(msg);
    }

    // Day 20 余力加练：记下"这份数据是什么时候从云上取回来的"。
    // 为什么记在这儿（而不是每个 list 函数各记一次）：
    //   所有请求都走这一个出口 —— 在这里记，一处就够，不会漏。
    lastSyncedAt = new Date();

    return payload.data;
  }

  /* 最近一次成功拿到数据的时刻（Date）。取失败时保持不变。
     为什么要暴露这个：页面上要显示"数据同步于 xx:xx"。
     —— 数据从"自己电脑"搬到"云上"之后，"这份是新取的吗"才成了一个问题。 */
  let lastSyncedAt = null;

  function getLastSyncedAt() {
    return lastSyncedAt;
  }

  // 生成唯一标识。不用 crypto.randomUUID()：它在 file:// 打开的页面里可能不存在。
  function newId(prefix) {
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return prefix + '_' + stamp + rand;
  }

  // 当前时间的 ISO 字符串，例如 2026-09-22T20:50:00+08:00
  function nowIso() {
    return new Date().toISOString();
  }

  // 只把「表里有的字段」挑出来，顺带补默认值。防止脏字段混进存储。
  function pick(source, keys) {
    const out = {};
    keys.forEach(function (k) {
      out[k] = source && source[k] !== undefined ? source[k] : '';
    });
    return out;
  }

  /* ---------------------- 课程（course） CRUD ---------------------- */
  // 字段见 PRD 第 4.2 节
  const COURSE_FIELDS = ['name', 'day_of_week', 'start_time', 'end_time', 'location'];

  function buildCourse(input) {
    const picked = pick(input, COURSE_FIELDS);
    const ts = nowIso();
    return {
      id: newId('c'),
      name: String(picked.name || ''),
      day_of_week: Number(picked.day_of_week) || 0,
      start_time: String(picked.start_time || ''),
      end_time: String(picked.end_time || ''),
      location: String(picked.location || ''),
      created_at: ts,
      updated_at: ts
    };
  }

  /* ---------------------- DDL CRUD ---------------------- */
  // 字段见 PRD 第 4.3 节
  const DDL_FIELDS = ['title', 'due_date', 'due_time', 'note'];

  function buildDdl(input) {
    const picked = pick(input, DDL_FIELDS);
    const ts = nowIso();
    return {
      id: newId('d'),
      title: String(picked.title || ''),
      due_date: String(picked.due_date || ''),
      due_time: String(picked.due_time || ''),
      note: String(picked.note || ''),
      done: false,
      created_at: ts,
      updated_at: ts
    };
  }

  /* ---------------------- 对外暴露的 8 个函数 ---------------------- */
  // 取 / 存 / 改 / 删 —— 课程一套、DDL 一套
  //
  // 🔴 Day 20：签名一律不变，只是内部从 localStorage 换成了接口调用。
  //
  // ⚠️ 有一件事要记住：PATCH / DELETE 这 4 个接口**本期还没做**
  //    （契约第 4 节清单里标着"第 4 周"，只实现了 GET 和 POST）。
  //    直调它们会拿到 404。下面的实现**照契约写好了**，
  //    但它们要等后端上线才能真正跑通 —— 现在调用会抛"没有这个接口"。
  //    这是**已知的、故意的**：不假装它能用，也不为了"看起来完整"就偷偷退回 localStorage。

  window.Store = {

    /* 取：课程 */
    listCourses: async function () {
      return callApi('/api/courses');
    },

    /* 存：课程。返回刚建好的整条记录（带 id 和时间戳） */
    createCourse: async function (input) {
      const record = buildCourse(input);
      return callApi('/api/courses', { method: 'POST', body: record });
    },

    /* 改：课程。patch 里传哪些字段就改哪些，id / created_at 不许改 */
    updateCourse: async function (id, patch) {
      const body = Object.assign({}, patch);
      delete body.id;
      delete body.created_at;
      return callApi('/api/courses/' + encodeURIComponent(id), { method: 'PATCH', body: body });
    },

    /* 删：课程 */
    deleteCourse: async function (id) {
      return callApi('/api/courses/' + encodeURIComponent(id), { method: 'DELETE' });
    },

    /* 取：DDL */
    listDdls: async function () {
      return callApi('/api/ddls');
    },

    /* 存：DDL。done 固定从 false 开始 */
    createDdl: async function (input) {
      const record = buildDdl(input);
      return callApi('/api/ddls', { method: 'POST', body: record });
    },

    /* 改：DDL。勾选「已完成」也走这里：updateDdl(id, { done: true }) */
    updateDdl: async function (id, patch) {
      const body = Object.assign({}, patch);
      delete body.id;
      delete body.created_at;
      return callApi('/api/ddls/' + encodeURIComponent(id), { method: 'PATCH', body: body });
    },

    /* 删：DDL */
    deleteDdl: async function (id) {
      return callApi('/api/ddls/' + encodeURIComponent(id), { method: 'DELETE' });
    },

    /* Day 20 余力加练：给页面用 —— "上次成功取数据是什么时候"。
       返回 Date 或 null（还没成功取过）。 */
    getLastSyncedAt: getLastSyncedAt
  };
})();
