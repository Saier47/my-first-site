/* =====================================================================
 * store.js —— 数据读写层
 * ---------------------------------------------------------------------
 * 铁律（TECH_DESIGN 第 2.3 节）：
 *   整个项目只有这个文件可以碰 localStorage。
 *   app.js / index.html 想要数据，只能调这里暴露的函数。
 *
 * 为什么所有函数都写成 async：
 *   Day 23 要把「读 localStorage」换成「调后端接口」。
 *   网络请求天生是异步的 —— 现在就写成 async，将来只重写本文件的内部实现，
 *   函数签名一个字不改，app.js 一行都不用动。
 *   如果现在写成同步函数，Day 23 就必然要回头改 app.js。
 *
 * 本文件只干两件事：读、写。
 *   不做业务校验（必填项、「结束时间晚于开始时间」由表单层负责），
 *   不做排序、不过期判定（那是展示层 app.js 现场算的，见 TECH_DESIGN 第 3 节）。
 *   store.js 越薄越稳 —— 它是全项目改动概率最高的文件。
 * ===================================================================== */

(function () {
  'use strict';

  // 存储键名。加前缀是为了避免和同一个浏览器里别的网页打架。
  const KEY_COURSES = 'mfs:courses';
  const KEY_DDLS = 'mfs:ddls';

  /* ---------------------- 底层工具（不对外暴露） ---------------------- */

  // 读一个列表。读不出来（第一次打开 / 数据被清 / JSON 损坏）一律返回空数组，不抛错。
  function readList(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('[store] 读取失败，按空数据继续：' + key, err);
      return [];
    }
  }

  // 写一个列表。写不进去（超出配额 / 浏览器禁用存储）就抛错，让上层能提示用户。
  function writeList(key, list) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch (err) {
      throw new Error('数据没能保存到本机（浏览器存储不可用或已满）');
    }
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

  window.Store = {

    /* 取：课程 */
    listCourses: async function () {
      return readList(KEY_COURSES);
    },

    /* 存：课程。返回刚建好的整条记录（带 id 和时间戳） */
    createCourse: async function (input) {
      const list = readList(KEY_COURSES);
      const item = buildCourse(input);
      list.push(item);
      writeList(KEY_COURSES, list);
      return item;
    },

    /* 改：课程。patch 里传哪些字段就改哪些，id / created_at 不许改 */
    updateCourse: async function (id, patch) {
      const list = readList(KEY_COURSES);
      let updated = null;
      list.forEach(function (item, i) {
        if (item.id === id) {
          const merged = Object.assign({}, item, patch);
          merged.id = item.id;
          merged.created_at = item.created_at;
          merged.updated_at = nowIso();
          list[i] = merged;
          updated = merged;
        }
      });
      if (!updated) return null;
      writeList(KEY_COURSES, list);
      return updated;
    },

    /* 删：课程 */
    deleteCourse: async function (id) {
      const list = readList(KEY_COURSES);
      const next = list.filter(function (item) { return item.id !== id; });
      if (next.length === list.length) return false;
      writeList(KEY_COURSES, next);
      return true;
    },

    /* 取：DDL */
    listDdls: async function () {
      return readList(KEY_DDLS);
    },

    /* 存：DDL。done 固定从 false 开始 */
    createDdl: async function (input) {
      const list = readList(KEY_DDLS);
      const item = buildDdl(input);
      list.push(item);
      writeList(KEY_DDLS, list);
      return item;
    },

    /* 改：DDL。勾选「已完成」也走这里：updateDdl(id, { done: true }) */
    updateDdl: async function (id, patch) {
      const list = readList(KEY_DDLS);
      let updated = null;
      list.forEach(function (item, i) {
        if (item.id === id) {
          const merged = Object.assign({}, item, patch);
          merged.id = item.id;
          merged.created_at = item.created_at;
          merged.updated_at = nowIso();
          list[i] = merged;
          updated = merged;
        }
      });
      if (!updated) return null;
      writeList(KEY_DDLS, list);
      return updated;
    },

    /* 删：DDL */
    deleteDdl: async function (id) {
      const list = readList(KEY_DDLS);
      const next = list.filter(function (item) { return item.id !== id; });
      if (next.length === list.length) return false;
      writeList(KEY_DDLS, next);
      return true;
    }
  };
})();
