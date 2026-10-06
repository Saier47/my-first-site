#!/bin/bash
# =====================================================================
# inject-key.sh —— 把 API Key 从本地密钥文件注入 cloudbaserc.json
# ---------------------------------------------------------------------
# 为什么需要这个脚本（而不是直接把 Key 写进 cloudbaserc.json）：
#
#   cloudbaserc.json 是**要进 git 的**（它是部署配置，别人 clone 下来要用）。
#   如果 Key 直接写在里面 → 一提交就永久留在 GitHub 上。
#
#   所以用「模板 + 注入」两段式：
#     · cloudbaserc.json 进 git，里面写占位符 __INJECTED_BY_SCRIPT__
#     · 本脚本读 .secrets/apikey.txt（不进 git），把占位符换成真 Key
#     · 部署完成后用 `bash scripts/inject-key.sh --restore` 还原成占位符
#
# 用法：
#   bash scripts/inject-key.sh            # 注入（部署前跑）
#   bash scripts/inject-key.sh --restore  # 还原成占位符（提交前跑）
# =====================================================================

set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$DIR/cloudbaserc.json"
SECRET_FILE="$DIR/.secrets/apikey.txt"
PLACEHOLDER="__INJECTED_BY_SCRIPT__"

PY="${PY_BIN:-C:/Users/admin/AppData/Local/Programs/Python/Python312/python.exe}"

# ---------------------------------------------------------------- 还原模式
if [ "${1:-}" = "--restore" ]; then
  "$PY" -c "
import sys, json
p = sys.argv[1]; ph = sys.argv[2]
s = open(p, encoding='utf-8').read()
# 用正则替换（不解析 JSON，保留原格式和注释）
import re
s = re.sub(r'\"CLOUDBASE_API_KEY\"\s*:\s*\"[^\"]*\"', '\"CLOUDBASE_API_KEY\": \"' + ph + '\"', s)
open(p, 'w', encoding='utf-8').write(s)
print('✅ 已还原为占位符（可以安全提交了）')
" "$CONF" "$PLACEHOLDER"
  exit 0
fi

# ---------------------------------------------------------------- 注入模式
if [ ! -f "$SECRET_FILE" ]; then
  echo "❌ 找不到密钥文件：$SECRET_FILE"
  echo "   请先把 API Key 存进去（只留一行，不要引号不要空格）"
  exit 1
fi

KEY=$("$PY" -c "
import re, sys
lines = [l.strip() for l in open(sys.argv[1], encoding='utf-8') if l.strip()]
for l in lines:
    if re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', l):
        print(l); break
" "$SECRET_FILE")

if [ -z "$KEY" ]; then
  echo "❌ 密钥文件里没找到 JWT 形状的 Key（形如 xxx.yyy.zzz）"
  exit 1
fi

"$PY" -c "
import sys, re
p, key, ph = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
s = re.sub(r'\"CLOUDBASE_API_KEY\"\s*:\s*\"[^\"]*\"', '\"CLOUDBASE_API_KEY\": \"' + key + '\"', s)
open(p, 'w', encoding='utf-8').write(s)
print('✅ 已注入 Key（长度 %d）→ %s' % (len(key), p))
print('   ⚠️ 部署完记得跑：bash scripts/inject-key.sh --restore')
" "$CONF" "$KEY" "$PLACEHOLDER"
