#!/usr/bin/env bash
# Day 9｜设计审查一键运行脚本
# ---------------------------------------------------------------------------
# 用法：  bash run-audit.sh
#
# 为什么要有这个脚本：直接跑 Edge 无头有 4 个坑，踩过一次就别再踩第二次：
#   1. 必须给 --user-data-dir 独立 profile，否则会和系统里残留的
#      msedgewebview2 进程抢锁，**静默失败**（不报错，但什么都不生成）
#   2. --virtual-time-budget 会把 setTimeout 快进，但 mock 数据的 600ms 延时
#      依赖 Promise 链，会被跳过 → 量到一堆"元素不存在"
#   3. 因此审查页 audit-page.html 必须用「延迟归零」的版本来跑（见下方 sed）
#   4. --dump-dom 输出很长，用 sed 只取结果段
#
# 本机路径约定：
#   Edge  : C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe
#   Python: C:/Users/admin/AppData/Local/Programs/Python/Python312/python.exe
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PY="C:/Users/admin/AppData/Local/Programs/Python/Python312/python.exe"
PROFILE="C:/Users/admin/AppData/Local/Temp/edge-audit-profile"
PORT="${PORT:-8010}"

mkdir -p "$PROFILE"

# ---- 1. 确认服务在跑 ----
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html"; then
  echo "本地服务没在 $PORT 端口跑。先执行："
  echo "  cd \"$DIR\" && python -m http.server $PORT --bind 127.0.0.1"
  exit 1
fi

# ---- 2. 用延迟归零的 mock 生成一份审查页 ----
"$PY" -X utf8 - <<'PYEOF'
s = open('index.html', encoding='utf-8').read()
if '<script src="audit-probe.js">' not in s:
    s = s.replace('</body>', '  <script src="audit-probe.js"></script>\n</body>')
open('audit-page.html', 'w', encoding='utf-8').write(s)

# 延迟归零版：只给审查用，不改产品
m = open('mock-data.js', encoding='utf-8').read()
m = m.replace('var FAKE_DELAY_MS = 600;', 'var FAKE_DELAY_MS = 0;')
open('.mock-audit.js', 'w', encoding='utf-8').write(m)
s2 = s.replace('<script src="mock-data.js"></script>', '<script src=".mock-audit.js"></script>')
open('.audit-fast.html', 'w', encoding='utf-8').write(s2)
print('审查页已生成（延迟归零版：.audit-fast.html）')
PYEOF

# ---- 3. 跑审查 ----
echo
echo "================ 设计审查结果 ================"
"$EDGE" --headless=new --disable-gpu --no-sandbox --user-data-dir="$PROFILE" \
  --window-size=1280,1600 --virtual-time-budget=12000 \
  --dump-dom "http://127.0.0.1:$PORT/.audit-fast.html" 2>/dev/null \
  | sed -n '/检查 5/,$p' \
  | sed 's/<\/pre><\/html>//'

# ---- 4. 清理临时页 ----
rm -f .audit-fast.html .mock-audit.js
