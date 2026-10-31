#!/usr/bin/env python3
"""
Relay commit 1: ghi features/star-race/index.html từ gói gzip đã kiểm chứng.
Tự kiểm MD5 — sai thì khôi phục và exit 1 để CI KHÔNG commit gì.
Idempotent: nếu file đã đúng MD5 thì thoát 0, không tạo commit rỗng.
"""
import base64
import gzip
import hashlib
import io
import json
import os
import subprocess
import sys
import urllib.request

FILES = [
    {
        "path": "features/star-race/index.html",
        "url": os.environ["C1_URL"],
        "md5": os.environ["C1_MD5"],
        "marker": "btnReset",
        "gone": ["btnConfig", "btnSound", "btnExport", "exportPNG"],
    },
]

repo = os.getcwd()


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=repo)


def fetch(url):
    """Tải URL, có retry; trả về (bytes, md5). Nếu là .gz thì giải nén.
    URL của artifact store có thể 403 nếu thiếu token → báo lỗi rõ ràng."""
    last = None
    for _ in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "relay"})
            raw = urllib.request.urlopen(req, timeout=120).read()
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            return raw
        except Exception as e:  # noqa: BLE001
            last = e
            import time
            time.sleep(3)
    raise RuntimeError("download failed: %s" % last)


def stage(msg):
    """Tạo /tmp/msg.txt; ưu tiên MSG64 (env) nếu có, không thì MSG."""
    if os.environ.get("MSG64"):
        data = base64.b64decode(os.environ["MSG64"])
    elif os.environ.get("MSG"):
        data = os.environ["MSG"].encode()
    else:
        data = b""
    open("/tmp/msg.txt", "wb").write(data)
    return msg


def main():
    report = []
    changed = []

    for f in FILES:
        p = os.path.join(repo, f["path"])
        current = open(p, "rb").read()
        cur_md5 = hashlib.md5(current).hexdigest()

        if cur_md5 == f["md5"]:
            print("ALREADY APPLIED %s" % f["path"])
            continue

        raw = fetch(f["url"])
        got = hashlib.md5(raw).hexdigest()
        if got != f["md5"]:
            print("::error::MD5 mismatch for %s: %s != %s" % (f["path"], got, f["md5"]))
            return 1

        txt = raw.decode("utf-8")
        if f["marker"] not in txt:
            print("::error::missing marker %s" % f["marker"])
            return 1
        for g in f["gone"]:
            if g in txt:
                print("::error::dead id still present: %s" % g)
                return 1

        open(p, "wb").write(raw)
        if hashlib.md5(open(p, "rb").read()).hexdigest() != f["md5"]:
            open(p, "wb").write(current)
            print("::error::write-back mismatch %s — rolled back" % f["path"])
            return 1

        changed.append(f["path"])
        report.append({"path": f["path"], "md5": got, "bytes": len(raw)})
        print("OK %s md5=%s bytes=%s" % (f["path"], got, len(raw)))

    if not changed:
        print("nothing to commit")
        print("JSON " + json.dumps(report))
        return 0

    stage(FILES[0]["path"])
    r = sh("git add -A && git commit -q -F /tmp/msg.txt && git log -1 --format=%H")
    print(r.stdout)
    if r.returncode != 0:
        print(r.stderr)
        return 1
    print("JSON " + json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
