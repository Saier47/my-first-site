# -*- coding: utf-8 -*-
"""push_via_api_multi.py —— push_via_api.py 的多提交版

和原版的唯一区别：原版只推 HEAD 这 1 个提交（假设远端 = HEAD~1），
本版从**远端实际位置**出发，按顺序把中间缺的 N 个提交逐个复刻上去。

安全设计完全照抄原版：blob / tree / commit 三层 SHA 逐层校验，
任何一层对不上就原样退出，**绝不写远端**。

用法：
    python push_via_api_multi.py <repo> <cwd>
"""
import base64, datetime, io, json, os, re, subprocess, sys, urllib.error, urllib.request

GIT = os.environ.get("GIT_EXE", r"D:\Git\cmd\git.exe")
REPO = sys.argv[1]
CWD = sys.argv[2]
LOG = os.path.join(os.environ.get("TEMP", CWD), "push_via_api_multi.log")
log = []


def sh(args, binary=False):
    p = subprocess.run([GIT] + args, cwd=CWD, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (args, p.stderr.decode("utf-8", "replace")))
    return p.stdout if binary else p.stdout.decode("utf-8", "replace")


def token():
    for line in io.open(os.path.expanduser(r"~\.git-credentials"), encoding="utf-8"):
        m = re.match(r"https://([^:]+):([^@]+)@github\.com", line.strip())
        if m:
            return m.group(2)
    raise RuntimeError("~/.git-credentials 里没找到 github token")


TOK = token()


def api(method, path, payload=None):
    req = urllib.request.Request(
        "https://api.github.com" + path,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        method=method,
        headers={"Authorization": "Bearer " + TOK, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "push-via-api",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError("HTTP %s %s %s -> %s" % (e.code, method, path,
                                                    e.read().decode("utf-8", "replace")[:400]))


def who(lines, prefix):
    line = [l for l in lines if l.startswith(prefix + " ")][0]
    m = re.match(r"^\w+ (.*) <(.*)> (\d+) ([+-]\d{4})$", line)
    name, mail, epoch, off = m.group(1), m.group(2), int(m.group(3)), m.group(4)
    tz = datetime.timezone(datetime.timedelta(hours=int(off[:3]),
                                             minutes=int(off[3:]) * (1 if off[0] == "+" else -1)))
    return name, mail, datetime.datetime.fromtimestamp(epoch, tz).isoformat()


local_sha = sh(["rev-parse", "HEAD"]).strip()
ref = api("GET", "/repos/%s/git/ref/heads/main" % REPO)
remote_head = ref["object"]["sha"]
log.append("repo=%s local HEAD=%s remote HEAD=%s" % (REPO, local_sha[:10], remote_head[:10]))

if remote_head == local_sha:
    log.append("远端已是最新，无需推送")
    io.open(LOG, "w", encoding="utf-8").write("\n".join(log)); print("already up to date"); sys.exit(0)

# 找出远端..本地 之间的提交链（按时间正序：最老的在前）
chain = [s for s in sh(["rev-list", "--reverse", "%s..%s" % (remote_head, local_sha)]).split() if s.strip()]
if not chain:
    log.append("远端 SHA 不是本地祖先，无法线性推进 → 退出")
    io.open(LOG, "w", encoding="utf-8").write("\n".join(log)); sys.exit(2)
log.append("待推 %d 个提交: %s" % (len(chain), " ".join(c[:10] for c in chain)))

remote_tree = api("GET", "/repos/%s/git/commits/%s" % (REPO, remote_head))["tree"]["sha"]
log.append("远端 base_tree = %s" % remote_tree[:10])

for sha in chain:
    raw = sh(["cat-file", "commit", sha], binary=True)
    header, message = raw.split(b"\n\n", 1)
    lines = header.decode("utf-8").split("\n")
    tree = [l.split(" ", 1)[1] for l in lines if l.startswith("tree ")][0]
    parents = [l.split(" ", 1)[1] for l in lines if l.startswith("parent ")]
    an, ae, ad = who(lines, "author")
    cn, ce, cd = who(lines, "committer")

    # 该提交相对其父提交改了哪些文件
    if parents:
        changed = [p for p in sh(["diff", "--name-only", "-z", parents[0], sha]).split("\0") if p.strip()]
    else:
        changed = [p for p in sh(["ls-tree", "-r", "--name-only", "-z", sha]).split("\0") if p.strip()]
    log.append("--- %s  (%d 个文件改动)" % (sha[:10], len(changed)))

    entries = []
    for p in changed:
        content = sh(["cat-file", "blob", sha + ":" + p], binary=True)
        blob = api("POST", "/repos/%s/git/blobs" % REPO,
                   {"content": base64.b64encode(content).decode("ascii"), "encoding": "base64"})
        if blob["sha"] != sh(["rev-parse", sha + ":" + p]).strip():
            log.append("blob SHA 不一致：%s → 退出（远端未改）" % p)
            io.open(LOG, "w", encoding="utf-8").write("\n".join(log)); sys.exit(3)
        entries.append({"path": p.replace("\\", "/"), "mode": "100644", "type": "blob", "sha": blob["sha"]})

    new_tree = api("POST", "/repos/%s/git/trees" % REPO,
                   {"base_tree": remote_tree, "tree": entries})
    if new_tree["sha"] != tree:
        log.append("tree SHA 不一致（%s vs %s）→ 退出（远端未改）" % (new_tree["sha"][:10], tree[:10]))
        io.open(LOG, "w", encoding="utf-8").write("\n".join(log)); sys.exit(4)

    new_commit = api("POST", "/repos/%s/git/commits" % REPO,
                     {"message": message.decode("utf-8"), "tree": new_tree["sha"],
                      "parents": [remote_head],
                      "author": {"name": an, "email": ae, "date": ad},
                      "committer": {"name": cn, "email": ce, "date": cd}})
    if new_commit["sha"] != sha:
        log.append("commit SHA 不一致（%s vs %s）→ 退出（远端未改）"
                   % (new_commit["sha"][:10], sha[:10]))
        io.open(LOG, "w", encoding="utf-8").write("\n".join(log)); sys.exit(5)

    remote_head = new_commit["sha"]
    remote_tree = new_tree["sha"]
    log.append("    ✅ commit 复刻成功 %s" % remote_head[:10])

# 全部校验通过，才更新引用
api("PATCH", "/repos/%s/git/refs/heads/main" % REPO, {"sha": remote_head, "force": False})
final = api("GET", "/repos/%s/git/ref/heads/main" % REPO)["object"]["sha"]
log.append("PATCH 后远端 main = %s ; 与本地一致 = %s" % (final[:10], final == local_sha))
io.open(LOG, "w", encoding="utf-8").write("\n".join(log))
print("ok, log:", LOG)
print("remote main =", final)
print("matches local =", final == local_sha)
