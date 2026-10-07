/* =====================================================================
 * cleanup-day18.sql · 删掉 Day 18 的验证数据（**需要时才跑**）
 * ---------------------------------------------------------------------
 * ⚠️ 这个文件**平时不要跑**。
 *
 *    check-day18.js 每次跑会往库里写一行课 + 一条 DDL，
 *   id 形如 `c_d18check_xxxx` / `d_d18check_xxxx`。
 *   那些是**今天要交的证据**（截图就拍它们），所以默认留着。
 *
 *   什么时候跑它：
 *     · 截图交完了，想把验证数据清干净
 *     · check-day18.js 跑太多次，库里堆了一堆 c_d18check_*
 *
 * 怎么跑：
 *   bash db/run-sql.sh cleanup-day18.sql
 *
 * ---------------------------------------------------------------------
 * 🔑 为什么用 `LIKE 'c_d18check_%'` 而不是写死 id：
 *   每次跑 check-day18.js 的时间戳都不同，id 也就不一样。
 *   按**前缀**删，能把历史上所有批次一次清掉，不用一个个查 id。
 *
 * 🛡️ 为什么前缀要带 `_d18check_` 这串：
 *   万一哪天真有一门课叫别的名字，也不会被误删 ——
 *   这个前缀只可能由 check-day18.js 生成，人手不会这么起名。
 * ===================================================================== */

/* 先看一眼要删的是哪些（删之前留个记录，删错了能知道删了啥） */
/* ⚠️ 两套条件都要，原因见下面"开删"那段的注释 */
SELECT id, name, day_of_week, start_time FROM courses
 WHERE id LIKE 'c_d18check_%' OR name LIKE 'Day18%' ORDER BY id;

SELECT id, title, due_date FROM ddls
 WHERE id LIKE 'd_d18check_%' OR title LIKE 'Day18%' ORDER BY id;


/* ---- 开删 ----
 * 🔴 为什么要两套条件（2026-10-07 实测发现）：
 *   第 1 套 `id LIKE 'c_d18check_%'` —— check-day18.js 造的，
 *        它自己生成 id，所以前缀可控。
 *   第 2 套 `name LIKE 'Day18%'` —— **手发 POST 且没传 id** 的那种，
 *        id 由**后端随机生成**（如 c_muy5tskqt8wm3a），前缀根本抓不到。
 *        这类记录的 id 不可预测，只能靠"名字是测试用的"来识别。
 *   → 只写第 1 套会漏掉一批，留下清不掉的垃圾数据。 */
DELETE FROM courses
 WHERE id LIKE 'c_d18check_%' OR name LIKE 'Day18%';

DELETE FROM ddls
 WHERE id LIKE 'd_d18check_%' OR title LIKE 'Day18%';


/* 确认删干净了（应该都是 0） */
SELECT COUNT(*) AS 剩余验证课程 FROM courses
 WHERE id LIKE 'c_d18check_%' OR name LIKE 'Day18%';

SELECT COUNT(*) AS 剩余验证DDL FROM ddls
 WHERE id LIKE 'd_d18check_%' OR title LIKE 'Day18%';


/* 顺便报一下两张表现在的行数 */
SELECT relname AS 表, n_live_tup AS 行数
  FROM pg_stat_user_tables
 WHERE relname IN ('courses', 'ddls')
 ORDER BY relname;
