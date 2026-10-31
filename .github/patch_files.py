#!/usr/bin/env python3
"""Vá 4 file bằng đúng các hunk đã kiểm chứng.

Tải ops_plain.json (ops dạng [i1, i2, text_mới]) rồi áp dụng NGƯỢC từ dưới lên.
Sau khi vá, kiểm tra MD5 từng file; lệch thì khôi phục nguyên trạng và exit 1
-> workflow không commit gì.
"""
import hashlib, json, os, sys, urllib.request

HUNKS_URL = os.environ["HUNKS_URL"]

EXPECT = {
    "js/db.js": "6966cf6881cfc1da1c006855b66fbce7",
    "features/star-race/index.html": "e4f851d06f86448565c11eeafe55a560",
    "docs/firestore-schema.md": "bc00153a24e526ac6d3a8fb080509556",
    "README.md": "745f74cb5886d5b9e5a6b51cd4a977c9",
}


def main():
    if os.path.exists("js/db.js") and "renameClassEverywhere" in open("js/db.js", encoding="utf-8").read():
        print("ALREADY PATCHED - nothing to do")
        return 0

    with urllib.request.urlopen(HUNKS_URL, timeout=60) as r:
        data = json.loads(r.read().decode("utf-8"))

    originals = {}
    for path, ops in data.items():
        if not os.path.exists(path):
            print("MISSING", path)
            return 1
        raw = open(path, encoding="utf-8").read()
        originals[path] = raw
        lines = raw.splitlines(keepends=True)
        for i1, i2, txt in reversed(ops):
            lines[i1:i2] = [txt] if txt else []
        out = "".join(lines)
        open(path, "w", encoding="utf-8", newline="").write(out)
        print("PATCHED", path, len(out.encode()))

    bad = []
    for path, want in EXPECT.items():
        got = hashlib.md5(open(path, "rb").read()).hexdigest()
        print("MD5", path, got, "OK" if got == want else "MISMATCH")
        if got != want:
            bad.append(path)

    if bad:
        for path, raw in originals.items():
            open(path, "w", encoding="utf-8", newline="").write(raw)
        print("ROLLED BACK - byte mismatch:", bad)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
