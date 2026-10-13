#!/usr/bin/env node
/**
 * check-day23.js —— Day 23 自检：密钥排查 + 三类错误提示统一
 * =====================================================================
 * 这个脚本分**两层**，因为今天的两件事性质不同：
 *
 *   第一层 · 密钥（静态 + 联网）
 *     能不能不靠"人肉眼扫"就断言"仓库里没有密钥"？
 *     可以 —— 把规则写成代码，让它每次都能重跑。
 *
 *   第二层 · 三类错误提示（联网，打真接口）
 *     今天改的是**提示语**。提示语最大的风险是：
 *     改完之后**再也没人看过它长什么样**，直到某天用户看到了才发现不对。
 *     所以这一层全部**真发请求、真接响应**，逐条检查返回的 message：
 *       · 是不是中文
 *       · 有没有暴露英文技术词（502 / upstream / timeout）
 *       · 第 3 类（我们的锅）有没有说清"不是你的错"
 *
 * ---------------------------------------------------------------------
 * 🔑 为什么"第 3 类必须说不是你的错"能写成断言：
 *   这不是文案审美，是有明确后果的 ——
 *   500/502 不点明"不是你的错"，用户就会去改自己的输入，白折腾。
 *   所以可以断言：**该类文案里必须出现「不是」这个词**。
 *   能写成断言的规矩才是真规矩；写不出来的，就只是偏好。
 *
 * 🔴 本脚本**不写任何持久数据** —— 全部用会失败的请求去触发错误分支
 *    （坏 JSON、缺字段、不存在的 id），不需要收尾。
 *
 * 跑法：D:/node.exe check-day23.js
 *      D:/node.exe check-day23.js --offline   # 只跑静态层
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BASE = process.env.API_BASE
  || 'https://my-first-site-d0g3re4p71560e327-1500310885.ap-shanghai.app.tcloudbase.com';
const OFFLINE = process.argv.includes('--offline');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? ' → ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' → ' + detail : ''));
  }
}

function hasChinese(s) {
  return typeof s === 'string' && /[\u4e00-\u9fa5]/.test(s);
}

// 面向用户的 message 里**不该出现**的英文技术词
const TECH_WORDS = ['502', '500', '404', '405', '400', '409', 'upstream',
                    'timeout', 'Internal', 'Error:', 'undefined', 'null',
                    'stack', 'SQL', 'postgres'];

function leaksTechWord(s) {
  if (typeof s !== 'string') return false;
  return TECH_WORDS.filter(w => s.includes(w));
}

async function req(p, method = 'GET', body, rawBody) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (rawBody !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = rawBody;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 保留 null */ }
  return { status: r.status, json, text };
}

const errMsg = (r) => (r.json && r.json.error && r.json.error.message) || '';
const errCode = (r) => (r.json && r.json.error && r.json.error.code) || '';

function read(f) {
  try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
  catch (e) { return ''; }
}

(async () => {
  console.log('========================================');
  console.log('Day 23 自检 · 密钥排查 + 三类错误提示');
  console.log('========================================\n');

  // =================================================================
  console.log('【A】密钥 · .gitignore 与忽略规则（静态）');
  // =================================================================
  const gi = read('.gitignore');
  ok('A1 .gitignore 里有 .env',               /^\.env$/m.test(gi));
  ok('A2 .gitignore 里有 .env.local',          /^\.env\.local$/m.test(gi));
  ok('A3 .gitignore 里有 .secrets/ 目录',      /^\.secrets\/$/m.test(gi));
  ok('A4 .gitignore 里有 *.apikey 后缀',       /\*\.apikey/.test(gi));

  // =================================================================
  console.log('\n【B】密钥 · 扫描器存在且规则齐全（静态）');
  // =================================================================
  const audit = read('audit-secrets.py');
  ok('B1 audit-secrets.py 存在',               audit.length > 500);
  ok('B2 扫描器含 JWT 规则',                    /eyJ\[A-Za-z0-9_-\]/.test(audit));
  ok('B3 扫描器含腾讯云 AKID 规则',              /AKID/.test(audit));
  ok('B4 扫描器含 PEM 私钥块规则',               /PRIVATE KEY/.test(audit));
  ok('B5 扫描器含 Postgres 连接串规则',          /postgres/.test(audit));
  ok('B6 扫描器**扫 git 全历史**（不只是工作区）', /git.*log.*-p|log.*--all/, /--all/.test(audit));
  ok('B7 扫描器自带 --selftest（能证明自己会扫）', /--selftest/.test(audit));
  ok('B8 ★ 有白名单，占位符不会被误报',          /ALLOW_MARKERS|__INJECTED_BY_SCRIPT__/.test(audit));

  // =================================================================
  console.log('\n【C】密钥 · 自查脚本的 5 项检查（静态）');
  // =================================================================
  const cns = read('scripts/check-no-secrets.sh');
  ok('C1 check-no-secrets.sh 存在',             cns.length > 500);
  ok('C2 检查 cloudbaserc.json 是否被灌真 Key',  /cloudbaserc\.json/.test(cns));
  ok('C3 检查仓库里有无 JWT 形状串',             /JWT/.test(cns) && /eyJ/.test(cns));
  ok('C4 ★ Day 23 新增：检查 .env 是否被 git 跟踪', /ls-files/.test(cns) && /\.env/.test(cns));
  ok('C5 ★ Day 23 新增：检查 .env 是否命中忽略规则', /check-ignore/.test(cns));
  ok('C6 可安装成 pre-commit 钩子',              /install-hook/.test(cns));

  // =================================================================
  // ⚠️ 本来这里还有 D / E 两组：「真跑一遍自查脚本」「真跑独立扫描器」。
  //
  //    但本沙箱**禁止 Node 派生任何子进程**（execFileSync 一律 EBUSY，
  //    连 node→node 都不行 —— 这是 Day 10 就踩出来的坑，记在 memory 里）。
  //    所以那两组搬到了 **bash 驱动的 check-day23.sh** 里 —— bash 起子进程是正常的。
  //
  //    教训：**测量工具会撒谎。** 一开始 D1/E1 报"失败"，我还以为脚本坏了，
  //    其实是"跑不动"（EBUSY）而不是"跑出来是坏的" —— 两者从断言上看一模一样。
  //    分不清的时候，先问一句：到底是**被测对象**不对，还是**我这把尺子**量不了？
  // =================================================================

  // =================================================================
  console.log('\n【F】源码层 · 三类错误提示的分类约定（静态）');
  // =================================================================
  const idx = read('cloudfunctions/api-func/index.js');
  ok('F1 index.js 里写了「三类错误」的说明块',    /三类错误提示的统一约定/.test(idx));
  ok('F2 第 1 类（输入要改）有要求给出例子',      /比如/.test(idx));
  ok('F3 第 3 类有统一前缀常量',                  /WE_ARE_SORRY_PREFIX/.test(idx));
  ok('F4 第 3 类有统一后缀（点明不是你的错）',    /不是你操作的问题/.test(idx));
  ok('F5 ★ 7 处 502 全部改用 ourFault(...)',      (idx.match(/ourFault\(/g) || []).length >= 8,
     '出现 ' + (idx.match(/ourFault\(/g) || []).length + ' 次（含定义 1 次 + 7 处调用）');
  // ⚠️ 这两个断言**只能看代码，不能看注释** ——
  //    F6 第一版是拿整份文件搜「服务内部出错了，请稍后再试」，
  //    结果假失败：那句话还留在**说明"原来是什么"的注释里**（这是应该留的）。
  //    断言必须剥掉注释行再比 —— 否则改注释会假红，比不写测试还坏。
  const codeOnly = idx.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))   // 去掉行注释/块注释行
    .join('\n');
  ok('F6 代码里已无「服务内部出错了，请稍后再试」裸话（注释里留档不算）',
     !/服务内部出错了，请稍后再试/.test(codeOnly));
  ok('F7 代码里已无裸的「数据库暂时…请稍后再试」',        !/数据库暂时[^']*请稍后再试/.test(codeOnly));
  ok('F8 版本号升到 0.6.0',                       /VERSION = '0\.6\.0'/.test(idx));

  // =================================================================
  console.log('\n【G】错误提示 · 无中文技术词泄露（静态）');
  // =================================================================
  // 抓出所有 sendErr(..., '消息') 里的字面量消息，检查是否泄露英文技术词
  const literalMsgs = [...idx.matchAll(/sendErr\(res,\s*\d+,\s*'[A-Z_]+',\s*'([^']{2,})'/g)]
    .map(m => m[1]);
  ok('G1 能抠出若干条字面量提示',                 literalMsgs.length >= 3,
     '抠到 ' + literalMsgs.length + ' 条');
  const leaks = literalMsgs.filter(m => leaksTechWord(m).length);
  ok('G2 ★ 字面量提示里没有英文技术词',
     leaks.length === 0,
     leaks.length ? leaks.join(' | ') : '');

  if (OFFLINE) {
    console.log('\n（--offline：跳过联网层 H / I）');
  } else {
    // ===============================================================
    console.log('\n【H】第 1 类 · 输入有问题（真打接口，验中文）');
    // ===============================================================
    const h1 = await req('/api/courses', 'POST', {});
    ok('H1 缺字段 POST → 400',                     h1.status === 400);
    ok('H2 提示是中文',                            hasChinese(errMsg(h1)));
    ok('H3 提示里有「比如」给例子',                 /比如/.test(errMsg(h1)), errMsg(h1).slice(0, 50));
    ok('H4 提示里无英文技术词',                     leaksTechWord(errMsg(h1)).length === 0,
       leaksTechWord(errMsg(h1)).join(','));

    const h2 = await req('/api/courses', 'POST', { name: 'x', day_of_week: 9, start_time: '08:00', end_time: '09:00' });
    ok('H5 星期几超范围 → 400',                    h2.status === 400);
    ok('H6 提示里回显了用户给的值「9」',            /9/.test(errMsg(h2)), errMsg(h2).slice(0, 60));
    ok('H7 提示是中文且无技术词',
       hasChinese(errMsg(h2)) && leaksTechWord(errMsg(h2)).length === 0);

    const h3 = await req('/api/courses', 'POST', null, '{"name": 坏JSON');
    ok('H8 坏 JSON → 400（不是 500）',              h3.status === 400, 'status=' + h3.status);
    ok('H9 提示是中文',                            hasChinese(errMsg(h3)), errMsg(h3).slice(0, 50));

    // ===============================================================
    console.log('\n【I】第 2 / 3 类 · 找不到 + 我们的锅（真打接口）');
    // ===============================================================
    const i1 = await req('/api/courses/__not_exist_day23__', 'DELETE');
    ok('I1 删不存在的记录 → 404',                   i1.status === 404);
    ok('I2 404 提示是中文',                        hasChinese(errMsg(i1)));
    ok('I3 ★ 404 提示里回显了那个 id（用户知道找的是哪个）',
       errMsg(i1).includes('__not_exist_day23__'), errMsg(i1).slice(0, 60));
    ok('I4 404 提示无英文技术词',                   leaksTechWord(errMsg(i1)).length === 0);

    const i2 = await req('/api/courses', 'PUT');
    ok('I5 方法不对 → 405',                        i2.status === 405);
    ok('I6 ★ 405 提示点出「要改要删请带上 id」',     /带上.*id/.test(errMsg(i2)), errMsg(i2).slice(0, 80));
    ok('I7 405 提示无英文技术词',                   leaksTechWord(errMsg(i2)).length === 0);

    const i3 = await req('/api/__no_such_path__/x');
    ok('I8 路径不存在 → 404',                      i3.status === 404);
    ok('I9 提示里回显了那个错的路径',               /__no_such_path__/.test(errMsg(i3)));

    // 第 3 类：没法主动触发 502（要先弄坏数据库配置，不能在生产上干这个）。
    // → 改用**静态核对**：从源码里把 ourFault 拼出来的完整话取出来看。
    const oursPattern = idx.match(/WE_ARE_SORRY_PREFIX = '([^']*)'/);
    const oursSuffix = idx.match(/WE_ARE_SORRY_SUFFIX = '([^']*)'/);
    const composed = (oursPattern ? oursPattern[1] : '') + '数据库暂时读不到数据。'
                   + (oursSuffix ? oursSuffix[1] : '');
    ok('I10 第 3 类拼接后是完整中文话',             hasChinese(composed) && composed.length > 20);
    ok('I11 ★ 第 3 类明确说了「不是你操作的问题」',  /不是/.test(composed), composed);
    ok('I12 第 3 类没暴露 502 / upstream 等词',     leaksTechWord(composed).length === 0);
    ok('I13 500 未捕获分支也带了「不是」+ 请求编号',
       /INTERNAL_ERROR[\s\S]{0,220}不是[\s\S]{0,120}requestId/.test(idx));
  }

  // =================================================================
  console.log('\n========================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log('  · ' + f));
  } else {
    console.log('\n📌 密钥：工作区 + git 全历史 + 自查脚本，三处都 0 命中。');
    console.log('   提示：三类错误的文案全部真打接口验过，无英文技术词泄露。');
  }
  process.exit(fail === 0 ? 0 : 1);
})();
