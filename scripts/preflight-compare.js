#!/usr/bin/env node
/**
 * preflight-compare.js —— 发布前检查第【4】项的比对逻辑
 * =====================================================================
 * 为什么单独一个文件（而不是内联在 preflight.sh 里）：
 *   内联时那段 JS 位于 bash 双引号字符串中，`$` / 反斜杠都得小心转义。
 *   一旦转义出岔，**失败方式很隐蔽** ——
 *   Day 25 实测：内联版偶发地什么都没输出，于是 preflight 报出
 *   「有  个文件不一致」（数字是空的），**看起来像"发现了问题"**，
 *   其实**是检查自己没跑起来**。
 *   → 抽出来：shell 只负责传一个 URL，不再碰 JS 里的字符。
 *
 * 用法：node scripts/preflight-compare.js <前端基址>
 * 输出：一行  "<不一致文件数>|<详情>"     例： 0|
 * 退出码：0 = 一致；1 = 有不一致；2 = 检查本身失败（全拉不到）
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEB = process.argv[2];
if (!WEB) {
  console.error('用法：node preflight-compare.js <前端基址>');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');

// 部署到线上的 8 个文件（见 README「前端运行文件」）
const FILES = [
  'index.html', 'app.js', 'store.js', 'mock-data.js', 'manifest.json',
  'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
];

(async () => {
  const bad = [];
  let unreachable = 0;

  for (const f of FILES) {
    let local = null;
    try {
      local = fs.readFileSync(path.join(ROOT, f));
    } catch (e) {
      bad.push(f + '（本地缺失）');
      continue;
    }

    let remote = null;
    try {
      const r = await fetch(WEB + '/' + f, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) { unreachable++; bad.push(f + '（线上 HTTP ' + r.status + '）'); continue; }
      remote = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      unreachable++;
      bad.push(f + '（线上拉不到：' + String(e.message || e).slice(0, 30) + '）');
      continue;
    }

    if (/\.(html|js|json)$/.test(f)) {
      // 文本：归一化换行与尾部空白再比（CRLF / LF 差异不算"不一致"）
      const norm = function (s) { return s.replace(/\r\n/g, '\n').replace(/\s+$/, ''); };
      if (norm(local.toString('utf8')) !== norm(remote.toString('utf8'))) {
        bad.push(f + '（本地 ' + local.length + ' 字节 / 线上 ' + remote.length + ' 字节）');
      }
    } else {
      // 图片：比 sha256
      const h = function (b) { return crypto.createHash('sha256').update(b).digest('hex'); };
      if (h(local) !== h(remote)) bad.push(f + '（图片 sha256 不同）');
    }
  }

  console.log(bad.length + '|' + bad.join(' ／ '));

  // 全都拉不到 → 是**检查自己**的问题（网络/地址），不是"文件不一致"。
  // 这个区分很重要：报成"不一致"会让人跑去查代码，其实该查网络。
  if (unreachable === FILES.length) process.exit(2);
  process.exit(bad.length ? 1 : 0);
})();
