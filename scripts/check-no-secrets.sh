#!/bin/bash
# =====================================================================
# check-no-secrets.sh —— 提交前的密钥泄露自查
# ---------------------------------------------------------------------
# 为什么需要它：
#   部署云函数时必须把真 Key 注入 cloudbaserc.json，
#   但那个文件**是要提交的**。
#   人总会忘 —— 部署完忘了还原，一个 `git add .` 就把 Key 推上 GitHub 了。
#
#   与其指望"记得还原"，不如让机器每次都查一遍。
#
# 用法：
#   bash scripts/check-no-secrets.sh          # 手动查（收工前跑）
#   也可以装成 git pre-commit 钩子，提交时自动查：
#     bash scripts/check-no-secrets.sh --install-hook
#
# 退出码：0 = 干净；1 = 发现密钥（应阻止提交）
# =====================================================================

set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

PY="${PY_BIN:-C:/Users/admin/AppData/Local/Programs/Python/Python312/python.exe}"

# ------------------------------------------------------------ 安装钩子
if [ "${1:-}" = "--install-hook" ]; then
  HOOK="$DIR/.git/hooks/pre-commit"
  cat > "$HOOK" <<'HOOKEOF'
#!/bin/bash
# 提交前自动查密钥泄露（由 scripts/check-no-secrets.sh 安装）
exec bash "$(dirname "$0")/../../scripts/check-no-secrets.sh"
HOOKEOF
  chmod +x "$HOOK"
  echo "✅ 已安装 pre-commit 钩子 → $HOOK"
  echo "   以后每次 git commit 都会先跑一遍密钥检查。"
  exit 0
fi

# ------------------------------------------------------------ 执行检查
echo "=== 密钥泄露自查 ==="
FOUND=0

# 检查 1：cloudbaserc.json 里是否是真实 Key（而不是占位符）
if [ -f cloudbaserc.json ]; then
  RES=$("$PY" -c "
import re
s = open('cloudbaserc.json', encoding='utf-8').read()
m = re.search(r'\"CLOUDBASE_API_KEY\"\s*:\s*\"([^\"]*)\"', s)
if not m:
    print('ok-no-field')
elif m.group(1) == '__INJECTED_BY_SCRIPT__':
    print('ok-placeholder')
elif re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', m.group(1)):
    print('LEAK-real-key')
else:
    print('warn-unexpected:' + m.group(1)[:20])
" 2>&1)
  case "$RES" in
    ok-placeholder) echo "  ✅ cloudbaserc.json 是占位符" ;;
    ok-no-field)    echo "  · cloudbaserc.json 里没有该字段" ;;
    LEAK-real-key)
      echo "  ❌ cloudbaserc.json 里是【真实 Key】！提交前必须还原："
      echo "     bash scripts/inject-key.sh --restore"
      FOUND=1 ;;
    *) echo "  ⚠️ cloudbaserc.json 里该字段值异常：$RES"; FOUND=1 ;;
  esac
fi

# 检查 2：整个仓库里有没有 JWT 形状的字符串（除 .secrets 外）
echo "  扫描整个仓库找 JWT 形状的字符串……"
HITS=$("$PY" - <<'PYEOF'
import os, re
JWT = re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')
SKIP_DIRS = {'.git', 'node_modules', '.secrets', 'docs'}
hits = []
for root, dirs, files in os.walk('.'):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for f in files:
        if f.endswith(('.png', '.jpg', '.ico', '.zip')): continue
        p = os.path.join(root, f)
        try:
            t = open(p, encoding='utf-8', errors='ignore').read()
        except Exception:
            continue
        for m in JWT.finditer(t):
            hits.append(p)
            break
for h in hits:
    print(h)
PYEOF
)
  if [ -z "$HITS" ]; then
    echo "  ✅ 没发现裸露的 JWT"
  else
    echo "  ❌ 在这些文件里发现 JWT 形状的字符串："
    echo "$HITS" | sed 's/^/     /'
    FOUND=1
  fi

# 检查 3：.secrets 目录是否确实被 git 忽略
if D:/Git/cmd/git.exe check-ignore -q .secrets/apikey.txt 2>/dev/null; then
  echo "  ✅ .secrets/ 已被 git 忽略"
else
  echo "  ❌ .secrets/ 竟然没被忽略！检查 .gitignore"
  FOUND=1
fi

echo ""
if [ "$FOUND" -eq 0 ]; then
  echo "✅ 自查通过，可以提交。"
  exit 0
else
  echo "❌ 发现风险，已阻止提交。"
  exit 1
fi
