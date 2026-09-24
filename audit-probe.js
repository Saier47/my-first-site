/* Day 9 设计审查 —— 浏览器端实测脚本
 * ---------------------------------------------------------------------
 * 为什么需要它：jsdom 不做布局计算（getBoundingClientRect 全是 0），
 * 拿不到元素真实尺寸，也拿不到"最终渲染出来是什么颜色"。
 * Day 8 已经在 jsdom 的布局上吃过一次亏，这次直接在真实引擎里量。
 *
 * 怎么跑：
 *   1. 起服务：cd my-first-site && npm start
 *   2. 复制本文件为 .audit.html 旁边的一份诊断页（见下方说明），或用
 *      --virtual-time-budget 让浏览器执行它
 *   最简单的方式：把这段脚本内容内联进一个 .html，和 index.html 一样的
 *   结构但多引一个本脚本，然后用无头浏览器打开截图/导出结果。
 *
 * 输出：把结果写进页面 <pre id="audit-output">，也 console.log 一份。
 */
(function () {
  'use strict';

  var out = [];
  function line(s) { out.push(s); }

  /* ---------- 工具：从计算样式里取颜色并算对比度 ---------- */

  function parseColor(str) {
    if (!str) return null;
    str = String(str).trim().toLowerCase();
    if (str === 'transparent') return [0, 0, 0, 0];
    var m = str.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      var p = m[1].split(/[,\s\/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    return null;
  }

  function composite(fg, bg) {
    var a = fg[3];
    return [
      Math.round(fg[0] * a + bg[0] * (1 - a)),
      Math.round(fg[1] * a + bg[1] * (1 - a)),
      Math.round(fg[2] * a + bg[2] * (1 - a)), 1
    ];
  }

  // 往上追背景色，直到找到一个不透明的
  function effectiveBg(el) {
    /* 修 Day 9 审查脚本自身的第三个错：原来追不到不透明背景时兜底返回白色，
       而本次页面是的深色底（--bg:#080b14），一路追到 <html> 都没有不透明背景色，
       于是所有落在半透明面板上的文字都被拿去和白底比，算出一堆假的低对比度。
       正确做法：兜底用 <html>/<body> 的 background-color；如果它们也是透明的，
       就返回当前主题的 --bg（从 CSS 变量里读）。*/
    var node = el;
    while (node && node.nodeType === 1) {
      var cs = getComputedStyle(node);
      var c = parseColor(cs.backgroundColor);
      if (c && c[3] > 0.9) return c;
      if (c && c[3] > 0) {
        var parentBg = effectiveBgUp(node.parentElement);
        if (parentBg) return composite(c, parentBg);
      }
      node = node.parentElement;
    }
    return themeBg();
  }
  function themeBg() {
    var v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    var c = parseColor(v);
    if (c && c[3] > 0.9) return c;
    var bodyBg = parseColor(getComputedStyle(document.body).backgroundColor);
    if (bodyBg && bodyBg[3] > 0.9) return bodyBg;
    return [255, 255, 255, 1];
  }
  function effectiveBgUp(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var c = parseColor(getComputedStyle(node).backgroundColor);
      if (c && c[3] > 0.9) return c;
      node = node.parentElement;
    }
    return themeBg();
  }

  function luminance(c) {
    function f(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function ratio(a, b) {
    var l1 = luminance(a), l2 = luminance(b);
    var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  /* 元素是否真的能在屏幕上看到：自己或任一祖先 display:none / visibility:hidden
     就不算可见。隐藏元素量出来的对比度没有意义（背景取不到）。 */
  function isVisible(el) {
    var n = el;
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      n = n.parentElement;
    }
    return true;
  }

  /* ---------- 等页面渲染完（mock 有 600ms 延迟） ---------- */

  function whenReady(cb) {
    /* 修 Day 9 审查脚本自身的第五个错：原来只等「#week-list 里出现 7 个 .day」，
       但 .day（7 个日期列）在**骨架屏阶段就已经画出来了**，真实卡片 .item 还没插入，
       于是脚本会在 600ms 延迟前就通过，量出一堆"元素不存在"。
       正确做法：等到真正渲染出 .item（并且不等于骨架屏 .sk-day）再开始量。 */
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      var items = document.querySelectorAll('#week-list .item').length;
      var sk = document.querySelectorAll('.sk-day').length;
      var done = items > 0 && sk === 0;
      if (done || tries > 120) {
        clearInterval(t);
        setTimeout(cb, 150);
      }
    }, 50);
  }

  whenReady(function () {
    line('视口 = ' + document.documentElement.clientWidth + ' × ' + document.documentElement.clientHeight + 'px');
    line('');

    /* ============ 检查 5：横向溢出 ============ */

    line('===== 检查 5 · 移动端溢出（标准：scrollWidth === 视口宽度）=====');
    var vw = document.documentElement.clientWidth;
    var sw = document.documentElement.scrollWidth;
    line('  scrollWidth = ' + sw + 'px，视口 = ' + vw + 'px');
    line('  判定：' + (sw > vw + 1 ? '横向溢出 ❌ 超出 ' + (sw - vw) + 'px' : '无溢出 ✅'));
    var bad = [];
    document.querySelectorAll('body *').forEach(function (e) {
      var r = e.getBoundingClientRect();
      if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
        var owner = e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '';
        bad.push('    ' + e.tagName.toLowerCase() + owner +
          '　left=' + Math.round(r.left) + ' right=' + Math.round(r.right) + ' w=' + Math.round(r.width));
      }
    });
    if (bad.length) { line('  越界元素 ' + bad.length + ' 个：'); bad.slice(0, 12).forEach(line); }
    else line('  越界元素：0 个 ✅');
    line('');

    /* ============ 检查 6：触达尺寸 ============ */

    line('===== 检查 6 · 触达尺寸（标准：≥ 44×44px）=====');
    /* 修 Day 9 审查脚本自身的一个错：上一版把"页面上没这个元素"也写成「偏小 ❌」，
       结果 .btn-primary / .row-check 这些在当前视图（一周视图 + 没开弹层）里
       本来就不存在的元素，全被算成不合格，制造了假问题。
       正确做法：先把元素"造出来"（切视图 / 开弹层），量完再还原；造不出来的就
       明确写「本次没测到」，不判合格也不判不合格。*/
    var targets = [
      ['.btn-icon', '编辑 / 删除小按钮'],
      ['.btn-mini', '+ 课程 / + DDL'],
      ['.tab', '底部导航'],
      ['.fab', '+ 添加'],
      ['.row-check', 'DDL 勾选框'],
      ['.icon-btn', '弹层关闭 ×'],
      ['.btn-primary', '主要按钮'],
      ['.btn-ghost', '取消按钮']
    ];
    /* 关键修法（第二版）：上一版靠"点 tab 切视图再量"，但无头浏览器 + --virtual-time-budget
       下，click 之后的排版不会在同一个任务里完成，量出来还是 0。
       改成：**不去切视图**，而是直接找到这个元素"被藏起来的祖先"（display:none /
       hidden），临时把它显示出来、量、再还原。这样全程同步，不需要等渲染。 */
    function revealAncestors(el) {
      var restores = [];
      var node = el;
      while (node && node !== document.body) {
        var cs = getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') {
          restores.push([node, node.style.display, node.style.visibility]);
          node.style.display = 'block';
          node.style.visibility = 'visible';
        }
        node = node.parentElement;
      }
      return function () {
        restores.forEach(function (r) {
          r[0].style.display = r[1];
          r[0].style.visibility = r[2];
        });
      };
    }
    targets.forEach(function (pair) {
      var sel = pair[0], label = pair[1];
      var el = document.querySelector(sel);
      if (!el) {
        line('  ' + label.padEnd(20) + '本次没测到（页面上没有这个元素）');
        return;
      }
      var restore = revealAncestors(el);
      var r0 = el.getBoundingClientRect();
      var w = Math.round(r0.width), h = Math.round(r0.height);
      restore();
      if (w === 0 || h === 0) {
        line('  ' + label.padEnd(20) + '本次没测到（元素不可见）');
        return;
      }
      var pass = w >= 44 && h >= 44;
      line('  ' + label.padEnd(20) + (w + '×' + h + 'px').padEnd(12) +
        (pass ? '合格 ✅' : '偏小 ❌'));
      /* Day 9 特例：勾选框是**故意**保持小本体的（18px 方框视觉上不能变大），
         真正决定"点不点得中"的是 ::before 铺出来的透明热区。
         所以这里额外量一次伪元素，把真实热区范围算出来。 */
      if (sel === '.row-check') {
        var pb = getComputedStyle(el, '::before');
        if (pb && pb.width && pb.width !== 'auto' && parseFloat(pb.width) > 0) {
          var hw = parseFloat(pb.width), hh = parseFloat(pb.height);
          var hl = parseFloat(pb.left), ht = parseFloat(pb.top);
          line('  ' + '  ↳ 本体是故意做小的'.padEnd(20) +
            (w + '×' + h + 'px)').padEnd(12) + '热区靠 ::before 撑开');
          line('  ' + '  ↳ ::before 热区'.padEnd(20) +
            (hw + '×' + hh + 'px').padEnd(12) +
            (hw >= 44 && hh >= 44 ? '合格 ✅（真实可点范围）' : '偏小 ❌'));
        }
      }
    });
    line('');

    /* ---------- 以下为后面几项检查（同步执行，不再切视图） ---------- */
    function runRest() {
      /* ============ 检查 1（实测复核）：渲染后的真实对比度 ============ */

      line('===== 检查 1 · 实测对比度（真实渲染值，标准 正文≥4.5:1 / 大字≥3:1）=====');
      var textEls = document.querySelectorAll(
        '.top .sub, .zone-title, .day-name, .day-date, .day-empty, .item-time, .item-name, ' +
        '.item-loc, .item-tag, .row-title, .row-meta, .btn-icon, .btn-mini, .tab, .over-when, ' +
        '.over-title, .over-note, .empty-title, .empty-sub, .field-label, .list-empty, .day-tag'
      );
      var rows = [];
      var skipped = 0;
      textEls.forEach(function (el) {
        /* 修 Day 9 审查脚本自身的第四个错：清单视图（display:none 的 .view）里的
           元素也会被选中，而隐藏元素的背景取不到，会退到兜底色，算出假的低对比度
           （.row-title 就被误报成 2.71:1，实际渲染是 15.82:1）。
           正确做法：只量真正可见的元素。 */
        if (!isVisible(el)) { skipped++; return; }
        var cs = getComputedStyle(el);
        var fg = parseColor(cs.color);
        if (!fg) return;
        var bg = effectiveBg(el);
        if (fg[3] < 1) fg = composite(fg, bg);
        var rt = ratio(fg, bg);
        var fs = parseFloat(cs.fontSize);
        var fw = parseInt(cs.fontWeight, 10) || 400;
        var isLarge = fs >= 24 || (fs >= 18.66 && fw >= 700);
        var need = isLarge ? 3 : 4.5;
        rows.push({
          name: el.closest('[class]') ? (el.className || el.tagName).toString().split(' ')[0] : el.tagName,
          text: (el.textContent || '').trim().slice(0, 14),
          ratio: rt, need: need, fs: fs, fw: fw, pass: rt >= need
        });
      });
      rows.sort(function (a, b) { return a.ratio - b.ratio; });
      var seen = {};
      rows.forEach(function (r) {
        var key = r.name + r.ratio.toFixed(2);
        if (seen[key]) return;
        seen[key] = 1;
        line('  ' + (r.ratio.toFixed(2) + ':1').padEnd(9) +
          (r.pass ? '合格 ✅' : '不合格 ❌') + '  ' +
          String(r.fs + 'px/' + r.fw).padEnd(12) +
          r.name.padEnd(14) + ' 「' + r.text + '」');
      });
      if (skipped) line('  （另有 ' + skipped + ' 个元素当前视图下不可见，未计入）');
      line('');

      /* ============ 检查 3：行高与文字实际占位 ============ */

      line('===== 检查 4 · 层级与视觉重量 =====');
      var h1 = document.querySelector('.top h1');
      var sub = document.querySelector('.top .sub');
      if (h1 && sub) {
        var a = parseFloat(getComputedStyle(h1).fontSize);
        var b = parseFloat(getComputedStyle(sub).fontSize);
        line('  标题 ' + a + 'px / 副标题 ' + b + 'px　差 ' + (a - b) + 'px' + ((a - b) >= 2 ? ' ✅' : ' ⚠️'));
      }
      var dname = document.querySelector('.day-name');
      var ddate = document.querySelector('.day-date');
      if (dname && ddate) {
        var x = parseFloat(getComputedStyle(dname).fontSize);
        var y = parseFloat(getComputedStyle(ddate).fontSize);
        line('  星期 ' + x + 'px / 日期 ' + y + 'px　差 ' + (x - y) + 'px' + ((x - y) >= 2 ? ' ✅' : ' ⚠️ 差异太小，分不出主次'));
      }
      line('');

      /* ============ 检查 3：对齐 ============ */

      line('===== 检查 3 · 对齐（同一列内，该左对齐的是否对齐）=====');
      /* 修 Day 9 审查脚本自身的第二个错：上一版把"7 个并列卡片的左边缘"放在一起比，
         它们本来就该在不同的 x 上（桌面是 7 列并排），于是报出「偏差 1046px ❌」，
         是纯粹的假问题。
         第二版又漏了一点：.day-date 是**故意** margin-left:auto 靠右的，
         和 .day-name 本来就不该对齐，不能把它们算进"应左对齐"的组里。
         现在只比对**同一列内、应当共左基线**的元素：卡片头 .day-name 与卡内 .item。*/
      var cols = document.querySelectorAll('#week-list .day');
      if (!cols.length) {
        line('  (一周视图里没有 .day，跳过)');
      } else {
        var worst = 0, worstWho = '';
        cols.forEach(function (col, i) {
          var set = [];
          var head = col.querySelector('.day-name');
          if (head) set.push({ cls: 'day-name', x: Math.round(head.getBoundingClientRect().left) });
          col.querySelectorAll('.item').forEach(function (e) {
            var r = e.getBoundingClientRect();
            if (r.width > 0) set.push({ cls: 'item', x: Math.round(r.left) });
          });
          if (set.length < 2) return;
          var xs = set.map(function (s) { return s.x; });
          var d = Math.max.apply(null, xs) - Math.min.apply(null, xs);
          if (d > worst) { worst = d; worstWho = '第 ' + (i + 1) + ' 列（' + set.map(function (s) { return s.cls + '@' + s.x; }).join(', ') + '）'; }
        });
        line('  同列内「卡片头 ↔ 卡内条目」左边缘最大偏差 ' + worst + 'px' +
          (worst > 1 ? '　❌ ' + worstWho : '　✅'));
      }
      line('  说明：.day-date 故意 margin-left:auto 靠右，不参与左对齐比较（设计意图）');
      line('  说明：7 列并排是设计意图，各列 x 不同属正常，不做横向比较');
      line('');
      line('===== 检查 2 · 卡片内边距一致性 =====');
      var pads = {};
      document.querySelectorAll('#week-list .item').forEach(function (e) {
        var cs = getComputedStyle(e);
        pads[cs.paddingTop + '/' + cs.paddingRight + '/' + cs.paddingBottom + '/' + cs.paddingLeft] = 1;
      });
      var keys = Object.keys(pads);
      line('  .item 内边距出现 ' + keys.length + ' 种：' + keys.join(' , '));
      line('  ' + (keys.length === 1 ? '一致 ✅' : '不一致 ❌'));
      var margs = {};
      Array.prototype.forEach.call(document.querySelectorAll('#week-list .item'), function (e) {
        margs[getComputedStyle(e).marginBottom] = 1;
      });
      var mk = Object.keys(margs);
      line('  .item 下间距出现 ' + mk.length + ' 种：' + mk.join(' , ') + (mk.length === 1 ? ' ✅' : ' ❌'));
      /* 卡片之间的间距（列内上下相邻的两个 .item） */
      var gaps = {};
      cols.forEach(function (col) {
        var items = col.querySelectorAll('.item');
        for (var i = 1; i < items.length; i++) {
          var a = items[i - 1].getBoundingClientRect(), b = items[i].getBoundingClientRect();
          gaps[Math.round(b.top - a.bottom)] = (gaps[Math.round(b.top - a.bottom)] || 0) + 1;
        }
      });
      var gk = Object.keys(gaps);
      if (gk.length) {
        line('  同列相邻卡片实际间距出现 ' + gk.length + ' 种：' +
          gk.map(function (k) { return k + 'px×' + gaps[k]; }).join(' , ') +
          (gk.length === 1 ? ' ✅' : (gaps[gk[0]] > 1 ? ' ⚠️ 多数是 ' + gk[0] + 'px' : ' ⚠️ 不一致')));
      } else {
        line('  同列相邻卡片间距：本视图每列只有 1 张卡，没测到（可切窄屏纵向视图再测）');
      }

      /* ---------- 输出 ---------- */
    }

    runRest();

    var pre = document.createElement('pre');
    pre.id = 'audit-output';
    pre.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:99999;margin:0;' +
      'background:#fff;color:#000;font:12px/1.5 ui-monospace,Consolas,monospace;' +
      'padding:14px;white-space:pre-wrap;overflow:auto;';
    pre.textContent = out.join('\n');
    document.documentElement.appendChild(pre);
    window.__audit = out.join('\n');
    console.log(out.join('\n'));
  });
})();
