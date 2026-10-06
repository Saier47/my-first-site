#!/usr/bin/env node
/**
 * check-day16.js —— Day 16 自检（静态层）
 * =====================================================================
 * 这个脚本**只查文件，不连数据库**。
 *
 * 🔴 为什么不连库：
 *    本机沙箱禁止 Node 脚本派生任何子进程（连 `node` 派生 `node` 都
 *    抛 `spawnSync EBUSY`，实测连试三种调用姿势都一样）。
 *    而调 tcb 必然要起子进程 → 所以「在 Node 里连库」这条路本环境走不通。
 *    → 真库验证交给 bash 驱动的 `db/verify-day16.sh`（bash 能正常跑 tcb）。
 *    这也正是 Day 15 教训的延伸：**先分清是「被测对象坏了」还是
 *    「测量工具坏了」，别急着改对的代码。**
 *
 * 所以本脚本负责：
 *   A. 三个 SQL 文件存在且内容结构正确
 *   B. SQL 文件里「该有的断言点」都在（约束、索引、幂等写法、四条查询）
 *   C. 提交物齐全（check 脚本、PRD/README 里该有的说明）
 * 真库层（表存不存在 / 行数 / 约束是否生效 / 查询能不能出结果）
 *   由 `bash db/verify-day16.sh` 负责，两者一起才算完整自检。
 *
 * 跑法：D:/node.exe check-day16.js
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

console.log('========================================');
console.log('Day 16 自检（静态层）：数据模型 / 建表 / 种子 / 验证脚本');
console.log('========================================\n');

// ---------------------------------------------------------------- A 文件层
console.log('【A】文件层');

const schema = read('db/schema.sql');
const seed = read('db/seed.sql');
const verify = read('db/verify.sql');
const runner = read('db/run-sql.sh');

ok('db/schema.sql 存在', schema !== null);
ok('db/seed.sql 存在', seed !== null);
ok('db/verify.sql 存在', verify !== null);
ok('db/run-sql.sh 存在', runner !== null);

if (!schema || !seed || !verify) {
  console.log('\n缺关键文件，后面的断言跳过。');
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}

// --------------------------------------------------------------- B 建表层
console.log('\n【B】建表（schema.sql）');

ok('建了 courses 表', /CREATE TABLE\s+courses/i.test(schema));
ok('建了 ddls 表', /CREATE TABLE\s+ddls/i.test(schema));
ok('可重复执行（DROP TABLE IF EXISTS）', /DROP TABLE IF EXISTS/i.test(schema));
ok('courses.id 是 TEXT 主键', /id\s+TEXT\s+PRIMARY KEY/i.test(schema));
ok('courses 有 1–7 CHECK 约束', /day_of_week[\s\S]{0,140}BETWEEN\s+1\s+AND\s+7/i.test(schema));
ok('courses.name 禁纯空格', /length\s*\(\s*trim\s*\(\s*name/i.test(schema));
ok('时间字段用 TEXT（前后端一致）', /start_time\s+TEXT/i.test(schema) && /end_time\s+TEXT/i.test(schema) && /due_date\s+TEXT/i.test(schema));
ok('时间戳用 TIMESTAMPTZ DEFAULT now()', /TIMESTAMPTZ[\s\S]{0,60}DEFAULT\s+now\(\)/i.test(schema));
ok('两表都有 COMMENT ON TABLE', /COMMENT ON TABLE\s+courses/i.test(schema) && /COMMENT ON TABLE\s+ddls/i.test(schema));
ok('字段级 COMMENT 覆盖到位', (schema.match(/COMMENT ON COLUMN/g) || []).length >= 16,
   '实际 ' + (schema.match(/COMMENT ON COLUMN/g) || []).length + ' 条');
ok('显式声明两表无外键', /无外键/.test(schema) && !/FOREIGN KEY/i.test(schema));
ok('有 courses 星期索引', /idx_courses_day/i.test(schema));
ok('有 ddls 截止日索引', /idx_ddls_due/i.test(schema));
ok('有未完成任务的部分索引', /idx_ddls_pending[\s\S]{0,120}WHERE\s+done\s*=\s*false/i.test(schema));

// --------------------------------------------------------------- C 种子层
console.log('\n【C】种子（seed.sql）');

ok('灌 courses', /INSERT INTO\s+courses/i.test(seed));
ok('灌 ddls', /INSERT INTO\s+ddls/i.test(seed));
ok('用 ON CONFLICT 保幂等', /ON CONFLICT\s*\(\s*id\s*\)/i.test(seed));
ok('冲突时 DO UPDATE', /DO UPDATE\s+SET/i.test(seed));
ok('用 EXCLUDED 引用新值', /EXCLUDED\./i.test(seed));
ok('seed 里没写死绝对日期以外的东西（含中文样例）', /[\u4e00-\u9fa5]/.test(seed));
const cSeedRows = (seed.match(/\(\s*'c_seed_\d+'/g) || []).length;
const dSeedRows = (seed.match(/\(\s*'d_seed_\d+'/g) || []).length;
ok('courses 种子 ≥ 5 行', cSeedRows >= 5, '实际 ' + cSeedRows + ' 行');
ok('ddls 种子 ≥ 5 行', dSeedRows >= 5, '实际 ' + dSeedRows + ' 行');
ok('种子覆盖 day_of_week 全周多天', new Set((seed.match(/'(c_seed_\d+)',\s*'[^']*',\s*(\d)/g) || []).map(s => s.match(/,\s*(\d)$/)[1])).size >= 4);

// ------------------------------------------------------------- D 验证脚本
console.log('\n【D】select 验证（verify.sql）');

ok('Q1 周课表视图', /FROM courses[\s\S]*ORDER BY day_of_week,\s*start_time/i.test(verify));
ok('Q2 DDL 状态三态判定', /'completed'[\s\S]{0,100}'overdue'[\s\S]{0,100}'pending'/i.test(verify));
ok('Q3 只取未完成', /WHERE\s+done\s*=\s*false/i.test(verify));
ok('Q3 算了逾期天数', /days_late/i.test(verify));
ok('Q4 两表 UNION 合并', /UNION ALL/i.test(verify));
ok('Q4 有统一排序键', /sort_key/i.test(verify));
ok('verify.sql 里做了空值兜底', /空(.| )*兜底|--:--/.test(verify) || /COALESCE/i.test(verify));

// ------------------------------------------------------------ E 执行器
console.log('\n【E】执行器（run-sql.sh）');

if (runner) {
  ok('剥注释是字符串感知的（不误吃 \'--:--\'）', /in_str/.test(runner) && /strip_comments/.test(runner));
  ok('逐条执行（多语句只返最后一条的坑）', /split\(';'\)/.test(runner) || /for i, s in enumerate\(stmts/.test(runner));
  ok('执行后自动核对表清单', /information_schema\.tables/.test(runner));
  ok('执行后自动核对行数', /pg_stat_user_tables/.test(runner));
  ok('脚本里没有硬编码密钥', !/(secret|password|apikey|api_key)\s*[:=]/i.test(runner));
}

// ---------------------------------------------------------- F 提交物齐全
console.log('\n【F】交付物齐全');

ok('check-day16.js 自身存在', fs.existsSync(path.join(ROOT, 'check-day16.js')));
ok('PRD.md 存在', fs.existsSync(path.join(ROOT, 'PRD.md')));
ok('README.md 存在', fs.existsSync(path.join(ROOT, 'README.md')));
ok('api-contract.md 存在（Day 15 产出，Day 17 要用）', fs.existsSync(path.join(ROOT, 'api-contract.md')));

// ------------------------------------------------------------------ 汇总
console.log('\n========================================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败明细：');
  failures.forEach(f => console.log('  ✗ ' + f));
}
console.log('========================================');
console.log('\n⚠️ 静态层通过 ≠ 表建好了。真库验证请另跑：');
console.log('   VERIFY=1 bash db/run-sql.sh verify.sql');
console.log('   或 bash db/verify-day16.sh');
process.exit(fail > 0 ? 1 : 0);

