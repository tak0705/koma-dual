#!/usr/bin/env python3
"""index.html と app.js の ID 整合チェック。

  python3 tests/check_ids.py

見ていること:
  1. index.html の id が重複していないか
  2. app.js が el('...') / getElementById('...') で参照する id が HTML に存在するか
  3. HTML が読み込む script / link / manifest のファイルが実在するか
  4. どの JS からも参照されていない id（消し忘れの目安）を一覧に出す（警告のみ）

異常があれば終了コード 1。外部ライブラリは使わない。
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, "index.html")
APP = os.path.join(ROOT, "app.js")

ID_RE = re.compile(r'\bid="([^"]+)"')
EL_RE = re.compile(r"""\bel\(\s*['"]([^'"]+)['"]\s*\)""")
GET_RE = re.compile(r"""getElementById\(\s*['"]([^'"]+)['"]\s*\)""")
QUERY_ID_RE = re.compile(r"""querySelector(?:All)?\(\s*['"]#([\w-]+)""")
SRC_RE = re.compile(r"""<(?:script|link)[^>]*(?:src|href)="([^"]+)\"""", re.I)


def read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def main() -> int:
    html = read(HTML)
    app = read(APP)

    problems: list[str] = []

    ids = ID_RE.findall(html)
    seen: set[str] = set()
    dups: list[str] = []
    for i in ids:
        if i in seen:
            dups.append(i)
        seen.add(i)
    if dups:
        problems.append("index.html の id が重複: " + ", ".join(sorted(set(dups))))

    refs = set(EL_RE.findall(app)) | set(GET_RE.findall(app)) | set(QUERY_ID_RE.findall(app))
    missing = sorted(refs - seen)
    if missing:
        problems.append("app.js が参照しているのに index.html に無い id: " + ", ".join(missing))

    # HTML が読み込むファイルの実在チェック（外部URLは除外）
    for src in SRC_RE.findall(html):
        if re.match(r"^(https?:)?//|^data:", src):
            continue
        path = os.path.normpath(os.path.join(ROOT, src.lstrip("./")))
        if not os.path.exists(path):
            problems.append(f"index.html が読み込むファイルが無い: {src}")

    unused = sorted(seen - refs)
    print(f"ids in index.html: {len(seen)}  referenced from app.js: {len(refs)}")
    if unused:
        print("  （参照されていない id: " + ", ".join(unused) + "）")

    if problems:
        for p in problems:
            print("NG  " + p, file=sys.stderr)
        return 1

    print("OK  id の重複なし・参照先はすべて存在します")
    return 0


if __name__ == "__main__":
    sys.exit(main())
