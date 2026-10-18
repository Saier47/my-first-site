#!/bin/bash
# =====================================================================
# rollback-web.sh —— 静态托管回滚：把线上的前端退回到某个 git 版本
# ---------------------------------------------------------------------
# 🔴 为什么这东西得自己写：
#   CloudBase 静态托管**没有版本管理**。`tcb hosting deploy` 的帮助原文：
#     "Upload static files to cloud storage (file upload only, no build,
#      no version management)"
#   云函数那套 (`publish-version` / `list-function-versions` /
#   `config-route` 切流量) 在静态托管上**一个都没有**。
#
#   所以"回滚"的唯一办法是：**把旧版本的文件重新传一遍**。
#   没有"点一下回去"的安全网 —— 这个脚本就是把那条手工路子固化下来。
#
# 用法：
#   bash scripts/rollback-web.sh v1.0.0                # 回滚到某个 tag / commit
#   bash scripts/rollback-web.sh ef2fa36 --dry-run     # 只看会变什么，不真传
#   bash scripts/rollback-web.sh ef2fa36 --yes         # 跳过确认（演练时用）
#
# 退出码：0 = 成功；1 = 参数/校验失败；2 = 部署失败
# =====================================================================

set -u
export PATH="/usr/bin:/bin:/c/Windows/system32:/c/Windows:/d"

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

GIT="D:/Git/cmd/git.exe"
TCB="C:/Users/admin/AppData/Roaming/npm/tcb.cmd"
ENV_ID="my-first-site-d0g3re4p71560e327"

# 部署到线上的 8 个文件（见 README「前端运行文件」）
FILES=(index.html app.js store.js mock-data.js manifest.json
       apple-touch-icon.png icon-192.png icon-512.png)

REF="${1:-}"
DRY=0
YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes|-y)  YES=1 ;;
  esac
done

if [ -z "$REF" ] || [ "${REF#--}" != "$REF" ]; then
  echo "用法：bash scripts/rollback-web.sh <tag 或 commit> [--dry-run] [--yes]"
  echo ""
  echo "可用的版本坐标："
  "$GIT" tag -l --sort=-creatordate | head -10 | sed 's/^/  tag  /'
  echo ""
  "$GIT" log --oneline -10 | sed 's/^/  commit  /'
  exit 1
fi

# ---------- 1. 目标版本必须真实存在 ----------
TARGET="$("$GIT" rev-parse --verify "$REF^{commit}" 2>/dev/null)"
if [ -z "$TARGET" ]; then
  echo "❌ 找不到版本 '$REF'。先用 git log / git tag 确认。"
  exit 1
fi
TARGET_SHORT="$(printf '%s' "$TARGET" | cut -c1-8)"
NOW="$("$GIT" rev-parse HEAD)"
NOW_SHORT="$(printf '%s' "$NOW" | cut -c1-8)"

echo ""
echo "════════════════════════════════════════════════════"
echo "  静态托管回滚"
echo "  从  $NOW_SHORT（当前 HEAD）"
echo "  到  $TARGET_SHORT（$REF）"
echo "════════════════════════════════════════════════════"

if [ "$TARGET" = "$NOW" ]; then
  echo ""
  echo "⚠️  目标就是当前 HEAD —— 线上和本地本来就该一致，回滚没有意义。"
  [ "$DRY" = "0" ] && { echo "已停下，什么都没传。"; exit 1; }
fi

# ---------- 2. 说清这次会变哪些文件 ----------
echo ""
echo "【会变化的文件】"
DIFFSTAT="$("$GIT" diff --stat "$TARGET" "$NOW" -- "${FILES[@]}" 2>/dev/null)"
if [ -z "$DIFFSTAT" ]; then
  echo "  （这 8 个部署文件一个都没变 —— 回滚不会改变线上内容）"
else
  printf '%s\n' "$DIFFSTAT" | sed 's/^/  /'
fi

# ---------- 3. 导出目标版本的 8 个文件 ----------
TMP="$DIR/.rollback-tmp"
rm -rf "$TMP" && mkdir -p "$TMP"

"$GIT" archive --format=tar "$TARGET" "${FILES[@]}" 2>/dev/null | tar -x -C "$TMP" 2>/dev/null
if [ $? -ne 0 ]; then
  echo ""
  echo "❌ 导出失败：目标版本里可能缺这几个文件（早期版本未必都有）。"
  rm -rf "$TMP"
  exit 1
fi

MISSING=0
for f in "${FILES[@]}"; do
  [ -f "$TMP/$f" ] || { echo "  ❌ 缺 $f"; MISSING=1; }
done
if [ "$MISSING" = "1" ]; then
  echo ""
  echo "❌ 目标版本不完整，已停下（没有向线上传任何东西）。"
  rm -rf "$TMP"
  exit 1
fi
echo ""
echo "【已从 $REF 导出 8 个文件】"
ls -1 "$TMP" | sed 's/^/  /'

if [ "$DRY" = "1" ]; then
  echo ""
  echo "🔍 --dry-run：到此为止，**没有向线上传任何东西**。"
  rm -rf "$TMP"
  exit 0
fi

# ---------- 4. 确认 ----------
if [ "$YES" = "0" ]; then
  echo ""
  printf '真要传上去吗？线上会变成 %s 的版本。[y/N] ' "$TARGET_SHORT"
  read -r ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "已取消。"; rm -rf "$TMP"; exit 1 ;;
  esac
fi

# ---------- 5. 部署（计时） ----------
echo ""
echo "【开始上传】$(date '+%H:%M:%S')"
START=$(date +%s)

"$TCB" hosting deploy "$TMP" -e "$ENV_ID" 2>&1 | tail -4

END=$(date +%s)
COST=$((END - START))
rm -rf "$TMP"

echo ""
echo "════════════════════════════════════════════════════"
echo "  ✅ 上传完成 · 用时 ${COST} 秒"
echo "════════════════════════════════════════════════════"
echo ""
echo "下一步（一定要做，别只看命令行说成功）："
echo "  bash scripts/preflight.sh"
echo "    第【4】项会报「线上和本地不一致」—— 这说明回滚真的生效了"
echo "    （线上是 $TARGET_SHORT，本地还是 $NOW_SHORT）"
echo ""
echo "  要把线上恢复成最新版："
echo "    bash scripts/rollback-web.sh HEAD --yes     # 或重新 deploy 一次"
echo ""
