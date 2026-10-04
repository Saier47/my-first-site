/* check-day15.js —— Day 15 部署成果自检
 * ===================================================================
 * 盯住三件今天做出来的、之后**很容易被别人改坏**的事：
 *
 *   1. /api/health 云函数公网还能访问，且返回的是**正确的 JSON**
 *      （不是"能连上就算" —— 见下面 §为什么要看 body）
 *   2. 前端页面在公网还能打开，且**资源都还在**
 *   3. 仓库里该有的文件还在（cloudbaserc.json / api-contract.md / 云函数目录）
 *
 * 怎么跑：
 *   node check-day15.js
 *
 * -------------------------------------------------------------------
 * 🔴 为什么要看 body，而不是只看 HTTP 状态码
 *
 * Day 15 部署时踩过一个坑：函数类型建成了「事件型」而不是「HTTP 型」，
 * 公网访问能通、也返回 JSON，**HTTP 状态码是 400 但内容是**：
 *   {"code":"FUNCTIONS_INVOCATION_FAILED","message":"Function code exception..."}
 *
 * 也就是说：**"请求通了"和"服务是好的"是两件事。**
 * 只断言状态码，这个 bug 会被漏过去 —— 所以下面每一处都解析 body 再判断。
 * =================================================================== */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

// ⚠️ 环境 ID 变了要改这两行（或改用环境变量）
const ENV_ID = process.env.TCB_ENV_ID || 'my-first-site-d0g3re4p71560e327';
const STATIC_DOMAIN = process.env.TCB_STATIC_DOMAIN ||
  'my-first-site-d0g3re4p71560e327-1500310885.tcloudbaseapp.com';
const API_DOMAIN = process.env.TCB_API_DOMAIN ||
  'my-first-site-d0g3re4p71560e327-1500310885.ap-shanghai.app.tcloudbase.com';

const ROOT = __dirname;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra) {
  pass++;
  console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
}

function bad(name, why) {
  fail++;
  failures.push(`${name} —— ${why}`);
  console.log(`  ✗ ${name}  ${why}`);
}

/** 发一个请求，拿回 { status, body, headers }；网络层失败返回 null */
function request(url, options) {
  return new Promise((resolve) => {
    const req = https.request(url, Object.assign({ method: 'GET', timeout: 15000 }, options || {}), (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function main() {
  console.log('\n=== Day 15 自检：云端部署成果 ===\n');
  console.log(`环境 ID: ${ENV_ID}\n`);

  /* ------------------------------------------------------------------
   * 一、/api/health —— 公网 + JSON 内容
   * ------------------------------------------------------------------ */
  console.log('【一】/api/health 云函数（公网可访问 + 返回正确 JSON）');

  const healthUrl = `https://${API_DOMAIN}/api/health`;
  const health = await request(healthUrl);

  if (!health) {
    bad('公网能访问 /api/health', '请求失败（网络不通或域名错）');
  } else {
    ok('公网能访问 /api/health', `HTTP ${health.status}`);

    // ⚠️ 关键：不能只看状态码，要能解析出 JSON
    let data = null;
    try {
      data = JSON.parse(health.body);
    } catch (e) {
      bad('响应是合法 JSON', `解析失败，前80字符：${health.body.slice(0, 80)}`);
    }

    if (data) {
      // 如果返回的是 CloudBase 的错误结构，明确指出来 —— 这比"字段缺失"有用得多
      if (data.code && data.message) {
        bad('云函数内部没有报错', `CloudBase 错误：${data.code} ${data.message}`);
      } else {
        ok('云函数内部没有报错');

        if (data.ok === true) ok('ok === true'); else bad('ok === true', `实际是 ${JSON.stringify(data.ok)}`);

        if (data.service === 'my-first-site') ok('service 字段正确');
        else bad('service 字段正确', `实际是 ${JSON.stringify(data.service)}`);

        if (typeof data.version === 'string' && data.version) ok('version 有值', data.version);
        else bad('version 有值', '缺失或不是字符串');

        // ISO 8601：2026-10-04T15:54:54.479Z
        if (typeof data.time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.time)) {
          ok('time 是 ISO 8601 格式');
        } else {
          bad('time 是 ISO 8601 格式', `实际是 ${JSON.stringify(data.time)}`);
        }

        if (typeof data.runtime === 'string' && data.runtime.indexOf('node') === 0) {
          ok('runtime 有值', data.runtime);
        } else {
          bad('runtime 有值', `实际是 ${JSON.stringify(data.runtime)}`);
        }

        // 只允许 GET：POST 应当被拒
        const posted = await request(healthUrl, {
          method: 'POST',
          headers: { 'Content-Length': 0 },
        });
        if (posted && posted.status === 405) ok('POST 被拒绝（405）');
        else bad('POST 被拒绝（405）', posted ? `实际 HTTP ${posted.status}` : '请求失败');
      }
    }
  }

  /* ------------------------------------------------------------------
   * 二、前端静态托管 —— 页面 + 资源
   * ------------------------------------------------------------------ */
  console.log('\n【二】前端页面（公网可打开 + 资源都在）');

  const PAGE_FILES = [
    ['index.html', 'text/html'],
    ['app.js', 'javascript'],
    ['store.js', 'javascript'],
    ['mock-data.js', 'javascript'],
    ['manifest.json', 'json'],
    ['icon-192.png', 'image'],
    ['icon-512.png', 'image'],
    ['apple-touch-icon.png', 'image'],
  ];

  for (const [file] of PAGE_FILES) {
    const r = await request(`https://${STATIC_DOMAIN}/${file}`);
    if (r && r.status === 200 && r.body.length > 0) {
      ok(`${file}`, `${r.body.length} 字节`);
    } else {
      bad(`${file}`, r ? `HTTP ${r.status}` : '请求失败');
    }
  }

  // 首页必须真的是我们的页面（不是腾讯云的警告页 / 错误页）
  const page = await request(`https://${STATIC_DOMAIN}/index.html`);
  if (page && page.body.indexOf('这一周') !== -1) {
    ok('首页内容是「这一周」页面');
  } else {
    bad('首页内容是「这一周」页面', '首页里找不到「这一周」字样');
  }

  // Day 14 加的「加到主屏」配置，别在部署时漏掉
  if (page && page.body.indexOf('manifest.json') !== -1 && page.body.indexOf('viewport-fit=cover') !== -1) {
    ok('首页仍带「加到主屏」配置（Day 14 成果没丢）');
  } else {
    bad('首页仍带「加到主屏」配置', 'manifest 或 viewport-fit 不见了');
  }

  /* ------------------------------------------------------------------
   * 三、仓库文件 —— 今天新增的必须都在
   * ------------------------------------------------------------------ */
  console.log('\n【三】仓库文件（今天的产出进没进仓库）');

  const REPO_FILES = [
    'cloudbaserc.json',
    'api-contract.md',
    'cloudfunctions/api-health/index.js',
    'cloudfunctions/api-health/scf_bootstrap',
    'cloudfunctions/api-health/package.json',
  ];

  for (const rel of REPO_FILES) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) ok(rel);
    else bad(rel, '文件不存在');
  }

  // 云函数代码的关键写法：端口必须是 9000（平台规定），且真的起了服务
  const fnCode = fs.readFileSync(path.join(ROOT, 'cloudfunctions/api-health/index.js'), 'utf8');
  if (/PORT\s*=\s*9000/.test(fnCode)) ok('云函数监听 9000 端口（平台规定）');
  else bad('云函数监听 9000 端口', '没找到 PORT = 9000');

  if (/createServer/.test(fnCode)) ok('云函数起的是 HTTP 服务');
  else bad('云函数起的是 HTTP 服务', '没找到 createServer');

  const bootstrap = fs.readFileSync(path.join(ROOT, 'cloudfunctions/api-health/scf_bootstrap'), 'utf8');
  if (bootstrap.indexOf('9000') !== -1) ok('scf_bootstrap 里端口也是 9000');
  else bad('scf_bootstrap 里端口也是 9000', '启动脚本里没写 9000');

  // 部署配置：必须是 HTTP 类型（Day 15 踩过的坑），且开了公网
  const rc = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudbaserc.json'), 'utf8'));
  const fnConf = (rc.functions || [])[0] || {};
  if (fnConf.type === 'HTTP') ok('部署配置里函数类型是 HTTP');
  else bad('部署配置里函数类型是 HTTP', `实际是 ${JSON.stringify(fnConf.type)} —— 建成 Event 型就没有公网地址`);

  if (fnConf.public === true) ok('部署配置开了公网访问（public: true）');
  else bad('部署配置开了公网访问', 'public 不是 true');

  if (fnConf.gatewayPath === '/api/health') ok('网关路径是 /api/health');
  else bad('网关路径是 /api/health', `实际是 ${JSON.stringify(fnConf.gatewayPath)}`);

  if (rc.envId === ENV_ID) ok('envId 与本次部署的环境一致');
  else bad('envId 与本次部署的环境一致', `配置里是 ${rc.envId}`);

  /* ------------------------------------------------------------------
   * 四、契约文档 —— 该说的说了没
   * ------------------------------------------------------------------ */
  console.log('\n【四】api-contract.md 内容要点');

  const contract = fs.readFileSync(path.join(ROOT, 'api-contract.md'), 'utf8');
  const mustHave = [
    ['响应信封 ok 字段', /"ok":\s*true/],
    ['8 个业务接口', /\/api\/courses[\s\S]*\/api\/ddls/],
    ['PATCH 语义说明', /PATCH/],
    ['/api/health 已完成', /Day 15/],
    ['未做的接口防线', /本期不做/],
  ];
  for (const [label, re] of mustHave) {
    if (re.test(contract)) ok(label);
    else bad(label, '文档里找不到');
  }

  /* ------------------------------------------------------------------
   * 汇总
   * ------------------------------------------------------------------ */
  const total = pass + fail;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`结果：${pass} / ${total} 通过`);
  if (fail > 0) {
    console.log(`\n失败项：`);
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  } else {
    console.log('全部通过 ✅');
  }
  console.log('='.repeat(50) + '\n');

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n[check-day15] 脚本本身出错：', err && err.message);
  process.exit(2);
});
