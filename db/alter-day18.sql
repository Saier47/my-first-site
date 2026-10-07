/* =====================================================================
 * alter-day18.sql · Day 18 加唯一约束（防重复的"硬"保险）
 * ---------------------------------------------------------------------
 * 为什么要单独一个文件、而不是改 schema.sql：
 *
 *   db/schema.sql 第 47 / 101 行是 `DROP TABLE IF EXISTS ...`
 *   —— 那是"可反复建表"用的，代价是**表里的数据会全没**。
 *   Day 16 灌进去的 20 行种子数据现在还在库里，
 *   重跑 schema.sql 就全清了。所以增量改动另起一个文件，
 *   只做 ALTER，**不碰数据**。
 *
 * ---------------------------------------------------------------------
 * 加的是什么：
 *
 *   courses：UNIQUE (name, day_of_week, start_time)
 *            → 同一门课、同一天、同一开始时间，只允许存一条
 *
 *   ddls   ：UNIQUE (title, due_date)
 *            → 同名任务、同一天到期，只允许存一条
 *
 *   这和应用层的"内容查重"是**同一个键**，刻意保持一致的。
 *   区别在于谁在把关：
 *
 *     应用层查重（index.js 第 6 步）= **软**：查完到写入之间有时间窗，
 *                                     两个并发请求可能都查到"没有"然后都写。
 *     数据库约束（本文件）        = **硬**：不管谁怎么绕，数据库自己不让存。
 *
 *   Day 16 的教训在这里再应验一次：**约束写在文件里 ≠ 约束真的生效**。
 *   所以接口那边专门处理了 SQLSTATE 23505，把它翻译成人话的 409 ——
 *   能让用户看到"已经存在了"，就说明这道约束真的在拦人。
 *
 * ---------------------------------------------------------------------
 * 怎么用：
 *   bash db/run-sql.sh alter-day18.sql
 *
 *   反复跑也没问题（先 DROP IF EXISTS 再 ADD），是幂等的。
 *
 * ⚠️ 加约束时如果表里**已经有重复数据**，ALTER 会失败并告诉你是哪几行。
 *    所以下面先跑一段"查重"的 SELECT —— 先看清楚有没有重，再加。
 * ===================================================================== */


/* ---- 第 0 步：先看有没有重复数据（有的话下面加约束会失败） ---- */
/* 这段正常情况下应该返回 0 行。返回了行，就先手动清理再加约束。 */

SELECT name, day_of_week, start_time, COUNT(*) AS 重复份数
  FROM courses
 GROUP BY name, day_of_week, start_time
HAVING COUNT(*) > 1;

SELECT title, due_date, COUNT(*) AS 重复份数
  FROM ddls
 GROUP BY title, due_date
HAVING COUNT(*) > 1;


/* ---- 第 1 步：给 courses 加唯一约束 ---- */
/* DROP IF EXISTS 是为了幂等：重复跑这个文件不会报"约束已存在" */

ALTER TABLE courses DROP CONSTRAINT IF EXISTS uq_courses_slot;

ALTER TABLE courses
  ADD CONSTRAINT uq_courses_slot UNIQUE (name, day_of_week, start_time);

COMMENT ON CONSTRAINT uq_courses_slot ON courses
  IS '同一门课+同一天+同一开始时间只能一条（防重复录入）';


/* ---- 第 2 步：给 ddls 加唯一约束 ---- */

ALTER TABLE ddls DROP CONSTRAINT IF EXISTS uq_ddls_task;

ALTER TABLE ddls
  ADD CONSTRAINT uq_ddls_task UNIQUE (title, due_date);

COMMENT ON CONSTRAINT uq_ddls_task ON ddls
  IS '同名任务+同一天到期只能一条（防重复录入）';


/* ---- 第 3 步：确认约束真的建上了 ---- */
/* 这一步不能省 —— CLI 会把 SQL 错误吞掉，必须自己查一遍 */

SELECT conname AS 约束名, pg_get_constraintdef(oid) AS 定义
  FROM pg_constraint
 WHERE conname IN ('uq_courses_slot', 'uq_ddls_task', 'courses_pkey', 'ddls_pkey')
 ORDER BY conname;
