#!/usr/bin/env python3
"""index.html の DOM を組み立て、本物の app.js を QuickJS で動かす統合テスト。

  python3 tests/run_dom_tests.py

ブラウザも Node も使わずに、ボタン操作 → 状態 → 描画の配線を検証する
（盤面の描画、重なり表示、ガブ・露出勝ちの演出クラス、ふりかえり、戦績、
保存復元、対面表示、リンク共有の文面まで）。
"""
from __future__ import annotations

import json
import os
import sys
import time
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}


class TreeBuilder(HTMLParser):
    """必要最小限の要素ツリー（tag / attrs / children / text）。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = {"t": "#root", "a": {}, "c": [], "x": ""}
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = {
            "t": tag,
            "a": {k: ("" if v is None else v) for k, v in attrs},
            "c": [],
            "x": "",
        }
        self.stack[-1]["c"].append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.stack.pop()

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i]["t"] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if self.stack[-1]["t"] in ("script", "style"):
            return
        self.stack[-1]["x"] += data


def find(node, tag):
    if node["t"] == tag:
        return node
    for child in node["c"]:
        hit = find(child, tag)
        if hit:
            return hit
    return None


def read(rel: str) -> str:
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


def main() -> int:
    try:
        import quickjs  # type: ignore
    except ImportError:
        print("quickjs が見つかりません。`pip install quickjs` を実行してください。", file=sys.stderr)
        return 2

    parser = TreeBuilder()
    parser.feed(read("index.html"))
    body = find(parser.root, "body")
    if not body:
        print("index.html に <body> がありません", file=sys.stderr)
        return 2

    ctx = quickjs.Context()
    ctx.set_memory_limit(512 * 1024 * 1024)

    started = time.time()
    for rel in ("logic.js", "ai.js"):
        try:
            ctx.eval(read(rel))
        except Exception as exc:  # noqa: BLE001
            print(f"error while loading {rel}: {exc}", file=sys.stderr)
            return 2

    ctx.eval("globalThis.__HTML_SPEC__ = " + json.dumps(body, ensure_ascii=False))
    ctx.eval("globalThis.__APP_SRC__ = " + json.dumps(read("app.js"), ensure_ascii=False))

    try:
        ctx.eval(read("tests/dom_harness.js"))
    except Exception as exc:  # noqa: BLE001
        print(f"error while running tests/dom_harness.js: {exc}", file=sys.stderr)
        return 2

    elapsed = time.time() - started
    raw = ctx.eval("JSON.stringify(__DOM_TEST_RESULTS__)")
    summary = json.loads(raw)

    for failure in summary.get("failures", []):
        print(f"FAIL  {failure['name']}")
        print(f"      {failure.get('error', '')}")

    print()
    print(f"dom tests: {summary['total']}  passed: {summary['passed']}  failed: {summary['failed']}")
    print(f"engine: QuickJS {getattr(quickjs, '__version__', '')}  time: {elapsed:.2f}s")
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
