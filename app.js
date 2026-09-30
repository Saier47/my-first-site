/* =====================================================================
 * app.js —— 视图层
 * ---------------------------------------------------------------------
 * 本文件（第一部分）：渲染一周视图（F1）
 *
 * 两条规则：
 *   1. 本文件不许碰 localStorage —— 要数据一律走 Store（store.js）。
 *   2. Store 的函数都是 async，所以这边调用要 await。
 *
 * 本文件负责「把数据翻译成画面」：
 *   取本周（周一~周日）→ 课程按星期排进去 → DDL 按截止时刻排进去
 *   → 叠在同一天里按时间先后排 → 挂到页面上
 * 「过期」的判定口径见 PRD F1：due_date + due_time 拼成完整截止时刻，
 * 当前时刻晚于它才算过期；勾了「已完成」的永远不算过期。
 *
 * ===== Day 8 追加：四种页面状态 =====
 * 一个页面只要去「拿数据」，就必然有四种状态，它们是并列的、都得做：
 *
 *   ① 加载中（loading）—— 数据还没回来。要给骨架屏，不能白屏。
 *   ② 有数据（ready）  —— 正常渲染。这是唯一会被截图的一种。
 *   ③ 空（empty）      —— 请求成功，但一条数据都没有。
 *                        这是最容易被忽略的一种：它长得跟正常页面几乎一样，
 *                        只是列表是空的。而新用户第一次打开看到的就是它。
 *   ④ 出错（error）    —— 拿数据失败了。要告诉用户发生了什么 + 给条出路（重试）。
 *
 * 为什么现在就要做：本期数据从 localStorage 读，几乎不会失败，所以这四种状态
 * 看不出必要性。但 Day 23 接数据库之后，网络会超时、服务器会挂，③ 和 ④ 会变成
 * 每天都会发生的事。现在把位置留好，那时候只换数据源，界面不用重写。
 *
 * 现在怎么验证这四种状态：改 mock-data.js 顶部的 DATA_SOURCE，刷新页面。
 * ===================================================================== */

(function () {
  'use strict';

  const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  /* ======================= 数据来源开关（Day 8） ======================= */

  /* 用真数据还是假数据，由 index.html 里的注释开关决定（见文件末尾说明）。
     判断口径：mock-data.js 加载了、且它的开关不是 'off'，就用假数据。
     这样切回真数据只要改一处，app.js 一个字不用动。 */
  function usingMock() {
    return !!(window.MockStore && window.MockStore.source && window.MockStore.source !== 'off');
  }

  function mockSource() {
    return (window.MockStore && window.MockStore.source) || 'normal';
  }

  /* 统一的「拿数据」入口。以后不管接多少个数据源，都只改这一个函数。
     返回 { courses, ddls } —— 取不到就抛错，由 render 统一接住。

     ⚠️ 这里用 Promise.all 并发取，不要写成两次 await 串行：
       串行 = 600ms + 600ms = 1200ms；并发 = max(600, 600) = 600ms。
       本期数据在本地看不出差别，Day 23 换成网络请求后，
       串行会让首屏等待时间直接翻倍 —— 这个坑现在不踩，是因为现在就能改。 */
  async function loadData() {
    if (usingMock()) {
      const [courses, ddls] = await Promise.all([MockStore.listCourses(), MockStore.listDdls()]);
      return { courses: courses, ddls: ddls };
    }
    const [courses, ddls] = await Promise.all([Store.listCourses(), Store.listDdls()]);
    return { courses: courses, ddls: ddls };
  }

  /* Day 10 修：读、写必须走同一个源。
     ------------------------------------------------------------------
     原来这里（loadData）判断了"用假数据还是真数据"，但写操作
     （createCourse / createDdl / updateDdl / deleteDdl / deleteCourse）
     一律直写 window.Store，从来不判断。

     后果：开着假数据时，页面显示的是 MockStore 写死的假数据，
     而你录进去的东西进了 store.js 的 localStorage。
     下次 render() 又从 MockStore 读回那批写死的假数据 ——
     于是"录了看不见、勾了不生效、删了没反应"，而且全程不报错。

     现在统一成：读、写都问 dataSource()，就不会再各走各的。 */
  function dataSource() {
    return usingMock() ? MockStore : Store;
  }

  /* ======================= 日期工具 ======================= */

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // 本周一的 00:00（一周以周一为起点，PRD F1）
  function startOfWeek(d) {
    const x = startOfDay(d);
    const wd = x.getDay();                  // 0 = 周日，1 = 周一 …
    const offset = wd === 0 ? -6 : 1 - wd;  // 把周一挪到第 0 天
    x.setDate(x.getDate() + offset);
    return x;
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  // "YYYY-MM-DD"，用来和 due_date 比对
  function ymd(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  // "9/22"
  function md(d) {
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /* Day 13：今天是一周里的第几天 —— 1=周一 … 7=周日。
     和课程表 day_of_week 用同一个口径，否则"今天有哪节课"会错一天。
     （getDay() 是 0=周日…6=周六，所以周日要单独掰成 7） */
  function weekdayOf(d) {
    const g = d.getDay();
    return g === 0 ? 7 : g;
  }

  // 把 due_date + due_time 拼成一个完整的截止时刻（PRD F1 写死的口径）
  function deadlineOf(ddl) {
    return new Date(ddl.due_date + 'T' + (ddl.due_time || '00:00') + ':00');
  }

  function isOverdue(ddl, now) {
    if (ddl.done) return false;             // 已完成的不算「漏掉的」，不进过期区
    const t = deadlineOf(ddl);
    if (isNaN(t.getTime())) return false;   // 时间不合法就当没过期，别让脏数据把页面搞炸
    return t.getTime() < now.getTime();
  }

  function byDeadline(a, b) {
    return deadlineOf(a) - deadlineOf(b);
  }

  /* ======================= 小工具 ======================= */

  // 用户填的东西要转义再拼进 HTML —— 否则填个 <script> 就能在页面里搞事
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(id) {
    return document.getElementById(id);
  }

  /* ======================= 状态骨架（Day 8 新增） ======================= */

  /* ① 加载中：骨架屏。
     为什么用骨架屏而不是一个转圈图标：骨架屏把"马上要出现什么东西"提前画出来，
     视觉上不跳；转圈会让整页内容在数据到达时突然位移。这是业界现在的通行做法。 */
  function skeletonHtml() {
    let html = '<div class="skeleton-wrap">';
    for (let i = 0; i < 7; i++) {
      html += '<div class="sk-day">' +
        '<div class="sk-bar sk-head"></div>' +
        '<div class="sk-bar sk-card"></div>' +
        '<div class="sk-bar sk-card sk-short"></div>' +
        '</div>';
    }
    return html + '</div>';
  }

  /* 清单页 / 今天视图的骨架形态：纵向几行，和它们实际的"一条一条"对上。
     形态要跟着布局走 —— 把一个 7 列网格的骨架塞进清单页会很怪。
     （复用 .sk-bar 的渐变与动画，只换尺寸） */
  function skeletonRowsHtml(rows) {
    let html = '<div class="skeleton-rows">';
    for (let i = 0; i < rows; i++) {
      html += '<div class="sk-bar sk-row"></div>';
    }
    return html + '</div>';
  }

  /* ④ 出错：说清楚"出了什么事" + 给一条出路（重试）。
     只写一句"加载失败"是不合格的 —— 用户不知道该干嘛。 */
  function errorHtml(message) {
    return '<div class="state-box state-error">' +
      '<p class="state-title">没能读到数据</p>' +
      '<p class="state-sub">' + esc(message || '数据读取失败了。') + '</p>' +
      '<button type="button" class="btn-primary" data-action="retry">重试一次</button>' +
      '</div>';
  }

  /* ---- 四种状态的渲染（Day 13 重写）----

     关键认识：「加载中」和「出错」是**全视图**的状态 —— 数据还没到手时，
     切到哪个视图看到的都该是同一个"在等"的样子，
     而不是"一周视图在转圈、清单页一片空白"。
     （「有数据」和「空」由各视图自己的渲染函数负责，不在这里。） */

  // 清单页：状态位和正常内容整块互换，避免"筛选框还在、列表却是骨架"的中间态
  function setCoursesState(html) {
    const stateBox = el('courses-state');
    const normal = el('courses-normal');
    if (stateBox) {
      stateBox.innerHTML = html || '';
      stateBox.hidden = !html;
    }
    if (normal) normal.hidden = !!html;
  }

  function renderLoadingState() {
    const week = el('week-list');
    if (week) week.innerHTML = skeletonHtml();          // 一周视图是 7 列
    const zone = el('overdue-zone');
    if (zone) zone.hidden = true;                        // 别一半有内容一半是骨架

    setCoursesState(skeletonRowsHtml(4));                // 清单页是纵向几行

    const today = el('today-body');
    if (today) today.innerHTML = skeletonRowsHtml(3);
  }

  function renderErrorState(message) {
    const html = errorHtml(message);

    const week = el('week-list');
    if (week) week.innerHTML = html;
    const zone = el('overdue-zone');
    if (zone) zone.hidden = true;

    setCoursesState(html);

    const today = el('today-body');
    if (today) today.innerHTML = html;
  }

  /* ======================= 渲染：本周范围 ======================= */

  function renderRange(now) {
    const a = startOfWeek(now);
    const b = addDays(a, 6);
    const node = el('week-range');
    if (node) node.textContent = md(a) + ' – ' + md(b);
  }

  /* ======================= 渲染：过期区域（置顶） ======================= */

  // 逾期条目的 HTML —— 一周视图和今天视图共用，免得两处各写一遍、日后走岔
  function overdueHtml(list) {
    return list.map(function (d) {
      return '<div class="over-item">' +
        '<span class="over-when">' + esc(d.due_date + ' ' + d.due_time) + '</span>' +
        '<span class="over-title">' + esc(d.title) + '</span>' +
        (d.note ? '<span class="over-note">' + esc(d.note) + '</span>' : '') +
        '</div>';
    }).join('');
  }

  function renderOverdue(overdue) {
    const zone = el('overdue-zone');
    const box = el('overdue-list');
    if (!zone || !box) return;

    if (overdue.length === 0) {
      zone.hidden = true;   // 没有过期项就整块藏起来，不留空标题
      box.innerHTML = '';
      return;
    }

    zone.hidden = false;
    box.innerHTML = overdueHtml(overdue);
  }

  /* ======================= 渲染：一天里的一条 ======================= */

  function renderItem(it) {
    const d = it.data;

    if (it.kind === 'course') {
      const time = esc(d.start_time) + (d.end_time ? '–' + esc(d.end_time) : '');
      return '<li class="item item-course">' +
        '<span class="item-time">' + time + '</span>' +
        '<span class="item-name">' + esc(d.name) + '</span>' +
        (d.location ? '<span class="item-loc">' + esc(d.location) + '</span>' : '') +
        '</li>';
    }

    return '<li class="item item-ddl">' +
      '<span class="item-time">' + esc(d.due_time) + ' 截止</span>' +
      '<span class="item-name">' + esc(d.title) + '</span>' +
      '<span class="item-tag">DDL</span>' +
      '</li>';
  }

  /* ======================= 渲染：一周 7 天 ======================= */

  function renderWeek(courses, ddls, now) {
    const box = el('week-list');
    if (!box) return;

    // ③ 空状态（边界：一条数据都没有）→ 给引导语 + 一个添加按钮，不能是白屏（PRD B1）
    // 注意：空状态是「加载成功了，只是没数据」，和「加载中」是两码事，别混。
    if (courses.length === 0 && ddls.length === 0) {
      box.innerHTML =
        '<div class="empty-guide">' +
          '<p class="empty-title">这一周还是空的</p>' +
          '<p class="empty-sub">把你每周固定的课、还有老师刚说的 DDL 录进来 ——<br>录完之后，打开就能一眼看完这周。</p>' +
          '<button type="button" class="btn-primary" data-action="add">+ 添加第一条</button>' +
        '</div>';
      return;
    }

    const weekStart = startOfWeek(now);
    const todayKey = ymd(startOfDay(now));
    let html = '';

    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i);
      const key = ymd(day);
      const isToday = key === todayKey;

      // 这一天要显示的东西：课程 + 本周到期的未完成 DDL，混在一起按时间排
      const items = [];

      courses.forEach(function (c) {
        if (Number(c.day_of_week) === i + 1) {   // 课程每周重复，每周都来
          items.push({ time: c.start_time, kind: 'course', data: c });
        }
      });

      ddls.forEach(function (d) {
        if (d.done) return;                                          // 已完成 → 移出一周视图（PRD F3）
        if (isOverdue(d, now)) return;                               // 已过期 → 在顶部区域，这里不重复
        if (d.due_date === key) {
          items.push({ time: d.due_time, kind: 'ddl', data: d });
        }
      });

      items.sort(function (a, b) {
        return String(a.time).localeCompare(String(b.time));
      });

      html += '<div class="day' + (isToday ? ' is-today' : '') + '">';

      // Day 13：「今天」那一列的列头**整块可点** —— 点它就下钻到「今天」视图（二级）。
      // 用 <a href="#/today">：浏览器自己会改地址、触发路由，不用额外绑事件。
      // 整块做成链接（而不是加一个小按钮）是为了点击区域够大 —— Day 9 学过的触达尺寸。
      const headInner =
        '<span class="day-name">' + DAY_NAMES[i] + '</span>' +
        (isToday ? '<span class="day-tag">今天</span>' : '') +
        '<span class="day-date">' + md(day) + '</span>' +
        (isToday ? '<span class="day-go" aria-hidden="true">&#8250;</span>' : '');

      html += isToday
        ? '<a class="day-head day-head-link" href="#/today" aria-label="查看今天这一天的安排">' +
            headInner + '</a>'
        : '<div class="day-head">' + headInner + '</div>';

      if (items.length === 0) {
        html += '<p class="day-empty">没有安排</p>';
      } else {
        html += '<ul class="items">';
        items.forEach(function (it) { html += renderItem(it); });
        html += '</ul>';
      }

      html += '</div>';
    }

    box.innerHTML = html;
  }

  /* ======================= 渲染：今天视图（Day 13 · 二级） =======================

     今天是「聚焦」的一屏：只回答一个问题 —— 今天我要面对什么？
     内容全部由现有数据派生（课程按 day_of_week 匹配今天、DDL 按 due_date 匹配今天），
     **不新增任何数据**。 */

  function renderToday(courses, ddls, now) {
    const box = el('today-body');
    if (!box) return;

    const todayKey = ymd(startOfDay(now));
    const dow = weekdayOf(now);

    const todaysCourses = courses.filter(function (c) {
      return Number(c.day_of_week) === dow;      // 课程每周重复，只看"今天是周几"
    }).sort(function (a, b) {
      return String(a.start_time).localeCompare(String(b.start_time));
    });

    const dueToday = ddls.filter(function (d) {
      return !d.done && d.due_date === todayKey;
    }).sort(byDeadline);

    const overdue = ddls.filter(function (d) {
      return isOverdue(d, now);
    }).sort(byDeadline);

    const todayCount = todaysCourses.length + dueToday.length;

    // 头部：先给结论（今天几节课几个 DDL），再给细节
    let html = '<div class="today-head">' +
      '<p class="today-date">' + DAY_NAMES[dow - 1] + ' · ' + md(now) + '</p>' +
      '<p class="today-sum">' + (
        todayCount === 0
          ? '今天没有课，也没有到期的 DDL'
          : '今天 ' + todaysCourses.length + ' 节课 · ' + dueToday.length + ' 个 DDL 到期'
      ) + '</p>' +
      '</div>';

    // ③ 空状态：今天真的一件都没有。（边界：这和"加载中"是两回事，别混）
    if (todayCount === 0 && overdue.length === 0) {
      html += '<div class="empty-guide">' +
        '<p class="empty-title">今天很干净</p>' +
        '<p class="empty-sub">没有课，也没有到期的 DDL。<br>要不要提前看看这一周还剩什么？</p>' +
        '<a class="btn-primary btn-as-link" href="#/week">看看这一周</a>' +
        '</div>';
      box.innerHTML = html;
      return;
    }

    html += '<section class="zone">' +
      '<h2 class="zone-title">今天的课</h2>' +
      (todaysCourses.length === 0
        ? '<p class="day-empty">今天没课</p>'
        : '<ul class="items">' + todaysCourses.map(function (c) {
            return renderItem({ time: c.start_time, kind: 'course', data: c });
          }).join('') + '</ul>') +
      '</section>';

    html += '<section class="zone">' +
      '<h2 class="zone-title">今天到期</h2>' +
      (dueToday.length === 0
        ? '<p class="day-empty">今天没有 DDL 到期</p>'
        : '<ul class="items">' + dueToday.map(function (d) {
            return renderItem({ time: d.due_time, kind: 'ddl', data: d });
          }).join('') + '</ul>') +
      '</section>';

    // 欠账：过期还没打勾的。放最后 —— 它是"提醒"，不是"今天的事"。
    if (overdue.length > 0) {
      html += '<section class="zone">' +
        '<h2 class="zone-title">还没做的（已经过期）</h2>' +
        overdueHtml(overdue) +
        '</section>';
    }

    box.innerHTML = html;
  }

  /* ======================= 渲染：清单页（课程 + DDL） ======================= */

  function renderCourseList(courses) {
    const box = el('course-list');
    if (!box) return;

    if (courses.length === 0) {
      box.innerHTML = '<p class="list-empty">还没有课程。点上面的「+ 课程」，把这一学期的课录进来 —— 录一次，之后每周都会出现。</p>';
      return;
    }

    // 按星期分组。day_of_week 不在 1~7 的（脏数据）单独兜一组，
    // 免得它在一周视图和列表里都看不见、用户想删都删不掉。
    const groups = {};
    courses.forEach(function (c) {
      const d = Number(c.day_of_week);
      const key = (d >= 1 && d <= 7) ? String(d) : 'other';
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    });

    let html = '';
    ['1', '2', '3', '4', '5', '6', '7', 'other'].forEach(function (key) {
      const group = groups[key];
      if (!group || group.length === 0) return;

      group.sort(function (a, b) {
        return String(a.start_time).localeCompare(String(b.start_time));
      });

      html += '<h3 class="row-group-title">' +
        (key === 'other' ? '未分组' : DAY_NAMES[Number(key) - 1]) + '</h3>';

      group.forEach(function (c) {
        html += '<div class="row">' +
          '<span class="row-main">' +
            '<span class="row-title">' + esc(c.name) + '</span>' +
            '<span class="row-meta">' + esc(c.start_time) + '–' + esc(c.end_time) +
              (c.location ? ' · ' + esc(c.location) : '') +
            '</span>' +
          '</span>' +
          '<button type="button" class="btn-icon" data-action="edit" data-kind="course" data-id="' + esc(c.id) + '">编辑</button>' +
          '<button type="button" class="btn-icon danger" data-action="delete" data-kind="course" data-id="' + esc(c.id) + '">删除</button>' +
          '</div>';
      });
    });

    box.innerHTML = html;
  }

  function renderDdlList(ddls, now) {
    const box = el('ddl-list');
    if (!box) return;

    if (ddls.length === 0) {
      box.innerHTML = '<p class="list-empty">还没有 DDL。老师刚说完，就点「+ DDL」记下来。</p>';
      return;
    }

    // 按截止时刻从近到远（PRD F3）
    const sorted = ddls.slice().sort(byDeadline);

    box.innerHTML = sorted.map(function (d) {
      const overdue = isOverdue(d, now);
      return '<div class="row' + (d.done ? ' is-done' : '') + '">' +
        '<input type="checkbox" class="row-check" data-action="toggle-done" data-id="' + esc(d.id) + '"' +
          (d.done ? ' checked' : '') + ' aria-label="标记为已完成" />' +
        '<span class="row-main">' +
          '<span class="row-title">' + esc(d.title) + '</span>' +
          '<span class="row-meta">' + esc(d.due_date) + ' ' + esc(d.due_time) +
            (overdue ? ' · 已过期' : '') +
            (d.note ? ' · ' + esc(d.note) : '') +
          '</span>' +
        '</span>' +
        '<button type="button" class="btn-icon" data-action="edit" data-kind="ddl" data-id="' + esc(d.id) + '">编辑</button>' +
        '<button type="button" class="btn-icon danger" data-action="delete" data-kind="ddl" data-id="' + esc(d.id) + '">删除</button>' +
        '</div>';
    }).join('');
  }

  /* ======================= Day 12：清单页筛选 ======================= */

  // 筛选词。空字符串 = 不筛（全部显示）
  let filterQuery = '';

  // 最近一次读到的数据。筛选用它，避免每敲一个字都重新读盘（读盘要 600ms）。
  // 每次 render() 拿到新数据都会刷新它。
  let currentData = null;

  // 归一化：去空格 + 转小写。中英文都受得住（中文没有大小写，但英文有）
  function normalize(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  // ⚠️ 这里是「派生视图」，不是「原地过滤」——
  // 绝不写 all = all.filter(...)，否则清空搜索框后数据回不来。
  function matchCourse(c, q) {
    return normalize(c.name).indexOf(q) !== -1
      || normalize(c.location).indexOf(q) !== -1;
  }

  function matchDdl(d, q) {
    return normalize(d.title).indexOf(q) !== -1
      || normalize(d.note).indexOf(q) !== -1;
  }

  // 无结果时那句话。必须带上用户搜的词 —— 证明系统读懂了输入，
  // 也让用户一眼看出"是我搜的词不对"，而不是"页面坏了"。
  function filterNoneHtml(q) {
    return '<p class="filter-none">没找到和 <strong>' + esc(q) + '</strong> 有关的课程或 DDL。' +
      '<br>换个关键词试试，或者点上面的「清空」看全部。</p>';
  }

  // 更新计数提示与「清空」按钮的可见性
  function renderFilterMeta(shownCourses, shownDdls) {
    const countBox = el('filter-count');
    const clearBtn = el('filter-clear');
    const q = normalize(filterQuery);

    if (clearBtn) clearBtn.hidden = q === '';
    if (!countBox) return;

    if (q === '') {
      countBox.textContent = '';
      countBox.classList.remove('is-active');
      return;
    }
    const total = shownCourses + shownDdls;
    countBox.textContent = total === 0
      ? '筛选：0 条结果'
      : '筛选：' + total + ' 条结果（课程 ' + shownCourses + ' · DDL ' + shownDdls + '）';
    countBox.classList.add('is-active');
  }

  /* ======================= 弹层与表单 ======================= */

  let editing = null;     // 编辑中的记录 { kind, id }，新建时为 null
  let currentView = 'week';

  function showError(kind, msg) {
    const node = el('err-' + kind);
    if (!node) return;
    if (msg) { node.textContent = msg; node.hidden = false; }
    else { node.textContent = ''; node.hidden = true; }
  }

  function fillForm(kind, data) {
    if (kind === 'course') {
      el('c-name').value = data ? data.name : '';
      el('c-day').value = data ? String(data.day_of_week) : '';
      el('c-start').value = data ? data.start_time : '';
      el('c-end').value = data ? data.end_time : '';
      el('c-location').value = data ? data.location : '';
    } else {
      el('d-title').value = data ? data.title : '';
      el('d-date').value = data ? data.due_date : '';
      el('d-time').value = data ? data.due_time : '';
      el('d-note').value = data ? data.note : '';
    }
  }

  // record 传空 = 新建；传记录 = 编辑（表单带出原值，PRD F2 输出）
  function openModal(kind, record) {
    editing = record ? { kind: kind, id: record.id } : null;
    // DDL 前面留一个空格：中文和英文数字之间空一格更好读
    const name = kind === 'course' ? '课程' : ' DDL';
    const title = el('modal-title');
    if (title) title.textContent = (record ? '编辑' : '添加') + name;

    const fc = el('form-course'), fd = el('form-ddl');
    if (fc) fc.hidden = kind !== 'course';
    if (fd) fd.hidden = kind !== 'ddl';

    showError('course', null);
    showError('ddl', null);
    // Day 11：每次打开都把按钮恢复成可点状态 ——
    // 万一上次保存中途出了岔子，不能让人对着一个"保存中…"发呆
    setFormBusy(el('form-course'), false);
    setFormBusy(el('form-ddl'), false);
    fillForm(kind, record || null);

    const modal = el('modal');
    if (modal) modal.hidden = false;

    const focus = kind === 'course' ? el('c-name') : el('d-title');
    if (focus && focus.focus) focus.focus();
  }

  function closeModal() {
    const modal = el('modal');
    if (modal) modal.hidden = true;
    editing = null;
  }

  /* ======================= 保存反馈（Day 11） ======================= */

  /* 顶部提示条：保存成功后明确说一句「已保存」。
     为什么需要它：弹层关闭只说明"界面变了"，不说明"你的事办成了"。
     用户需要一句人话确认，否则会怀疑自己刚才是不是白填了。

     连续两次保存时，后一次要重置计时器 —— 不然第一次的 2.4 秒倒计时
     会把第二次的提示提前掐断（连续操作测试里会碰到）。 */
  let toastTimer = null;
  function showToast(text) {
    const box = el('toast');
    const txt = el('toast-text');
    if (!box || !txt) return;
    txt.textContent = text;
    box.hidden = false;
    // 强制一次重排：hidden 刚摘掉时直接加类，过渡可能不触发
    if (box.offsetWidth === 0) { /* 读一下强制 reflow */ }
    box.classList.add('is-on');

    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      box.classList.remove('is-on');
      // 等淡出动画走完再真正隐藏，否则元素会"啪"一下消失
      toastTimer = window.setTimeout(function () {
        box.hidden = true;
        box.classList.remove('is-on');
        toastTimer = null;
      }, 220);
    }, 2400);
  }

  /* 把某个表单的提交按钮切成「保存中」或恢复。
     这是防连点的硬机制 —— 没有它，用户在第 300ms 再点一次就会存两条。 */
  function setFormBusy(form, busy) {
    if (!form) return;
    const btn = form.querySelector('button[type="submit"]');
    if (!btn) return;
    if (busy) {
      if (!btn.getAttribute('data-idle-text')) {
        btn.setAttribute('data-idle-text', btn.textContent);
      }
      btn.classList.add('is-busy');
      btn.disabled = true;
      btn.textContent = '保存中…';
    } else {
      btn.classList.remove('is-busy');
      btn.disabled = false;
      const idle = btn.getAttribute('data-idle-text');
      if (idle) btn.textContent = idle;
    }
  }

  /* 一次性收口：禁用 → 保存 → 提示 → 关闭 → 重渲染。
     课程和 DDL 两个表单走同一套，避免两边行为跑偏。

     ⚠️ 为什么除了 disabled 还要一个 saving 锁（Day 11 踩出来的）：
     `btn.disabled = true` 只挡得住"人手点"，挡不住
     `form.dispatchEvent(new Event('submit'))` 这种程序化提交，
     也挡不住某些浏览器的回车提交路径。
     实测：连发 10 次 submit（不等）→ 存进 10 条重复课程。
     所以真正防连点要两层：
       ① disabled  —— 给用户看的（点了没反应，且视觉上知道在忙）
       ② saving 锁 —— 给代码用的（函数入口直接拦截，不看 DOM 状态）
     这个锁在 finally 里释放，保证出错也能解锁。 */
  let saving = false;
  async function saveWithFeedback(form, kind, data, successText) {
    if (saving) return false;          // 上一次还没完成，直接无视
    saving = true;
    setFormBusy(form, true);
    try {
      if (editing) {
        if (kind === 'course') await dataSource().updateCourse(editing.id, data);
        else await dataSource().updateDdl(editing.id, data);
      } else {
        if (kind === 'course') await dataSource().createCourse(data);
        else await dataSource().createDdl(data);
      }
      closeModal();
      await render();
      showToast(successText);
      return true;
    } catch (e) {
      // 存不进去时：恢复按钮 + 说清原因，别让用户对着一个"保存中…"干等
      showError(kind, '保存失败：' + ((e && e.message) || '未知错误'));
      return false;
    } finally {
      // 成功和失败都要恢复按钮 —— 原来只在 catch 里恢复，
      // 成功的分支直接 return 了，按钮就永远卡在「保存中…」。
      setFormBusy(form, false);
      saving = false;
    }
  }

  /* ======================= 校验（PRD F2 / F3） ======================= */

  function validateCourse(data) {
    if (!data.name) return '请填课程名';
    if (!data.day_of_week) return '请选星期几';
    if (!data.start_time) return '请填开始时间';
    if (!data.end_time) return '请填结束时间';
    if (data.end_time <= data.start_time) return '结束时间要晚于开始时间';
    return null;
  }

  function validateDdl(data) {
    if (!data.title) return '请填事项名称';
    if (!data.due_date) return '请选截止日期';
    if (!data.due_time) return '请填截止时间';
    return null;
  }

  /* ======================= 保存 ======================= */

  async function submitCourse(event) {
    if (event && event.preventDefault) event.preventDefault();

    const data = {
      name: el('c-name').value.trim(),
      day_of_week: Number(el('c-day').value) || 0,
      start_time: el('c-start').value,
      end_time: el('c-end').value,
      location: el('c-location').value.trim()
    };

    const err = validateCourse(data);
    if (err) { showError('course', err); return; }   // 存不进去 + 有提示（A4 / A5）

    showError('course', null);
    // Day 11：禁用按钮 → 保存 → 顶部提示「已保存」→ 关闭弹层 → 重渲染
    await saveWithFeedback(
      el('form-course'), 'course', data,
      editing ? '已更新：' + data.name : '已保存：' + data.name
    );
  }

  async function submitDdl(event) {
    if (event && event.preventDefault) event.preventDefault();

    const data = {
      title: el('d-title').value.trim(),
      due_date: el('d-date').value,
      due_time: el('d-time').value,
      note: el('d-note').value.trim()
    };

    const err = validateDdl(data);
    if (err) { showError('ddl', err); return; }

    // 边界（PRD F3）：截止时间已经过去 → 允许保存，但先提示
    const deadline = deadlineOf(data);
    if (!isNaN(deadline.getTime()) && deadline.getTime() < Date.now()) {
      if (!window.confirm('这条 DDL 的截止时间已经过去了。仍然保存吗？')) return;
    }

    showError('ddl', null);
    // Day 11：与课程共用同一套保存反馈
    await saveWithFeedback(
      el('form-ddl'), 'ddl', data,
      editing ? '已更新：' + data.title : '已保存：' + data.title
    );
  }

  /* ======================= 删除 / 勾选完成 ======================= */

  async function openEdit(kind, id) {
    const S = dataSource();
    const all = kind === 'course' ? await S.listCourses() : await S.listDdls();
    const rec = all.filter(function (x) { return x.id === id; })[0];
    if (rec) openModal(kind, rec);
  }

  async function removeRecord(kind, id) {
    const isCourse = kind === 'course';
    const S = dataSource();
    const all = isCourse ? await S.listCourses() : await S.listDdls();
    const target = all.filter(function (x) { return x.id === id; })[0];
    if (!target) return;

    const name = isCourse ? target.name : target.title;
    // A7：删除前先弹一次确认；点「取消」什么都不做
    if (!window.confirm('确定删除「' + name + '」吗？删除后不能恢复。')) return;

    if (isCourse) await S.deleteCourse(id);
    else await S.deleteDdl(id);
    await render();
  }

  async function toggleDone(id, checked) {
    await dataSource().updateDdl(id, { done: checked });
    await render();
  }

  /* ======================= Day 13：hash 路由 =======================

     为什么用 hash（地址里 # 后面那一段），而不是 History API：
       1. 改 hash **不会让浏览器重新请求页面** —— 纯前端就能用，不需要服务器配合
       2. 双击打开的 file:// 也照样可用（History API 在 file:// 下会被限制）
       3. hash 会被记进历史 —— 所以后退键能用、刷新能回到原处、链接能直接分享
     "够用就好"：不引任何路由库，就下面这几个函数。

     层级：一级 = week / courses（底部导航）；二级 = today（从一周视图点进去）。
     today 的 parent 设成 week —— 这样停在今天视图时，底部「一周视图」仍保持高亮，
     用户能看出"我还在这个分支里"，而不是两个 tab 都不亮。 */

  const ROUTES = {
    week:    { el: 'view-week' },
    courses: { el: 'view-courses' },
    today:   { el: 'view-today', parent: 'week' }
  };

  const DEFAULT_VIEW = 'week';

  // '#/courses?q=高数' → { view: 'courses', params: { q: '高数' } }
  // 地址不认识时一律回默认视图 —— 手输错地址不该变成白屏。
  function parseHash() {
    const raw = String(location.hash || '').replace(/^#\/?/, '');
    const qi = raw.indexOf('?');
    const path = qi === -1 ? raw : raw.slice(0, qi);
    const qs = qi === -1 ? '' : raw.slice(qi + 1);

    const known = Object.prototype.hasOwnProperty.call(ROUTES, path);
    const params = {};
    if (qs) {
      qs.split('&').forEach(function (pair) {
        if (!pair) return;
        const eq = pair.indexOf('=');
        const k = eq === -1 ? pair : pair.slice(0, eq);
        const v = eq === -1 ? '' : pair.slice(eq + 1);
        try { params[decodeURIComponent(k)] = decodeURIComponent(v); }
        catch (e) { params[k] = v; }
      });
    }
    return { view: known ? path : DEFAULT_VIEW, params: params };
  }

  function hashFor(view, params) {
    let h = '#/' + view;
    const parts = [];
    if (params) {
      Object.keys(params).forEach(function (k) {
        const v = params[k];
        if (v === '' || v == null) return;   // 空值不进地址，地址才干净
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      });
    }
    return parts.length ? h + '?' + parts.join('&') : h;
  }

  // 正常跳转：写进历史（所以后退键能一路退回来）
  function navigate(view, params) {
    const next = hashFor(view, params);
    if (location.hash === next) { applyRoute(); return; }  // 地址没变也要重画一次
    location.hash = next;                                  // 触发 hashchange（后退键靠它）
    // 立刻切一次，不等 hashchange —— 后者在 jsdom 里时序不可靠，
    // 而且用户点一下却要等一个事件循环才看到反应，没必要。
    // applyRoute 是幂等的，hashchange 再触发一次也无害。
    applyRoute();
  }

  // 静默同步：替换当前历史项、不新增。
  // 用在"打字筛选"上 —— 否则每敲一个字都进一次历史，后退键要按几十下才能退出去。
  function syncHash(view, params) {
    const next = hashFor(view, params);
    if (location.hash === next) return;
    try {
      history.replaceState(null, '', next);
    } catch (e) {
      // 个别浏览器在 file:// 下不让 replaceState —— 那就干脆不写地址，不影响功能
    }
  }

  // 读地址 → 把界面切过去。**这是唯一真正切换视图的地方。**
  function applyRoute() {
    const r = parseHash();
    switchView(r.view);

    // 地址里带了筛选词（#/courses?q=高数）→ 一并应用，让筛选也能被分享和后退
    if (r.view === 'courses' && typeof r.params.q === 'string') {
      applyFilter(r.params.q);
    }
  }

  /* ======================= 视图切换 ======================= */

  function switchView(name) {
    if (!Object.prototype.hasOwnProperty.call(ROUTES, name)) name = DEFAULT_VIEW;
    currentView = name;

    // 按 ROUTES 统一隐藏/显示，加视图时只要在 ROUTES 里补一行
    Object.keys(ROUTES).forEach(function (key) {
      const node = el(ROUTES[key].el);
      if (node) node.hidden = key !== name;
    });

    // 底部导航高亮：二级视图高亮它的父级（今天是 week 的分支）
    const lit = ROUTES[name].parent || name;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      const on = t.getAttribute('data-view') === lit;
      if (t.classList) t.classList.toggle('is-active', on);
      else t.className = on ? 'tab is-active' : 'tab';
    });

    // 「+ 添加」跟着当前页面变：一周视图和今天视图最常加 DDL（场景 B），清单页加课程。
    // 窄屏（≤430px）上文字太长会顶出屏幕，所以同时挂上短文案，
    // 由 CSS 在窄屏把按钮收成一个圆形加号（见样式区的媒体查询）。
    const fab = el('btn-add');
    if (fab) {
      const isWeekish = (name === 'week' || name === 'today');
      const long = isWeekish ? '+ 添加 DDL' : '+ 添加课程';
      fab.textContent = long;
      fab.setAttribute('data-label-long', long);
      fab.setAttribute('data-label-short', '+');
      fab.setAttribute('aria-label', isWeekish ? '添加 DDL' : '添加课程');
    }

    if (window.scrollTo) window.scrollTo(0, 0);
  }

  /* ======================= 事件绑定（委托到 document） ======================= */

  function onClick(event) {
    const target = event.target;
    if (!target || !target.closest) return;

    const tab = target.closest('.tab');
    if (tab) { navigate(tab.getAttribute('data-view')); return; }

    if (target.closest('[data-close]')) { closeModal(); return; }

    const trigger = target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.getAttribute('data-action');
    const kind = trigger.getAttribute('data-kind');
    const id = trigger.getAttribute('data-id');

    if (action === 'add') {
      // 一周视图 / 今天视图上加 → DDL（这两个视图都是"看时间"的，最常见的是记一个 DDL）
      const weekish = (currentView === 'week' || currentView === 'today');
      openModal(kind || (weekish ? 'ddl' : 'course'), null);
    } else if (action === 'edit') {
      openEdit(kind, id);
    } else if (action === 'delete') {
      removeRecord(kind, id);
    } else if (action === 'retry') {
      // ④ 出错状态里那颗「重试一次」—— 重新走一遍 render，四种状态流程原样复用
      render().catch(function (err) { console.error('[app] 重试失败', err); });
    } else if (action === 'clear-filter') {
      applyFilter('');
    }
  }

  /* Day 12：筛选的应用入口。
     ⚠️ 刻意不走 render() —— render() 会先铺骨架屏再去读数据（约 1800ms），
     打字时每敲一下都闪一次骨架屏，体验是灾难。
     筛选用的是"手上已经有的那份数据"，所以只重画清单，不重新读盘。 */
  function applyFilter(next) {
    filterQuery = next;

    const input = el('filter-input');
    if (input && input.value !== next) input.value = next;

    // Day 13：筛选词也写进地址（#/courses?q=高数）——刷新、分享、后退都能保住它。
    // 只在清单页做：在别的视图上（比如今天视图）不该被筛选词把地址改走。
    // 用 syncHash（替换而非新增），否则每敲一个字都往历史里塞一条，后退键就废了。
    if (currentView === 'courses') syncHash('courses', { q: filterQuery });

    const listArea = currentData;
    if (!listArea) {
      // 数据还没到手（仍在骨架屏阶段）——先记下筛选词，等数据回来自然会用上。
      // 这时**别动**清单页的内容区：状态位由 renderLoadingState / renderErrorState 管着。
      return;
    }

    // 数据到手了 → 把清单页从「状态位」切回正常内容
    setCoursesState(null);

    const q = normalize(filterQuery);
    if (q === '') {
      renderCourseList(listArea.courses);
      renderDdlList(listArea.ddls, new Date());
      renderFilterMeta(listArea.courses.length, listArea.ddls.length);
      return;
    }

    const shownCourses = listArea.courses.filter(function (c) { return matchCourse(c, q); });
    const shownDdls = listArea.ddls.filter(function (d) { return matchDdl(d, q); });

    if (shownCourses.length === 0 && shownDdls.length === 0) {
      const box1 = el('course-list');
      const box2 = el('ddl-list');
      if (box1) box1.innerHTML = filterNoneHtml(filterQuery);
      if (box2) box2.innerHTML = '';
    } else {
      renderCourseList(shownCourses);
      renderDdlList(shownDdls, new Date());
    }
    renderFilterMeta(shownCourses.length, shownDdls.length);
  }

  function onFilterInput(event) {
    const box = event.target;
    if (box && box.id === 'filter-input') applyFilter(box.value);
  }

  function onChange(event) {
    const box = event.target;
    if (box && box.getAttribute && box.getAttribute('data-action') === 'toggle-done') {
      toggleDone(box.getAttribute('data-id'), !!box.checked);
    }
  }

  function bindEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    // input 事件（不是 change）—— 要边打字边筛，change 要等失焦才触发
    document.addEventListener('input', onFilterInput);
    // 地址变了就重画 —— 后退键 / 前进键 / 手输地址都走这里
    window.addEventListener('hashchange', applyRoute);

    const fc = el('form-course'); if (fc) fc.addEventListener('submit', submitCourse);
    const fd = el('form-ddl');    if (fd) fd.addEventListener('submit', submitDdl);
  }

  /* ======================= 总调度 ======================= */

  /* 四种状态的统一入口（Day 8 重写）。
     顺序很重要：先画「加载中」，再去拿数据，最后按结果画「有数据 / 空 / 出错」。
     如果反过来先拿数据再画，加载中状态就永远看不见 —— 那时候数据已经回来了。 */
  async function render() {
    const now = new Date();   // 「现在」只取一次，整页渲染用同一个瞬间

    // ④ 出错状态：由 mock 开关直接模拟，方便你亲眼看到它长什么样
    if (usingMock() && mockSource() === 'error') {
      renderRange(now);
      currentData = null;   // 数据不可用，别让筛选拿到上一轮的旧数据
      renderErrorState('（这是 Day 8 的模拟错误，用来验证错误状态长什么样。）');
      return;
    }

    // ① 加载中：先把骨架铺上（三个视图都铺上），再去拿数据
    renderRange(now);
    renderLoadingState();

    let data;
    try {
      data = await loadData();
    } catch (err) {
      // 拿数据失败 —— 这是 ④ 出错状态在真实场景里被触发的地方
      console.error('[app] 读取数据失败', err);
      currentData = null;
      renderErrorState(err && err.message ? err.message : '');
      return;
    }

    // 假数据模式下，'empty' 开关 = 拿到的是空数组（模拟"读成功但没数据"）
    const courses = (usingMock() && mockSource() === 'empty') ? [] : data.courses;
    const ddls = (usingMock() && mockSource() === 'empty') ? [] : data.ddls;

    // ② 有数据 / ③ 空状态 —— 都交给 renderWeek 判断（它内部会看数组是不是空的）
    renderOverdue(ddls.filter(function (d) {
      return isOverdue(d, now);
    }).sort(byDeadline));
    renderWeek(courses, ddls, now);
    // Day 13：今天视图（二级）也要跟着同一份数据重画，
    // 否则在清单页改完数据、切回今天视图会看到旧内容。
    renderToday(courses, ddls, now);

    // Day 12：清单页带上当前筛选条件重画。
    // 这里刻意复用 applyFilter（而不是再写一遍筛选），
    // 免得"首次渲染"和"打字时筛选"两条路径日后走岔。
    currentData = { courses: courses, ddls: ddls };
    applyFilter(filterQuery);
  }

  // 暴露出去：保存/删除之后要重新渲染；也方便单独测
  window.App = {
    render: render,
    switchView: switchView,
    openModal: openModal,
    closeModal: closeModal,
    submitCourse: submitCourse,
    submitDdl: submitDdl,
    removeRecord: removeRecord,
    toggleDone: toggleDone,
    openEdit: openEdit,
    onClick: onClick,
    // Day 11：暴露反馈相关的两个函数，方便验证脚本单独调用
    showToast: showToast,
    setFormBusy: setFormBusy,
    // Day 12：筛选入口。Skill 检查时要能直接驱动筛选，不用去模拟键盘输入。
    applyFilter: applyFilter,
    getFilterQuery: function () { return filterQuery; },
    // Day 13：路由。暴露出来方便验证脚本直接驱动，不必去改 location。
    navigate: navigate,
    applyRoute: applyRoute,
    parseHash: parseHash,
    hashFor: hashFor,
    applySourceFromUrl: applySourceFromUrl,
    renderLoadingState: renderLoadingState,
    renderErrorState: renderErrorState
  };

  /* Day 13：四种状态要能"随时看到"，所以开一个地址开关：
       ?src=empty   空状态
       ?src=error   出错状态
       ?src=normal  正常（默认）
     这只是**验收通道** —— 数据一个字节没变，只是让已有的 mock 开关能从地址栏拨一下，
     省得每次为了截图都要去改 mock-data.js 再刷新。

     写法用 `?src=error#/week`（query 在 hash 前面）：切视图只改 hash，
     query 会留着，于是四种状态能在任意视图上看到。
     （`#/week?src=error` 也认，但那样一切视图就丢了。） */
  function applySourceFromUrl() {
    const raw = String(location.search || '') + '&' + String(location.hash || '');
    const m = /[?&#]src=(normal|empty|error)\b/.exec(raw);
    return m ? m[1] : null;
  }

  function boot() {
    bindEvents();

    // 地址里指定了数据源就先拨过去，再渲染 —— 这样第一屏就是目标状态
    const src = applySourceFromUrl();
    if (src && window.MockStore) window.MockStore.source = src;

    // 第一次打开：地址栏是空的（或没带 #/xxx）→ 静默补成默认视图，
    // 让地址栏一上来就长得规范，而不是先空着再等用户点一下才出现。
    if (!location.hash) syncHash(DEFAULT_VIEW, null);

    applyRoute();   // 按地址切到对应视图（空地址会落到默认视图）
    render().catch(function (err) {
      console.error('[app] 渲染失败', err);
    });
  }

  // 脚本在 </body> 前，正常情况下 DOM 已就绪；保险起见两种都接上
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
