#!/bin/bash
# =====================================================================
# preflight.sh —— 发布前检查
# ---------------------------------------------------------------------
# 配套规则见：.workbuddy/skills/preflight-check/SKILL.md
#
# 跑法：bash scripts/preflight.sh
# 退出码：0 = 全绿，可以发布；1 = 有项没过
#
# 🔑 设计原则：**每一项都必须"真的能失败"**，而且失败时要带实测值。
#    一个永远输出 ✅ 的检查，和"真的全绿"，在屏幕上长得一模一样。
#    想确认它不是摆设 → 故意弄坏一项，看它红不红（做法见 SKILL.md）。
#
# ⚠️ 为什么是 bash 驱动（而不是纯 Node）：
#    本沙箱禁止 Node 派生任何子进程（execFileSync → EBUSY）。
#    需要起 git / python 的部分只能由 bash 来当那个"能起进程的人"。
# =====================================================================

set -u
export PATH="/usr/bin:/bin:/c/Windows/system32:/c/Windows:/d"

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

NODE="D:/node.exe"
PY="C:/Users/admin/AppData/Local/Programs/Python/Python312/python.exe"
GIT="D:/Git/cmd/git.exe"

WEB="https://my-first-site-d0g3re4p71560e327-1500310885.tcloudbaseapp.com"
API="https://my-first-site-d0g3re4p71560e327-1500310885.ap-shanghai.app.tcloudbase.com"

PASS=0
FAIL=0
FAILED_LIST=""

ok()  { PASS=$((PASS+1)); printf '     ✅  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); FAILED_LIST="${FAILED_LIST}\n  · $1"; printf '     ❌  %s\n' "$1"; }
note(){ printf '         ↳ %s\n' "$1"; }

# =====================================================================
printf '\n'
printf '════════════════════════════════════════════════════════\n'
printf '  发布前检查 · my-first-site\n'
printf '  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
printf '════════════════════════════════════════════════════════\n'

# =====================================================================
printf '\n【1】公网页面能打开\n'
PAGE="$("$NODE" -e "
(async () => {
  try {
    const r = await fetch('$WEB/index.html', { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    console.log([r.status, t.length, t.indexOf('<title>') > -1 ? 1 : 0].join('|'));
  } catch (e) {
    console.log('ERR|' + String(e.message || e).slice(0, 40) + '|0');
  }
})();
" 2>&1 | tail -1)"

IFS='|' read -r P_STATUS P_LEN P_TITLE <<< "$PAGE"
if [ "$P_STATUS" = "200" ] && [ "${P_LEN:-0}" -gt 1000 ] && [ "$P_TITLE" = "1" ]; then
  ok "HTTP $P_STATUS · $P_LEN 字节 · 含 <title>"
else
  bad "页面没打开：状态=$P_STATUS 长度=${P_LEN:-?}（期望 200 + 非空 + 含 <title>）"
fi

# =====================================================================
printf '\n【2】打开的是应用、不是中间页\n'
if [ "$P_STATUS" = "200" ]; then
  CHK="$("$NODE" -e "
(async () => {
  const r = await fetch('$WEB/index.html', { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  const t = await r.text();
  console.log([t.indexOf('这一周') > -1 ? 1 : 0, t.indexOf('页面访问提示') > -1 ? 1 : 0].join('|'));
})();
" 2>&1 | tail -1)"
  IFS='|' read -r IS_APP IS_WARN <<< "$CHK"
  if [ "$IS_APP" = "1" ] && [ "$IS_WARN" = "0" ]; then
    ok "含「这一周」· 不含「页面访问提示」"
  elif [ "$IS_WARN" = "1" ]; then
    bad "拿到的是腾讯云中间页（HTTP 200 但内容不是应用）"
    note "默认域名会插强制提示页，官方写明关不掉；换自定义域名 + 备案才能根治"
  else
    bad "内容里没找到应用特征词「这一周」"
  fi
else
  bad "跳过（第 1 项就没打开）"
fi

# =====================================================================
printf '\n【3】接口活着\n'
APIRES="$("$NODE" -e "
(async () => {
  try {
    const r = await fetch('$API/api/courses', { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    console.log([r.status, j && j.ok === true ? 1 : 0, j && j.data ? j.data.length : -1].join('|'));
  } catch (e) {
    console.log('ERR|0|-1');
  }
})();
" 2>&1 | tail -1)"
IFS='|' read -r A_STATUS A_OK A_LEN <<< "$APIRES"
if [ "$A_STATUS" = "200" ] && [ "$A_OK" = "1" ]; then
  ok "GET /api/courses → $A_STATUS · ok:true · $A_LEN 条"
else
  bad "接口不通：状态=$A_STATUS ok=$A_OK（期望 200 + ok:true）"
fi

# =====================================================================
printf '\n【4】线上前端 == 本地前端（最容易漏的一项）\n'
# 比对逻辑放在独立文件里 —— 原因见脚本头 / 该文件头的注释：
# 内联在 shell 双引号里会偶发什么都不输出（Day 25 实测踩到）。
DIFF_RAW="$("$NODE" scripts/preflight-compare.js "$WEB" 2>/dev/null)"
DIFF_CODE=$?
DIFF="$(printf '%s\n' "$DIFF_RAW" | tail -1)"

if [ -z "$DIFF" ] || [ "$DIFF_CODE" = "2" ]; then
  # ⚠️ 这个分支是 Day 25 补的：**「检查自己没跑起来」≠「文件不一致」**。
  #    原来的写法在拿不到结果时会掉进 else，报成"有 N 个文件不一致" ——
  #    把"尺子坏了"报成"东西坏了"，会让人跑去查代码，其实该查网络。
  #    （这是一个**假红** —— 和 Day 23 那个"假绿"正好是一对。）
  bad "比对没跑起来（退出码 $DIFF_CODE）—— 这既不算通过、也不算不一致"
  note "多半是网络抖动。重跑一次；反复出现就先修检查本身"
elif [ "${DIFF%%|*}" = "0" ]; then
  ok "8 个部署文件逐个比对一致（文本比内容 / 图片比 sha256）"
else
  bad "有 ${DIFF%%|*} 个文件线上和本地不一致：${DIFF#*|}"
  note "多半是「改了但没部署」。部署：bash scripts/deploy-web.sh"
  note "⚠️ 刚部署完 CDN 可能要 1~2 分钟才刷新，等一会儿再跑本项"
fi

# =====================================================================
printf '\n【5】仓库里没有密钥\n'
if [ -f audit-secrets.py ]; then
  SEC_OUT="$("$PY" audit-secrets.py 2>&1)"
  SEC_HITS="$(printf '%s' "$SEC_OUT" | grep -o '合计命中：[0-9]*' | tail -1 | grep -o '[0-9]*')"
  if [ "${SEC_HITS:-1}" = "0" ]; then
    ok "audit-secrets.py → 0 命中（8 类规则 · 工作区 + git 全历史）"
  else
    bad "扫出 ${SEC_HITS:-?} 条疑似密钥"
    printf '%s\n' "$SEC_OUT" | grep '❌' | head -5 | sed 's/^/         /'
  fi
else
  bad "找不到 audit-secrets.py（扫描器不在了，这一项等于没查）"
fi

# =====================================================================
printf '\n【6】.env 被忽略\n'
if "$GIT" check-ignore -q .env 2>/dev/null; then
  RULE="$("$GIT" check-ignore -v .env 2>/dev/null | head -1)"
  ok ".env 命中忽略规则（$RULE）"
else
  bad ".env 没被忽略！马上加进 .gitignore"
fi

# =====================================================================
printf '\n【7】工作区干净\n'
GST="$("$GIT" status --short 2>/dev/null)"
if [ -z "$GST" ]; then
  ok "git status 无改动"
else
  N_CHANGED="$(printf '%s\n' "$GST" | grep -c .)"
  bad "有 $N_CHANGED 处未提交的改动"
  printf '%s\n' "$GST" | head -6 | sed 's/^/         /'
  note "未提交 = 线上可能跑的是半成品；而且你在看的这份不是仓库里那份"
fi

# =====================================================================
printf '\n【8】没有没推的提交\n'
LOCAL_SHA="$("$GIT" rev-parse HEAD 2>/dev/null)"
REMOTE_SHA="$("$GIT" ls-remote origin main 2>/dev/null | cut -f1)"
if [ -n "$REMOTE_SHA" ]; then
  SRC="远端实时（ls-remote）"
else
  REMOTE_SHA="$("$GIT" rev-parse origin/main 2>/dev/null)"
  SRC="本地缓存引用（网络不通，可能不是最新）"
fi
if [ -n "$REMOTE_SHA" ] && [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  ok "本地 HEAD == ${SRC%%（*}"
  note "${LOCAL_SHA:0:12}  ·  $SRC"
elif [ -z "$REMOTE_SHA" ]; then
  bad "拿不到远端 SHA，无法判断（既连不上远端、也没有本地缓存引用）"
else
  bad "本地和远端不一致 → 有提交没推上去"
  note "本地 ${LOCAL_SHA:0:12} ／ 远端 ${REMOTE_SHA:0:12}"
fi

# =====================================================================
printf '\n════════════════════════════════════════════════════════\n'
TOTAL=$((PASS+FAIL))
printf '  %d 项检查：%d 通过 · %d 失败\n' "$TOTAL" "$PASS" "$FAIL"
printf '════════════════════════════════════════════════════════\n'

if [ "$FAIL" -eq 0 ]; then
  printf '\n  ✅ 全绿，可以发布。\n\n'
  exit 0
else
  printf '\n  ❌ 有 %d 项没过，先别发布：' "$FAIL"
  printf '%b\n' "$FAILED_LIST"
  printf '\n'
  exit 1
fi
