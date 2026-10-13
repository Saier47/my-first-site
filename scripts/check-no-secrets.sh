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
#
# ⚠️ Day 23 加练：这条规则**会误报**。
#    它只认"eyJ 开头、三段点分"的形状，不看上下文 ——
#    Day 23 写 audit-secrets.py 的自检样本时就撞上了：
#    含假样本的文件被它报成"发现 JWT"（其实全是编的）。
#    现在处理办法：
#      · 白名单放行占位符与文档里写的省略式示例（和 audit-secrets.py 保持一致）
#      · 真密钥的判定交给 audit-secrets.py（8 类规则，更细）
#    这条留着当一道**粗筛**：宁可多报一次让人确认，也不要漏。
echo "  扫描整个仓库找 JWT 形状的字符串……"
HITS=$("$PY" - <<'PYEOF'
import os, re
JWT = re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')
SKIP_DIRS = {'.git', 'node_modules', '.secrets', 'docs'}
# 白名单：占位符与文档式示例，出现这些不算泄露
ALLOW = ('__INJECTED_BY_SCRIPT__', 'eyJhbGciOi...', 'your-key-here', 'YOUR_KEY', '<API Key>')
# 有更高优先级的排查工具（audit-secrets.py）时，这条只是粗筛：
# 它自己写着规则文本，跳过它，免得"检查工具被自己检查"。
SKIP_FILES = {'audit-secrets.py'}
hits = []
for root, dirs, files in os.walk('.'):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for f in files:
        if f.endswith(('.png', '.jpg', '.ico', '.zip')): continue
        if f in SKIP_FILES: continue
        p = os.path.join(root, f)
        try:
            t = open(p, encoding='utf-8', errors='ignore').read()
        except Exception:
            continue
        for line in t.splitlines():
            if any(a in line for a in ALLOW): continue
            if JWT.search(line):
                hits.append(p)
                break
for h in sorted(set(hits)):
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

# 检查 4：.env 及同类本地机密文件 —— Day 23 新增
#
# 为什么原来没有这一条（是个真缺口）：
#   检查 1/2/3 覆盖的是「cloudbaserc.json 被灌 Key」「仓库里有 JWT」「.secrets 被忽略」，
#   但**从没验过 .env 本身**。
#   .gitignore 里写没写 `.env`、和 .env **实际有没有被 git 跟踪**，是两件事 ——
#   如果曾经 `git add -f` 强加过一次，.gitignore 就形同虚设，之后每次提交都跟着走。
#   （本项目的铁律：**「文件里写了」≠「真的生效」**。）
echo "  检查 .env 等本地机密文件是否被 git 跟踪……"
TRACKED=$("D:/Git/cmd/git.exe" ls-files 2>/dev/null | grep -E '(^|/)\.env($|\.)|apikey|\.secrets/' || true)
if [ -z "$TRACKED" ]; then
  echo "  ✅ 没有被跟踪的 .env / apikey / .secrets 文件"
else
  echo "  ❌ 这些本地机密文件竟然进了 git！立刻处理（git rm --cached <文件>）："
  echo "$TRACKED" | sed 's/^/     /'
  FOUND=1
fi

# 检查 5：.env 若存在，必须命中 .gitignore —— Day 23 新增
#
# 检查 4 看的是"有没有被跟踪"，这条看的是"忽略规则有没有真的在拦"。
# 两条互补：一个防已发生的事，一个防未发生的事。
for f in .env .env.local .secrets/apikey.txt; do
  if [ -f "$f" ]; then
    if D:/Git/cmd/git.exe check-ignore -q "$f" 2>/dev/null; then
      echo "  ✅ $f 存在且已被忽略"
    else
      echo "  ❌ $f 存在，但【没被忽略】！马上加进 .gitignore"
      FOUND=1
    fi
  fi
done

echo ""
if [ "$FOUND" -eq 0 ]; then
  echo "✅ 自查通过，可以提交。"
  exit 0
else
  echo "❌ 发现风险，已阻止提交。"
  exit 1
fi
