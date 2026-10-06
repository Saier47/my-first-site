-- =====================================================================
-- schema.sql · 数据库表结构（Day 16 · 2026-10-05）
-- ---------------------------------------------------------------------
-- 这个文件回答一个问题：**数据库里有哪些表、每张表长什么样。**
--
-- 怎么用：
--   tcb db execute -e <环境ID> --sql "$(cat db/schema.sql)"
--   或在控制台「SQL 编辑器」里整段粘贴执行
--
-- 怎么改：
--   改字段 → 改这个文件 → 重新执行。**但要注意**：下面的 DROP TABLE 会清空数据！
--   加字段时把 DROP 改成 ALTER TABLE，别在生产数据上重跑这个文件。
--
-- ---------------------------------------------------------------------
-- 设计原则（三条，都有代价，都记在这儿）
--
-- 1. **字段名和 store.js / PRD 第 4 节逐字一致**
--    前端已经在用 id / day_of_week / start_time 这些名字了。
--    数据库这边改一个字（比如 day_of_week → weekday），
--    前端就要跟着改 —— 那是白花的时间。
--    → 优先保证前后端一致，而不是"教科书上最优"。
--
-- 2. **两张表之间没有外键**
--    课程是"每周重复"，DDL 是"只来一次" —— 生命周期不同。
--    强行加 course_id 会逼着用户"必须先建课程才能建 DDL"，是给用户添堵。
--    它们只在**展示时**叠在一起（存储分开、展示合并）。
--    详见 PRD 第 4.5 节。
--
-- 3. **id 用 TEXT、不用自增整数**
--    store.js 生成的是 c_l9x2k4a8f3 这种字符串。
--    数据库这边保持一致 → 前端一行不用改。
--    代价：TEXT 索引比整数慢一点，但几十条数据完全无所谓。
-- =====================================================================


-- =====================================================================
-- 表 1：courses（课程）
-- ---------------------------------------------------------------------
-- 存的是"这学期每周都上的课"。
-- 一门课 = 一行。同一门课周一上、周三也上 → 两行（因为时段不同）。
-- =====================================================================

-- ⚠️ DROP TABLE IF EXISTS 是"可重复执行"的关键：
--    第一次跑没有表，IF EXISTS 让这句不报错；
--    第二次跑有表了，就删掉重建 —— 保证结果一定是干净的。
--    ⚠️ 但这也意味着**表里的数据会全没**。有真数据后改用 ALTER。
DROP TABLE IF EXISTS courses;

CREATE TABLE courses (
  -- 主键：课程的唯一标识，如 'c_l9x2k4a8f3'
  id           TEXT        PRIMARY KEY,

  -- 课程名，如「高等数学」。NOT NULL + CHECK 双保险，防止存进空字符串
  name         TEXT        NOT NULL
                           CHECK (length(trim(name)) > 0),

  -- 星期几：1 = 周一 … 7 = 周日
  -- 用整数不用字符串（'Mon' / '周一'），因为整数能排序、能比较、没有歧义
  day_of_week  SMALLINT    NOT NULL
                           CHECK (day_of_week BETWEEN 1 AND 7),

  -- 开始 / 结束时间，格式 'HH:MM'（24 小时制）
  -- ⚠️ 故意用 TEXT 而不是 TIME 类型 —— 为了和 store.js 存的字符串完全一致，
  --    契约不用改。代价：数据库不校验时间格式（有人能存 '8点'）。
  --    这是**已知并接受**的代价，格式校验交给接口层（Day 17）。
  start_time   TEXT        NOT NULL,
  end_time     TEXT        NOT NULL,

  -- 上课地点，可为空（有些课不写地点）
  location     TEXT        NOT NULL DEFAULT '',

  -- 创建 / 最后修改时间，ISO 8601 字符串
  -- 用 TIMESTAMPTZ（带时区）而不是 TIMESTAMP：
  -- 服务器在别的时区，不带时区的时间会读错。
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  courses              IS '课程表：每周重复的固定课程，一门课一行';
COMMENT ON COLUMN courses.id           IS '主键，形如 c_l9x2k4a8f3';
COMMENT ON COLUMN courses.name         IS '课程名，不能为空';
COMMENT ON COLUMN courses.day_of_week  IS '星期几：1=周一 … 7=周日';
COMMENT ON COLUMN courses.start_time   IS '开始时间，HH:MM 24小时制';
COMMENT ON COLUMN courses.end_time     IS '结束时间，HH:MM，应晚于 start_time';
COMMENT ON COLUMN courses.location     IS '上课地点，可为空字符串';
COMMENT ON COLUMN courses.created_at   IS '创建时间（带时区）';
COMMENT ON COLUMN courses.updated_at   IS '最后修改时间（带时区）';

-- 索引：最常用的查询是"按星期分组显示一周课表"，所以给 day_of_week 建索引。
-- （数据量小的时候用不到，但索引是"以后数据多了不用回头改"的保险）
CREATE INDEX idx_courses_day ON courses (day_of_week);


-- =====================================================================
-- 表 2：ddls（截止任务）
-- ---------------------------------------------------------------------
-- 存的是"一次性的事"——交作业、考试、报名截止。
-- 和 courses 没有外键关联（见文件头第 2 条）。
-- =====================================================================

DROP TABLE IF EXISTS ddls;

CREATE TABLE ddls (
  -- 主键：任务唯一标识，如 'd_m3k8p2q9w1'
  id         TEXT        PRIMARY KEY,

  -- 任务名，如「交数据结构实验报告」
  title      TEXT        NOT NULL
                         CHECK (length(trim(title)) > 0),

  -- 截止日期，格式 'YYYY-MM-DD'
  -- ⚠️ 同样用 TEXT 保持和前端一致（不用 DATE 类型）
  due_date   TEXT        NOT NULL,

  -- 截止时刻，格式 'HH:MM'。允许空字符串 —— 表示"当天结束前"，
  -- 不写具体几点。所以这里**没有 NOT NULL 之外的额外约束**。
  due_time   TEXT        NOT NULL DEFAULT '',

  -- 备注，可为空
  note       TEXT        NOT NULL DEFAULT '',

  -- 是否已完成。默认 false（新建的都是没做完的）
  done       BOOLEAN     NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  ddls            IS 'DDL 表：一次性的截止任务；与 courses 无外键关联';
COMMENT ON COLUMN ddls.id         IS '主键，形如 d_m3k8p2q9w1';
COMMENT ON COLUMN ddls.title      IS '任务名，不能为空';
COMMENT ON COLUMN ddls.due_date   IS '截止日期，YYYY-MM-DD';
COMMENT ON COLUMN ddls.due_time   IS '截止时刻 HH:MM，空字符串=当天结束前';
COMMENT ON COLUMN ddls.note       IS '备注，可为空';
COMMENT ON COLUMN ddls.done       IS '是否已完成，默认 false';
COMMENT ON COLUMN ddls.created_at IS '创建时间（带时区）';
COMMENT ON COLUMN ddls.updated_at IS '最后修改时间（带时区）';

-- 索引：最常用的查询是"按截止时间排序，看最近要交的"
CREATE INDEX idx_ddls_due ON ddls (due_date);

-- 另一个常用查询："只看没做完的"（done = false）
-- 这是个部分索引 —— 只给未完成的行建，比全表索引更小更快
CREATE INDEX idx_ddls_pending ON ddls (due_date) WHERE done = false;


-- =====================================================================
-- 执行完检查一下
-- ---------------------------------------------------------------------
-- 想看表建成了没：
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public' ORDER BY table_name;
--
-- 想看某张表的字段和类型：
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'courses' ORDER BY ordinal_position;
--
-- 想看索引：
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE schemaname = 'public' AND tablename = 'courses';
-- =====================================================================
