#!/bin/bash
# =====================================================================
# run-sql.sh —— 把 db/ 目录下的 .sql 文件执行到 CloudBase PostgreSQL
# ---------------------------------------------------------------------
# 用法：
#   bash db/run-sql.sh schema.sql      # 建表
#   bash db/run-sql.sh seed.sql        # 灌种子数据
#   bash db/run-sql.sh schema.sql seed.sql   # 按顺序跑多个文件
#
# ---------------------------------------------------------------------
# 🔴 为什么需要这个脚本（Day 16 踩的坑，别再摸一遍）
#
# 直接这样跑是**不行的**：
#     tcb db execute --sql "$(cat db/schema.sql)"
#
# 因为 CLI 对 --sql 参数的两个限制：
#   1. **不接受换行** —— 参数里有 \n 就直接报
#      "Please specify the SQL statement to execute with --sql"
#      而它**退出码仍是 0**，看起来像成功了 → 静默失败。
#   2. **不接受行注释** —— `-- 注释` 会把后面的内容也吞掉或报错。
#
# 所以本脚本做两件事：
#   · 删掉 `--` 开头的行注释（保留代码里的注释请用 /* */ 或改写）
#   · 把所有换行压成空格，拼成一整行
#
# ⚠️ 另一个坑：**CLI 会把 SQL 错误吞掉**
#    多语句执行时如果某句报错，CLI 依然打印 "Affected rows: 0, completed in Xms"。
#    → 所以执行完**必须自己查一遍**（本脚本最后会打印表清单）。
# =====================================================================

set -u

ENV_ID="${TCB_ENV_ID:-my-first-site-d0g3re4p71560e327}"
TCB="${TCB_BIN:-C:/Users/admin/AppData/Roaming/npm/tcb.cmd}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# 跑「查询类」SQL（verify.sql 这种）时，把输出完整打出来。
# 默认只 tail -12，是因为建表/灌种子的日志很长；但查询结果会被截掉。
# 用法：VERIFY=1 bash db/run-sql.sh verify.sql
TAIL_N=12
if [ "${VERIFY:-0}" = "1" ]; then
  TAIL_N=200
fi

if [ $# -eq 0 ]; then
  echo "用法: bash db/run-sql.sh <文件名.sql> [更多文件...]"
  echo "例:   bash db/run-sql.sh schema.sql seed.sql"
  exit 1
fi

for FILE in "$@"; do
  FULL="$DIR/$FILE"
  if [ ! -f "$FULL" ]; then
    echo "✗ 文件不存在：$FULL"
    exit 1
  fi

  echo "=== 执行 $FILE ==="

  # 1) 删注释（字符串感知）  2) 按 ; 切分逐条执行
  #    ⚠️ 块注释必须处理：verify.sql 用 /* */ 写说明，若不删，
  #       压成单行后块注释里的字会被当成 SQL，报 syntax error。
  #    ⚠️ 必须逐条执行：tcb db execute 传多语句时**只返回最后一条的结果**，
  #       4 条 SELECT 会只剩 1 条输出，看起来像"只有一条查询生效"。
  #    🔴 剥注释**不能用朴素正则** `--.*$`：
  #       SQL 里 `'--:--'` 这种占位符和行注释语法撞车，正则会把字符串
  #       连引号一起吃掉 → 引号不配对 → "syntax error at or near ..."。
  #       必须用字符串感知扫描：只在「不在 '...' 里」时才认 -- 和 /* */。
  PY="${PY_BIN:-C:/Users/admin/AppData/Local/Programs/Python/Python312/python.exe}"
  "$PY" -c "
import sys, re, subprocess

def strip_comments(text):
    out, i, n = [], 0, len(text)
    in_str = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == chr(39):                 # 单引号：退出字符串
                if i + 1 < n and text[i+1] == chr(39):
                    out.append(text[i+1]); i += 2   # 转义 ''
                    continue
                in_str = False
            i += 1
            continue
        if c == chr(39):
            in_str = True; out.append(c); i += 1; continue
        if c == '-' and i + 1 < n and text[i+1] == '-':
            while i < n and text[i] != chr(10):
                i += 1
            continue
        if c == '/' and i + 1 < n and text[i+1] == '*':
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        out.append(c); i += 1
    return ''.join(out)

src = strip_comments(open(sys.argv[1], encoding='utf-8').read())
stmts = [re.sub(r'\s+', ' ', s).strip() for s in src.split(';')]
stmts = [s for s in stmts if s]
tail_n = int(sys.argv[4])
for i, s in enumerate(stmts, 1):
    print('--- 第 %d/%d 条 ---' % (i, len(stmts)))
    print('SQL: ' + (s[:90] + ('...' if len(s) > 90 else '')))
    p = subprocess.run([sys.argv[3], 'db', 'execute', '-e', sys.argv[2],
                        '--sql', s, '--json'], capture_output=True, text=True)
    out = (p.stdout or '') + (p.stderr or '')
    if 'DatabaseSqlSyntaxError' in out or 'DatabaseSqlExecutionError' in out:
        print('  ✗ 报错：' + out[:400])
    else:
        print('\n'.join(out.splitlines()[-tail_n:]))
    print()
" "$FULL" "$ENV_ID" "$TCB" "$TAIL_N"
done

# =====================================================================
# 执行后核对 —— 这一步不能省（CLI 会吞错误）
# =====================================================================
echo ""
echo "=== 核对：当前 public schema 里的表 ==="
"$TCB" db execute -e "$ENV_ID" \
  --sql "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name" \
  --json 2>&1 | tail -20

echo ""
echo "=== 核对：每张表的行数 ==="
"$TCB" db execute -e "$ENV_ID" \
  --sql "SELECT relname AS table_name, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY relname" \
  --json 2>&1 | tail -20
