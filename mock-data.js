/* =====================================================================
 * mock-data.js —— Day 8 新增：假数据 + 数据来源开关
 * ---------------------------------------------------------------------
 * 「mock」= 假装的数据。写法是把几条课程和 DDL 直接写在代码里，
 * 不读 localStorage、不连网 —— 打开页面就一定有东西渲染。
 *
 * 为什么 Day 8 要有这个文件（两个理由，都不是为了偷懒）：
 *   1. 真实开发就是这么走的：先用假数据把界面搭出来、调到满意，
 *      最后一步才接真数据。现在没有后端，假数据就是唯一能"稳定
 *      重现"的输入 —— 换台电脑、换个浏览器打开，看到的完全一样。
 *   2. 它顺手解决了状态问题：加载中 / 有数据 / 空 / 出错 四种状态，
 *      靠"换一份假数据"就能逐个看一遍，不用真去等网络、真去制造错误。
 *
 * 怎么切换状态：改下面 DATA_SOURCE 的值，刷新页面。
 *   'normal'  —— 有数据（默认，交截图用这个）
 *   'loading' —— 一直停在加载中（骨架屏）
 *   'empty'   —— 一条数据都没有（空状态引导）
 *   'error'   —— 读取失败（错误状态 + 重试按钮）
 *
 * ⚠️ 时间锚点的坑（踩过才知道）：
 * 假数据里如果写死「2026-09-24」这种绝对日期，过几天再看这周的视图就空了 ——
 * 因为那天已经不在"本周"范围内。所以下面所有日期都是**按运行时的今天现算的**，
 * 相对今天偏移固定在这一次"本周"里。这样不管哪一天打开，都能看到内容。
 * ===================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------
   * 状态开关：改这里，刷新页面就能看不同状态
   * ------------------------------------------------------------- */
  var DATA_SOURCE = 'normal';

  /* ---------------------------------------------------------------
   * 假的「读数」实现 —— 故意留了延迟
   *
   * 为什么要延迟：真实网络请求不会瞬间返回。如果假数据是同步返回的，
   * 「加载中」状态只在屏幕上一闪（0 毫秒），你根本看不见它长什么样，
   * 也就没法验证它做得对不对。留 600 毫秒，是为了让它"看得见"。
   * ------------------------------------------------------------- */

  var FAKE_DELAY_MS = 600;

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ---------------------------------------------------------------
   * 日期工具（和 app.js 里的口径保持一致：一周从周一开始）
   * ------------------------------------------------------------- */

  function startOfWeek(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var wd = x.getDay();                       // 0 = 周日
    x.setDate(x.getDate() + (wd === 0 ? -6 : 1 - wd));
    return x;
  }

  // 相对「本周一」偏移 n 天 → "YYYY-MM-DD"
  function weekDay(n) {
    var d = startOfWeek(new Date());
    d.setDate(d.getDate() + n);
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  /* ---------------------------------------------------------------
   * 假课程：3 门，分别是本周一 / 周三 / 周五
   * 字段和 store.js 里 buildCourse 产出的完全一致，一个不多一个不少
   * ------------------------------------------------------------- */

  function buildCourses() {
    return [
      {
        id: 'c_mock1',
        name: '高等数学',
        day_of_week: 1,
        start_time: '08:00',
        end_time: '09:40',
        location: 'A101',
        created_at: '2026-09-23T09:00:00.000Z',
        updated_at: '2026-09-23T09:00:00.000Z'
      },
      {
        id: 'c_mock2',
        name: '数据结构',
        day_of_week: 3,
        start_time: '10:00',
        end_time: '11:40',
        location: 'B203',
        created_at: '2026-09-23T09:00:00.000Z',
        updated_at: '2026-09-23T09:00:00.000Z'
      },
      {
        id: 'c_mock3',
        name: '大学英语',
        day_of_week: 5,
        start_time: '14:00',
        end_time: '15:40',
        location: 'C305',
        created_at: '2026-09-23T09:00:00.000Z',
        updated_at: '2026-09-23T09:00:00.000Z'
      }
    ];
  }

  /* ---------------------------------------------------------------
   * 假 DDL：3 条，故意覆盖三种典型情况，好让你一次性看清所有状态
   *   ① 本周四到期、还没到  → 正常显示（且要验它"不算过期"）
   *   ② 本周二到期、已过去  → 进「已经过期」区域（验它没消失）
   *   ③ 本周五到期、已勾完成 → 从一周视图移出，只在清单页可见
   * 这三条就是 PRD 第 7.2 节 B4 / B5 和 A8 / A9 要验的东西。
   * ------------------------------------------------------------- */

  function buildDdls() {
    return [
      {
        id: 'd_mock1',
        title: '交数据结构实验报告',
        due_date: weekDay(3),          // 本周四
        due_time: '23:59',
        note: '第 3 章之后的题',
        done: false,
        created_at: '2026-09-23T09:00:00.000Z',
        updated_at: '2026-09-23T09:00:00.000Z'
      },
      {
        id: 'd_mock2',
        title: '提交英语作文初稿',
        due_date: weekDay(1),          // 本周二（已过去 → 过期区）
        due_time: '18:00',
        note: '不少于 300 词',
        done: false,
        created_at: '2026-09-23T09:00:00.000Z',
        updated_at: '2026-09-23T09:00:00.000Z'
      },
      {
        id: 'd_mock3',
        title: '高数作业第三章',
        due_date: weekDay(4),          // 本周五
        due_time: '12:00',
        note: '已写完，等交',
        done: true,
        created_at: '2026-09-23T09:00:00.000Z',
        updated_at: '2026-09-23T09:00:00.000Z'
      }
    ];
  }

  /* ---------------------------------------------------------------
   * 对外的两个函数 —— 名字和签名跟 store.js 的 listCourses / listDdls
   * 完全一样！这不是巧合：app.js 那边只认"给我一个 Promise<数组>"这件事，
   * 至于是从 localStorage 读还是从假数据来，它不关心。
   * 这就是 TECH_DESIGN 2.3 说的「换存储不动调用方」。
   * ------------------------------------------------------------- */

  /* ---------------------------------------------------------------
   * Day 10 修：假数据也要「会记住」
   *
   * 原来的问题是 buildCourses() / buildDdls() 每次都重新生成一份新数组，
   * 所以哪怕你录进去了，下一次读又变回写死的那几条 —— 看起来就像没录上。
   *
   * 现在改成：第一次读的时候把假数据抄进 _mem（内存副本），
   * 之后所有读都读这个副本，写操作也是改这个副本。
   * 效果就和真 store 一样：改了会留下，直到刷新页面（mock 不需要持久化）。
   * ------------------------------------------------------------- */

  var _mem = null;   // { courses: [...], ddls: [...] }，第一次读时惰性初始化

  function mem() {
    /* ⚠️ 判断口径必须和 app.js 的 mockSource() 一致 —— 读 MockStore.source，
       而不是读闭包里的 DATA_SOURCE。
       原因：DATA_SOURCE 只在加载时定一次，外部改不了；而测试（还有页面上的
       重试按钮那类场景）是通过改 MockStore.source 来临时切状态的。
       两边不同步的话，会出现"source 明明改成 normal 了，读出来还是空"。
       另：只给 'normal' 做缓存，其他状态每次都现算（见 Day 10 的教训）。 */
    var src = window.MockStore.source;
    if (src !== 'normal') return { courses: [], ddls: [] };
    if (!_mem) {
      _mem = { courses: buildCourses(), ddls: buildDdls() };
    }
    return _mem;
  }

  // 生成一个自增 id，避免和假数据里写死的 id 撞车
  var _seq = 0;
  function nextId(prefix) {
    _seq += 1;
    return prefix + '_new' + _seq + '_' + Date.now();
  }

  // 和 store.js 里的时间戳口径保持一致
  function nowIso() {
    return new Date().toISOString();
  }

  window.MockStore = {
    source: DATA_SOURCE,

    listCourses: async function () {
      await delay(FAKE_DELAY_MS);
      return mem().courses.slice();
    },

    listDdls: async function () {
      await delay(FAKE_DELAY_MS);
      return mem().ddls.slice();
    },

    /* ---- 写操作（Day 10 新增）：签名与 store.js 完全一致 ---- */

    createCourse: async function (input) {
      await delay(FAKE_DELAY_MS);
      var rec = {
        id: nextId('c'),
        name: input.name,
        day_of_week: input.day_of_week,
        start_time: input.start_time,
        end_time: input.end_time,
        location: input.location || '',
        created_at: nowIso(),
        updated_at: nowIso()
      };
      mem().courses.push(rec);
      return rec;
    },

    updateCourse: async function (id, patch) {
      await delay(FAKE_DELAY_MS);
      var list = mem().courses;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) list[i][k] = patch[k];
          list[i].updated_at = nowIso();
          return list[i];
        }
      }
      return null;
    },

    deleteCourse: async function (id) {
      await delay(FAKE_DELAY_MS);
      var list = mem().courses;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { list.splice(i, 1); return true; }
      }
      return false;
    },

    createDdl: async function (input) {
      await delay(FAKE_DELAY_MS);
      var rec = {
        id: nextId('d'),
        title: input.title,
        due_date: input.due_date,
        due_time: input.due_time,
        note: input.note || '',
        done: false,
        created_at: nowIso(),
        updated_at: nowIso()
      };
      mem().ddls.push(rec);
      return rec;
    },

    updateDdl: async function (id, patch) {
      await delay(FAKE_DELAY_MS);
      var list = mem().ddls;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) list[i][k] = patch[k];
          list[i].updated_at = nowIso();
          return list[i];
        }
      }
      return null;
    },

    deleteDdl: async function (id) {
      await delay(FAKE_DELAY_MS);
      var list = mem().ddls;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { list.splice(i, 1); return true; }
      }
      return false;
    }
  };
})();
