#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
audit-secrets.py —— Day 23 密钥排查（独立扫描器）

和 scripts/check-no-secrets.sh 是**两套独立工具**，故意不复用它的规则：
  · 那个脚本只查 3 件事（占位符 / JWT / .secrets 忽略）
  · 这个查 8 类密钥特征词，且**同时扫「工作区文件」和「git 全历史」**

为什么必须扫 git 全历史：
  密钥提交过、后来又删掉 —— 当前快照是干净的，但 `git log -p` 里还留着，
  推到 GitHub 就永久留痕。只扫工作区的检查会给出**假的安全感**。

用法：python audit-secrets.py
退出码：0 = 0 命中；1 = 有命中
"""
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
GIT = 'D:/Git/cmd/git.exe'

# ---------------------------------------------------------------- 特征词规则
# 每条：[名字, 正则, 说明]
PATTERNS = [
    ('JWT / service_role Key',
     re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'),
     'CloudBase API Key 的形状（三段点分 Base64）'),
    ('腾讯云 SecretId',
     re.compile(r'AKID[A-Za-z0-9]{13,}'),
     '腾讯云 SecretId 固定以 AKID 开头'),
    # ⚠️ 自检（selftest-audit-secrets.py）抓出来的三个 bug，已修：
    #    ① sk- 后面允许连字符（真实 Key 是 sk-proj-xxx），原来 [A-Za-z0-9] 把 `-` 截断了
    ('OpenAI 风格 sk-',
     re.compile(r'sk-[A-Za-z0-9_\-]{20,}'),
     'sk- 开头的长串（含 sk-proj- 这类带连字符的）'),
    ('PEM 私钥块',
     re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
     '私钥文件内容'),
    #    ② 关键词前面可能有前缀（db_password / my_token），所以不能用 \b ——
    #       \b 要求前一个字符是非单词字符，而 `_` 算单词字符，`db_password` 就漏了。
    #       改用「行首或非字母」+ 允许 `_` 前缀，后缀用 (?![a-z]) 防止把 passwordHash 也当中招。
    ('赋值式 password/secret',
     re.compile(r'(?i)(?:^|[^A-Za-z])(?:[a-z_]*_)?(password|passwd|secret|token|apikey|api_key)(?![a-z])\s*[:=]\s*["\']([^"\'\s]{8,})["\']'),
     '写死的口令/令牌（值长度 >= 8，允许 db_password 这类带前缀的变量名）'),
    ('Postgres 连接串带密码',
     re.compile(r'postgres(?:ql)?://[^:/\s]+:[^@/\s]{4,}@'),
     # 说明文字故意拆开写 —— 不然这句"举例"会被自己的正则命中（Day 25 修）
     'postgres' + '://user:password@host 形式'),
    ('阿里云/通用 AccessKey 头',
     re.compile(r'LTAI[A-Za-z0-9]{12,}'),
     '阿里云 AccessKeyId 形状'),
    #    ③ 原来用负向先行写「不是占位符」写错了，反而把正常的值也拦了。
    #       改成：字段名 + 冒号 + 任意引号内容，命中的一律报，占位符交给 ALLOW_MARKERS 放行。
    ('CloudBase 环境密钥字段',
     re.compile(r'"(?:apiKey|apikey|CLOUDBASE_API_KEY)"\s*:\s*"ey[A-Za-z0-9_\-]{10,}'),
     'cloudbaserc.json 里被灌进了真 Key（占位符会被白名单放行）'),
]

# 跳过的目录：不是发布内容，也不是源码
SKIP_DIRS = {'.git', 'node_modules', '.secrets', 'docs'}
# 跳过的扩展名：二进制/图片/压缩包，正则扫它们只会出噪声
SKIP_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.ico', '.zip', '.woff', '.woff2', '.ttf'}

# 允许出现的「假阳性」白名单：占位符、文档里的示例、本脚本自己的规则文本
ALLOW_MARKERS = (
    '__INJECTED_BY_SCRIPT__',
    'eyJhbGciOi...',        # 文档里写的省略式示例
    'your-key-here',
    'YOUR_KEY',
    '<API Key>',
)


def looks_whitelisted(line):
    return any(m in line for m in ALLOW_MARKERS)


def scan_workspace():
    """扫工作区当前文件内容。返回 [(相对路径, 行号, 规则名, 该行前 80 字)]"""
    hits = []
    for root, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            ext = os.path.splitext(fn)[1].lower()
            if ext in SKIP_EXT:
                continue
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, REPO).replace('\\', '/')
            # 本脚本自己写着规则文本和自检样本（样本是拼出来的，正则扫不到），跳过自己
            if rel == 'audit-secrets.py':
                continue
            try:
                text = open(path, encoding='utf-8', errors='ignore').read()
            except Exception:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if looks_whitelisted(line):
                    continue
                for name, rx, _ in PATTERNS:
                    if rx.search(line):
                        hits.append((rel, i, name, line.strip()[:80]))
                        break
    return hits


def scan_git_history():
    """扫 git 全历史里每个提交的 diff 新增行。"""
    hits = []
    try:
        out = subprocess.run(
            [GIT, 'log', '--all', '-p', '--unified=0', '--no-color'],
            cwd=REPO, capture_output=True, text=True,
            encoding='utf-8', errors='ignore', timeout=180,
        ).stdout
    except Exception as e:
        print('  ⚠️ 无法读取 git 历史：%s' % e)
        return hits

    cur_file = '?'
    for line in out.splitlines():
        if line.startswith('+++ b/'):
            cur_file = line[6:]
            continue
        if not line.startswith('+') or line.startswith('+++'):
            continue
        # ⚠️ 扫描器自己的文件跳过 —— 理由和 scan_workspace 里那条一样：
        #    它里面的"密钥形状"必然是规则文本和编的自检样本，不是真泄露。
        #
        # 🔴 **Day 25 发现的疏漏**：scan_workspace() 有这个判断，这里**忘了加**。
        #    后果是历史扫描报出 3 条假命中（全是本文件自己的规则说明和样本）——
        #    而假命中比漏报更能毁掉一个检查：用户看到红的，
        #    查完发现是虚惊，下次就再也不信它了。
        #
        #    取舍说明：跳过自己意味着"真有人把密钥写进这个脚本"会漏掉 ——
        #    但那是工具文件、不是产品代码，风险远小于天天误报。
        if cur_file == 'audit-secrets.py':
            continue
        content = line[1:]
        if looks_whitelisted(content):
            continue
        for name, rx, _ in PATTERNS:
            if rx.search(content):
                hits.append((cur_file, name, content.strip()[:80]))
                break
    return hits


# =====================================================================
# 自检：证明这个扫描器「真的在扫」
#
# 为什么必须带上它：
#   本脚本报「命中 0 条」时，有两种可能从输出上完全一样：
#     ① 仓库真干净    ② 规则写错了，什么都扫不到
#   **一个永远说"没问题"的检查等于没检查。**
#   （Day 23 第一次跑自检时，8 条规则里真有 3 条是坏的 —— 见下方 _bugfix()
#     注释。要不是先跑了自检，那个"0 条"就是假的安全感。）
#
# 样本全部在**内存里拼**，不写盘 —— 免得带假密钥的文件被提交进仓库，
# 反过来卡住自己的 pre-commit 钩子。
# =====================================================================
def _selftest_samples():
    """8 类假样本，全部是编的，用拼接避开本文件被自己扫到。"""
    j = 'ey' + 'JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    jt = 'ey' + 'Jyb2xlIjoic2VydmljZV9yb2xlIn0'
    return {
        'JWT / service_role Key':
            'KEY = "' + j + '.' + jt + '.abcdefghijklmnop"',
        '腾讯云 SecretId':
            'secretId: "' + 'AKID' + 'zFAKEfakeFAKE1234567890"',
        'OpenAI 风格 sk-':
            'OPENAI_KEY=' + 'sk-' + 'proj-1234567890abcdefghijklmnopqrstuv',
        'PEM 私钥块':
            '-----BEGIN RSA ' + 'PRIVATE KEY-----',
        '赋值式 password/secret':
            'db_' + 'password = "hunter2secret"',
        'Postgres 连接串带密码':
            'DATABASE_URL=postgres://admin:s3cr3tpw@db.example.com:5432/app',
        '阿里云/通用 AccessKey 头':
            'accessKeyId: "' + 'LTAI' + '5tFakeFake123456"',
        'CloudBase 环境密钥字段':
            '"CLOUDBASE_API_KEY": "' + j + '.' + jt + '.zzzzzzzzzzzzzzzz"',
    }


def run_selftest():
    """返回 (是否通过, 输出行列表)。"""
    lines = []
    samples = _selftest_samples()

    # 用例 1：8 个样本逐个丢给规则，应全部命中
    missed = []
    for name, sample in samples.items():
        hit = None
        if looks_whitelisted(sample):
            missed.append(name + '(被白名单误放行)')
            continue
        for rn, rx, _ in PATTERNS:
            if rx.search(sample):
                hit = rn
                break
        if hit:
            lines.append('    ✅ %-28s → 命中规则「%s」' % (name, hit))
        else:
            missed.append(name)
            lines.append('    ❌ %-28s → 没扫出来' % name)

    # 用例 2：正常内容不该被误报
    false_pos = []
    for probe in [
        '"CLOUDBASE_API_KEY": "__INJECTED_BY_SCRIPT__"',
        'Authorization: Bearer <API Key>',
        'const password = "";            // 空口令',
        'if (token) { refresh(); }',
        '这里讲一下 api_key 要放在环境变量里，不要提交',
        'password: 8 个字以上',   # 值不是引号串，不该报
    ]:
        if looks_whitelisted(probe):
            continue
        for rn, rx, _ in PATTERNS:
            if rx.search(probe):
                false_pos.append((probe, rn))
                break

    for probe, rn in false_pos:
        lines.append('    ❌ 误报：%r → 命中「%s」' % (probe, rn))
    if not false_pos:
        lines.append('    ✅ 正常内容未被误报（6 个探针）')

    ok = (not missed) and (not false_pos)
    return ok, lines


def main():
    if '--selftest' in sys.argv:
        print('=' * 62)
        print('Day 23 · 密钥扫描器自检（证明它不是个摆设）')
        print('=' * 62)
        ok, lines = run_selftest()
        for l in lines:
            print(l)
        print('\n' + '=' * 62)
        print('自检结果：%s' % ('✅ 通过 —— 扫描器确实在扫，它的 0 条可信'
                              if ok else '❌ 不通过 —— 扫描器有问题，0 条不可信'))
        print('=' * 62)
        return 0 if ok else 1

    print('=' * 62)
    print('Day 23 · 密钥排查（独立扫描器）')
    print('=' * 62)
    print('\n【第 1 遍】工作区当前文件（跳过 .git / node_modules / .secrets / docs）')
    print('  规则 %d 类：%s' % (len(PATTERNS), '、'.join(p[0] for p in PATTERNS)))
    ws = scan_workspace()
    if not ws:
        print('  → 命中 0 条  ✅')
    else:
        for rel, ln, name, snip in ws:
            print('  ❌ %s:%d [%s] %s' % (rel, ln, name, snip))

    print('\n【第 2 遍】git 全历史（每个提交的 diff，含已删除的行）')
    hist = scan_git_history()
    if not hist:
        print('  → 命中 0 条  ✅')
    else:
        for rel, name, snip in hist:
            print('  ❌ %s [%s] %s' % (rel, name, snip))

    total = len(ws) + len(hist)
    print('\n' + '=' * 62)
    print('合计命中：%d 条' % total)
    print('=' * 62)
    return 1 if total else 0


if __name__ == '__main__':
    sys.exit(main())
