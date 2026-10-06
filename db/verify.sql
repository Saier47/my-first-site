/* =====================================================================
 * verify.sql —— Day 16 板块 ④：select 验证
 * ---------------------------------------------------------------------
 * 目的：不用改前端，就用 SQL 回答一个问题 ——
 *       「页面上要显示的东西，数据库给不给得出来？」
 *
 * 四条查询分别对应页面上的四块内容：
 *   Q1  周课表视图        → 课程页「这一周」格子里的内容
 *   Q2  DDL 列表 + 状态   → DDL 页每条任务的标题 / 时间 / 状态标识
 *   Q3  最近要交的未完成  → 首页「最近要交」列表
 *   Q4  两表合并时间轴    → 产品核心卖点：课程和 DDL 排在同一条轴上
 *
 * 跑法：bash db/run-sql.sh verify.sql
 * 注意：CLI 会把 SQL 错误吞掉（见 run-sql.sh 注释），所以每次跑完
 *       都要看一眼输出里有没有 Rows，行数为 0 或报错都算失败。
 * ===================================================================== */

/* Q1 周课表视图：按星期 + 开始时间排，对齐课程页的格子顺序 */
SELECT day_of_week, start_time, end_time, name, COALESCE(NULLIF(location, ''), '待定') AS location
FROM courses
ORDER BY day_of_week, start_time;

/* Q2 DDL 列表 + 状态：状态不存库、按 done 和 due_date 现算 */
SELECT due_date,
       COALESCE(NULLIF(due_time, ''), '--:--') AS due_time,
       title,
       CASE WHEN done THEN 'completed'
            WHEN due_date < to_char(now(), 'YYYY-MM-DD') THEN 'overdue'
            ELSE 'pending' END AS status
FROM ddls
ORDER BY due_date, due_time;

/* Q3 首页「最近要交」：只取未完成，按时间升序，额外算逾期天数 */
SELECT due_date,
       COALESCE(NULLIF(due_time, ''), '--:--') AS due_time,
       title,
       CASE WHEN due_date < to_char(now(), 'YYYY-MM-DD') THEN 'overdue' ELSE 'pending' END AS status,
       GREATEST(0, to_date(to_char(now(), 'YYYY-MM-DD'), 'YYYY-MM-DD') - to_date(due_date, 'YYYY-MM-DD')) AS days_late
FROM ddls
WHERE done = false
ORDER BY due_date, due_time
LIMIT 5;

/* Q4 核心卖点验证：课程和 DDL 用同一种排序键合到一条轴上
      sort_key = 星期 × 10000 + 时刻（如周一 08:00 → 10800）
      课程按自己的星期/时刻排；DDL 没有「星期」概念，统一给个靠后的值 */
SELECT kind, sort_key, title
FROM (
  SELECT 'course' AS kind,
         day_of_week * 10000 + CAST(replace(start_time, ':', '') AS int) AS sort_key,
         name AS title
  FROM courses
  UNION ALL
  SELECT 'ddl' AS kind, 900000 AS sort_key, title
  FROM ddls
  WHERE done = false
) t
ORDER BY sort_key, title
LIMIT 8;
