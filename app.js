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
 * ===================================================================== */

(function () {
  'use strict';

  const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

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

  /* ======================= 渲染：本周范围 ======================= */

  function renderRange(now) {
    const a = startOfWeek(now);
    const b = addDays(a, 6);
    const node = el('week-range');
    if (node) node.textContent = md(a) + ' – ' + md(b);
  }

  /* ======================= 渲染：过期区域（置顶） ======================= */

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
    box.innerHTML = overdue.map(function (d) {
      return '<div class="over-item">' +
        '<span class="over-when">' + esc(d.due_date + ' ' + d.due_time) + '</span>' +
        '<span class="over-title">' + esc(d.title) + '</span>' +
        (d.note ? '<span class="over-note">' + esc(d.note) + '</span>' : '') +
        '</div>';
    }).join('');
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
      '<span class="item-time">' + esc(d.due_time) + '</span>' +
      '<span class="item-name">' + esc(d.title) + '</span>' +
      '<span class="item-tag">DDL</span>' +
      '</li>';
  }

  /* ======================= 渲染：一周 7 天 ======================= */

  function renderWeek(courses, ddls, now) {
    const box = el('week-list');
    if (!box) return;

    // 边界：一条数据都没有 → 给引导语 + 一个添加按钮，不能是白屏（PRD B1）
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
      html += '<div class="day-head">' +
                '<span class="day-name">' + DAY_NAMES[i] + '</span>' +
                '<span class="day-date">' + md(day) + '</span>' +
                (isToday ? '<span class="day-tag">今天</span>' : '') +
              '</div>';

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
    if (editing) await Store.updateCourse(editing.id, data);
    else await Store.createCourse(data);

    closeModal();
    await render();
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
    if (editing) await Store.updateDdl(editing.id, data);
    else await Store.createDdl(data);

    closeModal();
    await render();
  }

  /* ======================= 删除 / 勾选完成 ======================= */

  async function openEdit(kind, id) {
    const all = kind === 'course' ? await Store.listCourses() : await Store.listDdls();
    const rec = all.filter(function (x) { return x.id === id; })[0];
    if (rec) openModal(kind, rec);
  }

  async function removeRecord(kind, id) {
    const isCourse = kind === 'course';
    const all = isCourse ? await Store.listCourses() : await Store.listDdls();
    const target = all.filter(function (x) { return x.id === id; })[0];
    if (!target) return;

    const name = isCourse ? target.name : target.title;
    // A7：删除前先弹一次确认；点「取消」什么都不做
    if (!window.confirm('确定删除「' + name + '」吗？删除后不能恢复。')) return;

    if (isCourse) await Store.deleteCourse(id);
    else await Store.deleteDdl(id);
    await render();
  }

  async function toggleDone(id, checked) {
    await Store.updateDdl(id, { done: checked });
    await render();
  }

  /* ======================= 视图切换 ======================= */

  function switchView(name) {
    currentView = name;

    const week = el('view-week'), list = el('view-courses');
    if (week) week.hidden = name !== 'week';
    if (list) list.hidden = name !== 'courses';

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      const on = t.getAttribute('data-view') === name;
      if (t.classList) t.classList.toggle('is-active', on);
      else t.className = on ? 'tab is-active' : 'tab';
    });

    // 「+ 添加」跟着当前页面变：一周视图最常加 DDL（场景 B），清单页加课程
    const fab = el('btn-add');
    if (fab) fab.textContent = name === 'week' ? '+ 添加 DDL' : '+ 添加课程';

    if (window.scrollTo) window.scrollTo(0, 0);
  }

  /* ======================= 事件绑定（委托到 document） ======================= */

  function onClick(event) {
    const target = event.target;
    if (!target || !target.closest) return;

    const tab = target.closest('.tab');
    if (tab) { switchView(tab.getAttribute('data-view')); return; }

    if (target.closest('[data-close]')) { closeModal(); return; }

    const trigger = target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.getAttribute('data-action');
    const kind = trigger.getAttribute('data-kind');
    const id = trigger.getAttribute('data-id');

    if (action === 'add') {
      openModal(kind || (currentView === 'week' ? 'ddl' : 'course'), null);
    } else if (action === 'edit') {
      openEdit(kind, id);
    } else if (action === 'delete') {
      removeRecord(kind, id);
    }
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

    const fc = el('form-course'); if (fc) fc.addEventListener('submit', submitCourse);
    const fd = el('form-ddl');    if (fd) fd.addEventListener('submit', submitDdl);
  }

  /* ======================= 总调度 ======================= */

  async function render() {
    const now = new Date();                              // 「现在」只取一次，整页渲染用同一个瞬间
    const courses = await Store.listCourses();
    const ddls = await Store.listDdls();

    renderRange(now);
    renderOverdue(ddls.filter(function (d) {
      return isOverdue(d, now);
    }).sort(byDeadline));
    renderWeek(courses, ddls, now);
    renderCourseList(courses);
    renderDdlList(ddls, now);
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
    onClick: onClick
  };

  function boot() {
    bindEvents();
    switchView('week');
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
