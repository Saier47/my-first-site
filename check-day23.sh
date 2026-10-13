#!/bin/bash
# =====================================================================
# check-day23.sh —— Day 23 完整自检（bash 驱动）
# ---------------------------------------------------------------------
# 为什么还需要一个 bash 壳：
#   check-day23.js 覆盖了静态层 + 联网层，但**跑不了**两件事 ——
#   真跑一遍 `check-no-secrets.sh`、真跑一遍 `audit-secrets.py`。
#   因为本沙箱**禁止 Node 派生任何子进程**（execFileSync → EBUSY，
#   连 node→node 都失败）。而 **bash 起子进程是正常的** ——
#   所以由 bash 来当那个"能起进程的人"。
#
# 跑法：bash check-day23.sh
# 退出码：0 = 全绿
# =====================================================================

set -u
export PATH="/usr/bin:/bin:/c/Windows/system32:/c/Windows:/d"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PY="C:/Users/admin/AppData/Local/Programs/Python/Python312/python.exe"
NODE="D:/node.exe"

PASS=0
FAIL=0
FAILURES=""

check() {
  # $1 = 描述；$2 = 条件结果（0 为真）
  if [ "$2" -eq 0 ]; then
    PASS=$((PASS+1)); echo "  ✅ $1"
  else
    FAIL=$((FAIL+1)); FAILURES="$FAILURES\n  · $1"
    echo "  ✗ $1"
  fi
}

echo "========================================"
echo "Day 23 完整自检（bash 驱动）"
echo "========================================"

# =====================================================================
echo ""
echo "【D】密钥 · 真跑一遍自查脚本"
# =====================================================================
COUT="$(bash scripts/check-no-secrets.sh 2>&1)"
CCODE=$?
check "D1 自查脚本退出码 0" "$([ "$CCODE" -eq 0 ] && echo 0 || echo 1)"
check "D2 输出里有「✅ 自查通过」" "$(echo "$COUT" | grep -q '自查通过' && echo 0 || echo 1)"
check "D3 输出里无「❌」" "$(echo "$COUT" | grep -q '❌' && echo 1 || echo 0)"
NCHECK=$(echo "$COUT" | grep -c '^  ✅')
check "D4 ★ 覆盖 ≥5 项检查（实际 $NCHECK 项）" "$([ "$NCHECK" -ge 5 ] && echo 0 || echo 1)"
echo "  --- 自查脚本原样输出 ---"
echo "$COUT" | sed 's/^/      /'

# =====================================================================
echo ""
echo "【E】密钥 · 工作区 + git 全历史 真扫"
# =====================================================================
AOUT="$("$PY" audit-secrets.py 2>&1)"
ACODE=$?
check "E1 独立扫描器退出码 0" "$([ "$ACODE" -eq 0 ] && echo 0 || echo 1)"
check "E2 ★ 工作区命中 0 条" "$(echo "$AOUT" | grep -q '命中 0 条' && echo 0 || echo 1)"
check "E3 ★ git 全历史命中 0 条" "$(echo "$AOUT" | grep -q 'git 全历史' && echo "$AOUT" | tr '\n' ' ' | grep -q 'git 全历史.*命中 0 条' && echo 0 || echo 1)"
check "E4 ★ 合计命中 0 条" "$(echo "$AOUT" | grep -q '合计命中：0 条' && echo 0 || echo 1)"

# =====================================================================
echo ""
echo "【E5】扫描器自检 —— 证明它会扫（不是个只会说 OK 的摆设）"
# =====================================================================
SOUT="$("$PY" audit-secrets.py --selftest 2>&1)"
SCODE=$?
check "E5 扫描器自检退出码 0" "$([ "$SCODE" -eq 0 ] && echo 0 || echo 1)"
check "E6 ★ 8 类假样本全部命中" "$(echo "$SOUT" | grep -q '自检结果：✅ 通过' && echo 0 || echo 1)"

# =====================================================================
echo ""
echo "【F】JS 静态层 + 联网层（check-day23.js）"
# =====================================================================
NOUT="$("$NODE" check-day23.js 2>&1)"
NCODE=$?
echo "$NOUT" | tail -12 | sed 's/^/  /'
check "F1 check-day23.js 退出码 0" "$([ "$NCODE" -eq 0 ] && echo 0 || echo 1)"

# =====================================================================
echo ""
echo "========================================"
TOTAL=$((PASS+FAIL))
echo "  bash 层：通过 $PASS 项，失败 $FAIL 项"
echo "========================================"
if [ "$FAIL" -ne 0 ]; then
  echo -e "失败明细：$FAILURES"
  exit 1
fi
echo ""
echo "📌 三处密钥扫描（工作区 / git 全历史 / 自查脚本）全部 0 命中，"
echo "   且扫描器自检通过 —— 这个 0 是真的 0。"
exit 0
