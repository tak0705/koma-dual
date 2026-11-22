#!/usr/bin/env python3
"""koma-duel のユニットテストを QuickJS（Python パッケージ）で実行する。

Node が無い環境でも、ブラウザを使わずに本物の JS ロジックをそのまま検証できる。

  pip install quickjs
  python3 tests/run_tests.py

Node がある環境なら `node tests/logic.tests.js` でも同じテストが走る。
"""
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FILES = ["logic.js", "ai.js", "tests/logic.tests.js"]


def main() -> int:
    try:
        import quickjs  # type: ignore
    except ImportError:
        print("quickjs が見つかりません。`pip install quickjs` を実行してください。", file=sys.stderr)
        print("（Node があれば `node tests/logic.tests.js` でも実行できます）", file=sys.stderr)
        return 2

    ctx = quickjs.Context()
    ctx.set_memory_limit(512 * 1024 * 1024)

    started = time.time()
    for rel in FILES:
        path = os.path.join(ROOT, rel)
        with open(path, encoding="utf-8") as fh:
            source = fh.read()
        try:
            ctx.eval(source)
        except Exception as exc:  # noqa: BLE001
            print(f"error while running {rel}: {exc}", file=sys.stderr)
            return 2

    elapsed = time.time() - started
    raw = ctx.eval("JSON.stringify(__KOMA_TEST_RESULTS__)")
    summary = json.loads(raw)

    for failure in summary.get("failures", []):
        print(f"FAIL  {failure['name']}")
        print(f"      {failure.get('error', '')}")

    print()
    print(f"tests: {summary['total']}  passed: {summary['passed']}  failed: {summary['failed']}")
    print(f"engine: QuickJS {getattr(quickjs, '__version__', '')}  time: {elapsed:.2f}s")
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
