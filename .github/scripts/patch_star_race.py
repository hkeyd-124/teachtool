#!/usr/bin/env python3
"""Vá features/star-race/index.html bằng 5 hunk CSS/HTML đã kiểm chứng.

Chạy trong GitHub Actions (hoặc local) để tránh phải gõ lại file 106 KB.
Mỗi hunk phải xuất hiện ĐÚNG 1 lần, nếu không script dừng và không ghi gì.
"""
import base64
import io
import json
import sys

HUNKS_B64 = (
    "W3sib2xkIjogIiAgLmhncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxt"
    "aW5tYXgoMTkwcHgsMWZyKSk7Z2FwOjEycHh9XG4iLCAibmV3IjogIiAgLyogYXV0by1GSVQgKGtow7RuZyBwaOG6o2kgYXV0"
    "by1maWxsKToga2hpIMOtdCB0csaw4budbmcsIHRo4bq7IGdpw6NuIHLhu5luZyBo4bq/dCBow6BuZyB0aGF5IHbDrFxuICAg"
    "ICBi4buLIG5o4buRdCB0cm9uZyBj4buZdCAxOTBweCDihpIgdMOqbiB0csaw4budbmcga2jDtG5nIGLhu4sgY+G6r3QgdGjD"
    "oG5oIFwiVGnhu4N1IGjhu41jIOKAplwiLiAqL1xuICAuaGdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1u"
    "czpyZXBlYXQoYXV0by1maXQsbWlubWF4KDI0MHB4LDFmcikpO2dhcDoxMnB4fVxuIn0sIHsib2xkIjogIiAgLmhjYXJkIC5o"
    "Ym9keXttaW4td2lkdGg6MDtmbGV4OjEgMSBhdXRvO3BhZGRpbmctcmlnaHQ6MzRweDtvdmVyZmxvdzpoaWRkZW59XG4gIC8q"
    "IGhuYW1lL2hzdWIgbMOgIDxzcGFuPiDihpIgUEjhuqJJIGRpc3BsYXk6YmxvY2ssIG7hur91IGtow7RuZyBjaMO6bmcgbuG6"
    "sW0gY8O5bmcgbeG7mXQgZMOybmdcbiAgICAgdsOgIHRleHQtb3ZlcmZsb3c6ZWxsaXBzaXMga2jDtG5nIGPDsyB0w6FjIGTh"
    "u6VuZyAodMOqbiB0csaw4budbmcgxJHDqCBsw6puIHPhu5EgbMaw4bujbmcpLiAqL1xuIiwgIm5ldyI6ICIgIC8qIENo4buJ"
    "IGNo4burYSBjaOG7lyBjaG8gbsO6dCB4b8OhIGtoaSB0aOG6uyBUSOG7sEMgU+G7sCBjw7MgbsO6dCB4b8OhIOKAlCBu4bq/"
    "dSBjaOG7q2EgdsO0IMSRaeG7gXUga2nhu4duXG4gICAgIHRow6wgdMOqbiBi4buLIGLDs3AgY8OybiB+NTBweCB0csOqbiBk"
    "ZXNrdG9wLiAqL1xuICAuaGNhcmQgLmhib2R5e21pbi13aWR0aDowO2ZsZXg6MSAxIGF1dG87b3ZlcmZsb3c6aGlkZGVufVxu"
    "ICAuaGNhcmQuaGFzLWRlbCAuaGJvZHl7cGFkZGluZy1yaWdodDozNHB4fVxuICAvKiBUw6puIHRyxrDhu51uZy9s4bubcDog"
    "eHXhu5FuZyB04buRaSDEkWEgMiBkw7JuZyB0aGF5IHbDrCBj4bqvdCBj4buldCBt4buZdCBkw7JuZy5cbiAgICAgVMOqbiB0"
    "csaw4budbmcgbMOgIG5n4buvIGPhuqNuaCBxdWFuIHRy4buNbmcgbmjhuqV0IOKAlCBwaOG6o2kgxJHhu41jIMSRxrDhu6Nj"
    "IMSR4bqneSDEkeG7py4gKi9cbiJ9LCB7Im9sZCI6ICIgICAgZGlzcGxheTpibG9jaztcbiAgICBmb250LXNpemU6MTZweDtm"
    "b250LXdlaWdodDo5MDA7Y29sb3I6dmFyKC0taW5rKTtsaW5lLWhlaWdodDoxLjM7XG4gICAgb3ZlcmZsb3c6aGlkZGVuO3Rl"
    "eHQtb3ZlcmZsb3c6ZWxsaXBzaXM7d2hpdGUtc3BhY2U6bm93cmFwO1xuIiwgIm5ldyI6ICIgICAgZGlzcGxheTotd2Via2l0"
    "LWJveDstd2Via2l0LWJveC1vcmllbnQ6dmVydGljYWw7LXdlYmtpdC1saW5lLWNsYW1wOjI7bGluZS1jbGFtcDoyO1xuICAg"
    "IGZvbnQtc2l6ZToxNnB4O2ZvbnQtd2VpZ2h0OjkwMDtjb2xvcjp2YXIoLS1pbmspO2xpbmUtaGVpZ2h0OjEuMjg7XG4gICAg"
    "b3ZlcmZsb3c6aGlkZGVuO3dvcmQtYnJlYWs6YnJlYWstd29yZDtcbiJ9LCB7Im9sZCI6ICIgICAgLmhjYXJkIC5oYm9keXtw"
    "YWRkaW5nLXJpZ2h0OjQ0cHh9XG4iLCAibmV3IjogIiAgICAuaGNhcmQgLmhib2R5e3BhZGRpbmctcmlnaHQ6MH1cbiAgICAu"
    "aGNhcmQuaGFzLWRlbCAuaGJvZHl7cGFkZGluZy1yaWdodDo0NHB4fVxuIn0sIHsib2xkIjogIiAgICAgICAgICBwbGFjZWhv"
    "bGRlcj1cIvCflI0gVMOsbSB0w6puIG5ow7NtIGhv4bq3YyB0w6puIGjhu41jIHNpbmguLi5cIlxuIiwgIm5ldyI6ICIgICAg"
    "ICAgICAgcGxhY2Vob2xkZXI9XCJUw6xtIHTDqm4gbmjDs20gaG/hurdjIHTDqm4gaOG7jWMgc2luaC4uLlwiXG4ifV0="
)

TARGET = "features/star-race/index.html"
OLD_MARKER = "repeat(auto-fill,minmax(190px,1fr))"


def main():
    hunks = json.loads(base64.b64decode("".join(HUNKS_B64)).decode("utf-8"))
    src = io.open(TARGET, encoding="utf-8", newline="").read()

    if OLD_MARKER not in src:
        print("OLD MARKER ABSENT - da patch hoac file da drift, bo qua")
        return 0

    out = src
    for i, h in enumerate(hunks, 1):
        old, new = h["old"], h["new"]
        n = out.count(old)
        if n != 1:
            print("HUNK %d KHONG DUY NHAT (%d lan): %r" % (i, n, old[:60]))
            return 1
        out = out.replace(old, new)

    io.open(TARGET, "w", encoding="utf-8", newline="").write(out)
    print("OK - da patch, bytes:", len(out.encode("utf-8")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
