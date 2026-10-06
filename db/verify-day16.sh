#!/bin/bash
# =====================================================================
# verify-day16.sh —— Day 16 真库验证（bash 驱动）
# ---------------------------------------------------------------------
# 为什么单独有这个脚本：
#   check-day16.js 只能验文件（静态层），因为**本机沙箱禁止 Node 派生
#   任何子进程**（连 node 派生 node 都抛 spawnSync EBUSY），而调 tcb
#   必然要起子进程。bash 没这个限制，所以真库层放这里。
#
# 验什么（全部直连真库，不信任何脚本的输出）：
#   1. courses / ddls 两张表真的存在
#   2. 每张表都有 ≥ 5 行（今日完成标准）
#   3. 字段数 / 字段名对得上
#   4. CHECK 约束真在库里（查 pg_constraint，不是看 SQL 文件）
#   5. 三个索引真的建了
#   6. 四条 select 查询都能出结果，且结果正确
#
# 跑法：
#   bash db/verify-day16.sh
# 退出码：0 = 全过；1 = 有失败
# =====================================================================

set -u
export PATH="${PATH}:/d"          # tcb.cmd 需要 node 在 PATH 里

ENV_ID="${TCB_ENV_ID:-my-first-site-d0g3re4p71560e327}"
TCB="${TCB_BIN:-C:/Users/admin/AppData/Roaming/npm/tcb.cmd}"
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE_BIN:-D:/node.exe}"

PASS=0
FAIL=0
FAIL_MSGS=""

# 执行一条 SQL，输出「行数组」的 JSON，每行形如 ["值1","值2"]
#
# 🔴 为什么带重试（Day 17 实测出来的）：
#    本脚本 43 项断言要起几十次 tcb 进程、每次都是一个网络请求。
#    实测连跑时，偶尔某次请求会抖动（返回空或非 JSON）→ 断言莫名其妙变红，
#    而重跑一次又全绿。**"会自己变红的测试，久了你就不看它了"** ——
#    所以这里对失败自动重试 3 次，把网络抖动和真实故障区分开。
q() {
  local attempt out
  for attempt in 1 2 3; do
    out="$("$TCB" db execute -e "$ENV_ID" --sql "$1" --json 2>&1 \
      | "$NODE" -e "
let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) { console.log('__ERR__ 无JSON'); return; }
  let j; try { j = JSON.parse(m[0]); } catch(e) { console.log('__ERR__ 解析失败'); return; }
  if (j.error) { console.log('__ERR__ ' + j.error.code + ': ' + (j.error.message||'').slice(0,150)); return; }
  const rows = (j.data && j.data.Rows) || [];
  rows.forEach(r => { try { console.log(JSON.parse(r).join('\t')); } catch(e){} });
});
")"
    # 没拿到 __ERR__ 就认为成功（空结果也是合法结果，交给断言去判）
    case "$out" in
      *'__ERR__'*) sleep 2; continue ;;
      *)           break ;;
    esac
  done
  printf '%s\n' "$out"
}

ok() {  # ok "名称" "条件返回值 0=通过"
  if [ "$2" = "0" ]; then
    PASS=$((PASS+1)); echo "  ✅ $1"
  else
    FAIL=$((FAIL+1)); FAIL_MSGS="${FAIL_MSGS}
  ✗ $1${3:+ → $3}"; echo "  ✗ $1${3:+ → $3}"
  fi
}

# 判断某个值是否在 q() 输出的某列出现过
has_value() {  # has_value "SQL" "列号(从1起)" "期望值"
  local rows; rows="$(q "$1")"
  echo "$rows" | awk -F'\t' -v c="$2" -v v="$3" '$c==v{f=1} END{exit f?0:1}'
}

echo "========================================"
echo "Day 16 真库验证 —— 表 / 行数 / 约束 / 索引 / 查询"
echo "========================================"
echo ""

# ---------------------------------------------------------------- 1 表存在
echo "【1】表存在性（查 information_schema）"
ROWS_TABLES="$(q "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")"
if [ -z "$ROWS_TABLES" ] || echo "$ROWS_TABLES" | grep -q '__ERR__'; then
  ok "能连上数据库" 1 "$(echo "$ROWS_TABLES" | head -1)"
  echo ""
  echo "数据库连不上，后续全部跳过。"
  echo "========================================"
  echo "通过 ${PASS} 项，失败 ${FAIL} 项${FAIL_MSGS}"
  exit 1
fi
ok "能连上数据库" 0

echo "$ROWS_TABLES" | grep -qx "courses"; ok "库里有 courses 表" $?
echo "$ROWS_TABLES" | grep -qx "ddls";    ok "库里有 ddls 表" $?

# -------------------------------------------------------------- 2 行数 ≥ 5
echo ""
echo "【2】行数（今日完成标准：每张核心表 ≥ 5 行）"
C_ROWS="$(q "SELECT count(*) FROM courses" | head -1)"
D_ROWS="$(q "SELECT count(*) FROM ddls" | head -1)"
[ "${C_ROWS:-0}" -ge 5 ] 2>/dev/null; ok "courses ≥ 5 行" $? "实际 ${C_ROWS:-?} 行"
[ "${D_ROWS:-0}" -ge 5 ] 2>/dev/null; ok "ddls ≥ 5 行" $? "实际 ${D_ROWS:-?} 行"

# ----------------------------------------------------------------- 3 字段
echo ""
echo "【3】字段结构"
C_COLS="$(q "SELECT column_name FROM information_schema.columns WHERE table_name='courses' ORDER BY ordinal_position" | tr '\n' ',')"
D_COLS="$(q "SELECT column_name FROM information_schema.columns WHERE table_name='ddls' ORDER BY ordinal_position" | tr '\n' ',')"
for f in id name day_of_week start_time end_time location created_at updated_at; do
  echo "$C_COLS" | grep -q "$f,"; ok "courses.$f 存在" $?
done
for f in id title due_date due_time note done created_at updated_at; do
  echo "$D_COLS" | grep -q "$f,"; ok "ddls.$f 存在" $?
done

# -------------------------------------------------------------- 4 约束生效
echo ""
echo "【4】CHECK 约束真的在库里（查 pg_constraint，不看 SQL 文件）"
C_CONS="$(q "SELECT conname FROM pg_constraint WHERE conrelid = 'courses'::regclass" | tr '\n' ',')"
echo "$C_CONS" | grep -q "courses_pkey";            ok "courses 主键约束" $?
echo "$C_CONS" | grep -q "courses_day_of_week_check"; ok "day_of_week 1–7 CHECK 约束" $?
echo "$C_CONS" | grep -q "courses_name_check";      ok "name 禁空格 CHECK 约束" $?

D_CONS="$(q "SELECT conname FROM pg_constraint WHERE conrelid = 'ddls'::regclass" | tr '\n' ',')"
echo "$D_CONS" | grep -q "ddls_pkey"; ok "ddls 主键约束" $?

# ------------------------------------------------- 4b 约束真的拦得住坏数据
# 只查「约束存在」不够 —— 得实测它真的会拒绝坏数据。
# 三条故意写错的 INSERT，期望全部被拒，且**一行都不能落库**。
echo ""
echo "【4b】实测约束拦得住坏数据（故意塞错数据，期望被拒）"

# 执行一条「应该失败」的 SQL；返回 0 表示确实失败了（=通过）
should_reject() {
  local out; out="$("$TCB" db execute -e "$ENV_ID" --sql "$1" --json 2>&1)"
  echo "$out" | grep -qE 'violates check constraint|duplicate key value violates|PGExecuteSqlError|DatabaseSqlExecutionError'
}

should_reject "INSERT INTO courses (id,name,day_of_week,start_time,end_time) VALUES ('c_bad_wd','测试',9,'08:00','09:40')"
ok "day_of_week=9 被拒" $?
should_reject "INSERT INTO courses (id,name,day_of_week,start_time,end_time) VALUES ('c_bad_nm','   ',1,'08:00','09:40')"
ok "name 全空格被拒" $?
should_reject "INSERT INTO courses (id,name,day_of_week,start_time,end_time) VALUES ('c_seed_01','重复主键',1,'08:00','09:40')"
ok "重复主键被拒" $?

# 关键：确认坏数据一行都没进去（不然「被拒」是假的）
BAD_LEFT="$(q "SELECT count(*) FROM courses WHERE id IN ('c_bad_wd','c_bad_nm')" | head -1)"
[ "${BAD_LEFT:-1}" = "0" ]; ok "坏数据一行都没落库" $? "残留 ${BAD_LEFT:-?} 行"

# ---------------------------------------------------------------- 5 索引
echo ""
echo "【5】索引"
IDX="$(q "SELECT indexname FROM pg_indexes WHERE tablename IN ('courses','ddls')" | tr '\n' ',')"
echo "$IDX" | grep -q "idx_courses_day";   ok "courses 星期索引" $?
echo "$IDX" | grep -q "idx_ddls_due";      ok "ddls 截止日索引" $?
echo "$IDX" | grep -q "idx_ddls_pending";  ok "ddls 未完成任务的部分索引" $?

# ------------------------------------------------------- 6 四条 select 验证
echo ""
echo "【6】select 验证（页面上要什么，数据库给不给得出）"

# Q1 周课表视图
Q1="$(q "SELECT day_of_week, start_time, name FROM courses ORDER BY day_of_week, start_time")"
Q1_N="$(echo "$Q1" | grep -c .)"
[ "$Q1_N" -ge 5 ]; ok "Q1 周课表视图有数据" $? "返回 $Q1_N 行"
# 排序正确性：用 awk 检查排序键单调不减
echo "$Q1" | awk -F'\t' 'NF>=3{k=$1*10000+$2; gsub(":","",k); if(NR>1 && k+0 < prev+0) bad=1; prev=k} END{exit bad?1:0}'
ok "Q1 按「星期+时刻」升序排好" $?

# Q2 DDL 三态状态判定
Q2="$(q "SELECT CASE WHEN done THEN 'completed' WHEN due_date < to_char(now(),'YYYY-MM-DD') THEN 'overdue' ELSE 'pending' END AS status FROM ddls")"
Q2_N="$(echo "$Q2" | grep -c .)"
[ "$Q2_N" -ge 5 ]; ok "Q2 状态判定有数据" $? "返回 $Q2_N 行"
echo "$Q2" | grep -qx "completed"; ok "Q2 有 completed 样本" $?
echo "$Q2" | grep -qx "overdue";   ok "Q2 有 overdue 样本" $?
echo "$Q2" | grep -qx "pending";   ok "Q2 有 pending 样本" $?

# Q3 只取未完成
Q3="$(q "SELECT due_date, GREATEST(0, to_date(to_char(now(),'YYYY-MM-DD'),'YYYY-MM-DD') - to_date(due_date,'YYYY-MM-DD')) AS days_late FROM ddls WHERE done = false ORDER BY due_date, due_time LIMIT 5")"
Q3_N="$(echo "$Q3" | grep -c .)"
[ "$Q3_N" -ge 1 ] && [ "$Q3_N" -le 5 ]; ok "Q3 只取未完成且 ≤5 条" $? "返回 $Q3_N 条"
echo "$Q3" | awk -F'\t' 'NF>=2 && $2+0 < 0 {bad=1} END{exit bad?1:0}'
ok "Q3 逾期天数非负" $?

# Q4 两表合并（核心卖点）
Q4="$(q "SELECT kind, sort_key FROM (SELECT 'course' AS kind, day_of_week*10000 + CAST(replace(start_time,':','') AS int) AS sort_key FROM courses UNION ALL SELECT 'ddl' AS kind, 900000 AS sort_key FROM ddls WHERE done = false) t ORDER BY sort_key")"
echo "$Q4" | awk -F'\t' '$1=="course"{c=1} $1=="ddl"{d=1} END{exit (c&&d)?0:1}'
ok "Q4 结果里同时有课程和 DDL" $?
echo "$Q4" | awk -F'\t' 'NF>=2{if(NR>1 && $2+0 < prev+0) bad=1; prev=$2} END{exit bad?1:0}'
ok "Q4 两表合到同一条轴且有序（核心卖点成立）" $?
echo "$Q4" | head -1 | grep -q "^course"; ok "Q4 课程排在 DDL 之前" $?

# ------------------------------------------------------------------ 汇总
echo ""
echo "========================================"
echo "通过 ${PASS} 项，失败 ${FAIL} 项"
if [ "$FAIL" -gt 0 ]; then
  echo "失败明细：${FAIL_MSGS}"
fi
echo "========================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
