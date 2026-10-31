#!/usr/bin/env python3
"""
Relay commit 2: ghi 4 file từ gói gzip chứa {path, md5, bytes, b64}.
Kiểm MD5 từng file TRƯỚC khi ghi; sai thì rollback toàn bộ và exit 1.
Idempotent: file nào đã đúng MD5 thì bỏ qua (không commit rỗng).
"""
import base64
import gzip
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request

repo = os.getcwd()
URL = os.environ["C2_URL"]
EXPECT_GZ = os.environ.get("C2_GZ_MD5", "")


def fetch(url):
    last = None
    for _ in range(8):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "relay"})
            return urllib.request.urlopen(req, timeout=180).read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(4)
    raise RuntimeError("download failed: %s" % last)


def main():
    gz = fetch(URL)
    if EXPECT_GZ and hashlib.md5(gz).hexdigest() != EXPECT_GZ:
        print("::error::gz md5 mismatch")
        return 1
    try:
        payload = json.loads(gzip.decompress(gz).decode())
    except Exception as e:  # noqa: BLE001
        print("::error::bad payload: %s" % e)
        return 1

    # 1) chuẩn bị và kiểm tra TOÀN BỘ trước khi động vào file nào
    plan = []
    for f in payload["files"]:
        raw = base64.b64decode(f["b64"])
        if len(raw) != f["bytes"] or hashlib.md5(raw).hexdigest() != f["md5"]:
            print("::error::payload corrupt for %s" % f["path"])
            return 1
        plan.append((f["path"], raw, f["md5"]))

    originals = {}
    changed = []
    for path, raw, want in plan:
        p = os.path.join(repo, path)
        originals[path] = open(p, "rb").read()
        if hashlib.md5(originals[path]).hexdigest() == want:
            print("ALREADY OK %s" % path)
            continue
        open(p, "wb").write(raw)
        changed.append(path)

    # 2) kiểm lại trên đĩa; sai thì rollback hết
    bad = []
    for path, raw, want in plan:
        p = os.path.join(repo, path)
        if hashlib.md5(open(p, "rb").read()).hexdigest() != want:
            bad.append(path)
    if bad:
        for path in changed:
            open(os.path.join(repo, path), "wb").write(originals[path])
        print("::error::write-back mismatch, rolled back: %s" % bad)
        return 1

    for path, raw, want in plan:
        print("OK %s bytes=%s md5=%s" % (path, len(raw), want))

    if not changed:
        print("nothing to commit")
        return 0

    # 3) guard: nội dung mới phải có dấu hiệu của Việc 2
    db = open(os.path.join(repo, "js/db.js"), encoding="utf-8").read()
    if "deleteClassDeep" not in db:
        print("::error::missing deleteClassDeep")
        return 1
    idx = open(os.path.join(repo, "features/star-race/index.html"), encoding="utf-8").read()
    if idx.count("delClassModal") == 0:
        print("::error::missing delClassModal")
        return 1
    for dead in ("btnConfig", "btnSound", "btnExport", "exportPNG"):
        if dead in idx:
            print("::error::dead id still present: %s" % dead)
            return 1

    r = subprocess.run(
        "git add -A && git commit -q -F /tmp/msg.txt && git log -1 --format=%H",
        shell=True, capture_output=True, text=True, cwd=repo,
    )
    print(r.stdout, r.stderr)
    if r.returncode != 0:
        return 1
    print("CHANGED " + json.dumps(changed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
