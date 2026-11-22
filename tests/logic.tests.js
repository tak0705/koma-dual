/*!
 * koma-duel  logic + AI unit tests
 *
 * どこでも同じテストを走らせる:
 *   Node:    node tests/logic.tests.js
 *   QuickJS: python3 tests/run_tests.py   (Node が無い環境向け)
 *   ブラウザ: tests/tests.html
 *
 * 依存ライブラリなし。失敗すると終了コード 1（Node）／failed > 0（それ以外）。
 */
(function (global) {
  'use strict';

  var isNode = typeof module === 'object' && module.exports;
  var L = isNode ? require('../logic.js') : global.KomaLogic;
  var AI = isNode ? require('../ai.js') : global.KomaAI;

  if (!L) throw new Error('KomaLogic が読み込まれていません (logic.js を先に読み込む)');
  if (!AI) throw new Error('KomaAI が読み込まれていません (ai.js を先に読み込む)');

  /* ---------------- tiny test framework ---------------- */

  var results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name: name, ok: true });
    } catch (e) {
      results.push({ name: name, ok: false, error: (e && e.message) ? e.message : String(e) });
    }
  }

  function fail(msg) { throw new Error(msg); }

  function eq(actual, expected, msg) {
    var a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) fail((msg ? msg + ': ' : '') + 'expected ' + b + ' but got ' + a);
  }

  function ok(value, msg) { if (!value) fail(msg || 'expected truthiness'); }

  function throws(fn, msg) {
    var didThrow = false;
    try { fn(); } catch (e) { didThrow = true; }
    if (!didThrow) fail((msg || 'expected an error') + ' (何も投げなかった)');
  }

  /* ---------------- helpers ---------------- */

  // 9マスの文字列配列から状態を作る（各セルは下→上のコマ）
  function fromCells(cells, turn) {
    return {
      board: L.stringToBoard(cells.join('.')),
      turn: turn || 1,
      winner: 0,
      winLine: null,
      draw: false,
      moveCount: 0,
      lastMove: null,
      reason: null
    };
  }

  function emptyCells() {
    var a = [];
    for (var i = 0; i < 9; i++) a.push('');
    return a;
  }

  function withCells(pairs) {
    var cells = emptyCells();
    for (var i = 0; i < pairs.length; i++) cells[pairs[i][0]] = pairs[i][1];
    return cells;
  }

  function hasMove(list, move) {
    for (var i = 0; i < list.length; i++) if (L.sameMove(list[i], move)) return true;
    return false;
  }

  function legalHas(state, move, msg) {
    ok(hasMove(L.legalMoves(state), move), (msg || 'move should be legal') + ' ' + JSON.stringify(move));
  }

  function legalNot(state, move, msg) {
    ok(!hasMove(L.legalMoves(state), move), (msg || 'move should be illegal') + ' ' + JSON.stringify(move));
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ================= 盤面と手持ち ================= */

  test('初期状態: 9マス空・先手・手持ちは各サイズ2個', function () {
    var g = L.createGame();
    eq(g.board.length, 9);
    eq(g.turn, 1);
    eq(g.winner, 0);
    var hand = L.handCounts(g);
    eq(hand, { 1: { 1: 2, 2: 2, 3: 2 }, 2: { 1: 2, 2: 2, 3: 2 } });
    for (var i = 0; i < 9; i++) eq(g.board[i].length, 0);
  });

  test('初期状態の合法手は 3サイズ × 9マス = 27手', function () {
    eq(L.legalMoves(L.createGame()).length, 27);
  });

  test('手持ちは盤面から逆算される（置くと減り、戻ると増える）', function () {
    var g = L.createGame();                       // 手番1
    var s1 = L.applyMove(g, { t: 'place', s: 1, to: 4 });   // 先手が小を置く
    eq(L.handCounts(s1)[1][1], 1);
    eq(L.handCounts(s1)[2][1], 2);
    var s2 = L.applyMove(s1, { t: 'place', s: 1, to: 0 });  // 後手が小を置く
    eq(L.handCounts(s2)[2][1], 1);
    var s3 = L.applyMove(s2, { t: 'move', from: 4, to: 8, s: 1 });  // 先手が動かす
    eq(L.handCounts(s3)[2][1], 1);
    eq(L.handCounts(s3)[1][1], 1, '移動では手持ちは減らない');
  });

  /* ================= 上書き制限 ================= */

  test('空マスには置ける', function () {
    var st = fromCells(emptyCells(), 1);
    legalHas(st, { t: 'place', s: 1, to: 0 });
    legalHas(st, { t: 'place', s: 3, to: 8 });
  });

  test('小さい相手のコマの上には置ける（ガブ）', function () {
    var st = fromCells(withCells([[1, 'A']]), 1);
    legalHas(st, { t: 'place', s: 2, to: 1 }, '中で小を上書きできる');
    legalHas(st, { t: 'place', s: 3, to: 1 }, '大で小を上書きできる');
  });

  test('同じ大きさ・大きいコマの上には置けない', function () {
    var st = fromCells(withCells([[1, 'B']]), 1);
    legalNot(st, { t: 'place', s: 2, to: 1 }, '同サイズは不可');
    legalNot(st, { t: 'place', s: 1, to: 1 }, '小で中は不可');
    legalHas(st, { t: 'place', s: 3, to: 1 }, '大で中は可');
  });

  test('自分の小さいコマの上にも置ける', function () {
    var st = fromCells(withCells([[5, 'a']]), 1);
    legalHas(st, { t: 'place', s: 2, to: 5 });
  });

  test('手持ちが無いサイズは置けない', function () {
    // 先手の小を2個とも盤面へ
    var st = fromCells(withCells([[0, 'a'], [1, 'a']]), 1);
    legalNot(st, { t: 'place', s: 1, to: 4 }, '小は残り0');
    legalHas(st, { t: 'place', s: 2, to: 4 });
  });

  /* ================= 移動 ================= */

  test('一番上の自分のコマだけ動かせる', function () {
    var st = fromCells(withCells([[0, 'ab']]), 1); // 小の上に中
    legalNot(st, { t: 'move', from: 0, to: 4, s: 1 }, '下のコマは動かせない');
    legalHas(st, { t: 'move', from: 0, to: 4, s: 2 }, '上のコマは動かせる');
  });

  test('相手のコマは動かせない', function () {
    var st = fromCells(withCells([[0, 'A']]), 1);
    legalNot(st, { t: 'move', from: 0, to: 4, s: 1 });
  });

  test('移動先は空マス or より小さいコマの上だけ', function () {
    var st = fromCells(withCells([[0, 'b'], [1, 'A'], [2, 'B'], [3, 'a']]), 1);
    legalHas(st, { t: 'move', from: 0, to: 4, s: 2 }, '空マスへ');
    legalHas(st, { t: 'move', from: 0, to: 1, s: 2 }, '小の上へ');
    legalNot(st, { t: 'move', from: 0, to: 2, s: 2 }, '同サイズの上へは不可');
    legalNot(st, { t: 'move', from: 0, to: 0, s: 2 }, '同じマスへは不可');
  });

  test('移動すると下のコマが出てくる', function () {
    var st = fromCells(withCells([[0, 'Ab']]), 1); // 後手小の上に先手中
    var next = L.applyMove(st, { t: 'move', from: 0, to: 4, s: 2 });
    eq(next.board[0].length, 1);
    eq(next.board[0][0], { p: 2, s: 1 });
    eq(next.board[4][0], { p: 1, s: 2 });
  });

  /* ================= 勝敗 ================= */

  test('自分のコマで縦横斜め3つ揃えば勝ち（置き）', function () {
    var st = fromCells(withCells([[0, 'b'], [1, 'b']]), 1);
    var next = L.applyMove(st, { t: 'place', s: 1, to: 2 });
    eq(next.winner, 1);
    eq(next.winLine, [0, 1, 2]);
    eq(next.reason, 'line');
    eq(next.turn, 2);
  });

  test('相手の小さいコマを上書きして3つ揃えても勝ち', function () {
    var st = fromCells(withCells([[0, 'b'], [1, 'b'], [2, 'A']]), 1);
    var next = L.applyMove(st, { t: 'place', s: 3, to: 2 });
    eq(next.winner, 1);
    eq(next.board[2].length, 2);
    eq(next.board[2][1], { p: 1, s: 3 });
  });

  test('上に相手のコマがあるとラインにならない', function () {
    var st = fromCells(withCells([[0, 'a'], [1, 'a'], [2, 'A']]), 1);
    eq(L.findLine(st.board, 1), null);
  });

  test('斜めのラインも判定する', function () {
    var st = fromCells(withCells([[0, 'C'], [4, 'C']]), 2);
    var next = L.applyMove(st, { t: 'place', s: 1, to: 8 });
    eq(next.winner, 2);
    eq(next.winLine, [0, 4, 8]);
  });

  test('自爆: コマを持ち上げて相手のラインが露出したら相手の勝ち', function () {
    // 後手が 0-1-2 に小を3つ。1 は先手の中に覆われている。
    var st = fromCells(withCells([[0, 'A'], [1, 'Ab'], [2, 'B']]), 1);
    eq(L.findLine(st.board, 2), null, '覆われている間はラインではない');
    var next = L.applyMove(st, { t: 'move', from: 1, to: 3, s: 2 });
    eq(next.winner, 2);
    eq(next.reason, 'reveal');
    eq(next.winLine, [0, 1, 2]);
    eq(next.board[1][0], { p: 2, s: 1 });
  });

  test('持ち上げても揃わないときは勝敗なし', function () {
    var st = fromCells(withCells([[0, 'A'], [1, 'Ab']]), 1);
    var next = L.applyMove(st, { t: 'move', from: 1, to: 3, s: 2 });
    eq(next.winner, 0);
    eq(next.reason, null);
  });

  test('指した側のラインと露出した相手のラインが同時なら指した側の勝ち', function () {
    // 後手 0-1-2 のライン（1 は先手の中に覆われている）
    // 先手は 6-7-8 に揃えようと、1 の中を 8 へ動かす
    var st = fromCells(withCells([[0, 'A'], [1, 'Ab'], [2, 'B'], [6, 'a'], [7, 'a']]), 1);
    var next = L.applyMove(st, { t: 'move', from: 1, to: 8, s: 2 });
    eq(next.winner, 1);
    eq(next.reason, 'line');
    eq(next.winLine, [6, 7, 8]);
  });

  test('applyMove は元の状態を書き換えない', function () {
    var st = fromCells(withCells([[0, 'a'], [1, 'A']]), 1);
    var before = JSON.stringify(st);
    L.applyMove(st, { t: 'place', s: 3, to: 1 });
    eq(JSON.stringify(st), before);
  });

  test('決着後の合法手は無い', function () {
    var st = fromCells(withCells([[0, 'b'], [1, 'b']]), 1);
    var next = L.applyMove(st, { t: 'place', s: 1, to: 2 });
    eq(L.legalMoves(next).length, 0);
  });

  /* ================= シリアライズ ================= */

  test('空盤面の往復', function () {
    var g = L.createGame();
    var code = L.encodeState(g);
    var back = L.decodeState(code);
    eq(L.boardToString(back.board), L.boardToString(g.board));
    eq(back.turn, 1);
    eq(back.winner, 0);
  });

  test('積み重なった盤面と手番の往復', function () {
    var st = fromCells(withCells([[0, 'a'], [1, 'Ab'], [4, 'Bc'], [8, 'A']]), 2);
    var back = L.decodeState(L.encodeState(st));
    eq(L.boardToString(back.board), L.boardToString(st.board));
    eq(back.turn, 2);
    eq(back.moveCount, 6);
  });

  test('共有コードは短く、URLにそのまま入れられる', function () {
    var st = fromCells(withCells([[0, 'a'], [1, 'Ab'], [4, 'Bc'], [8, 'A']]), 2);
    var code = L.encodeState(st);
    ok(code.length < 40, 'code should stay short, got ' + code.length);
    ok(/^[A-Za-z0-9_-]+$/.test(code), 'code must be url-safe: ' + code);
  });

  test('盤面から勝敗を復元する', function () {
    var st = fromCells(withCells([[0, 'c'], [1, 'c'], [2, 'b']]), 2);
    var back = L.decodeState(L.encodeState(st));
    eq(back.winner, 1);
    eq(back.winLine, [0, 1, 2]);
  });

  test('壊れたコードは例外になる', function () {
    var code = L.encodeState(L.createGame());
    var flip = code.charAt(3) === 'A' ? 'B' : 'A';
    var broken = code.slice(0, 3) + flip + code.slice(4);
    throws(function () { L.decodeState(broken); }, 'チェックサム不一致');
    throws(function () { L.decodeState(code + 'AA'); }, '末尾の改変');
    throws(function () { L.decodeState('!!!not-a-code!!!'); }, '不正な文字列');
    throws(function () { L.decodeState(''); }, '空文字');
  });

  test('不正な盤面（コマ過多・順序・マス数）は拒否する', function () {
    throws(function () { L.stringToBoard('aaa........'); }, '同じ色の小が3個');
    throws(function () { L.stringToBoard('ba........'); }, '小→大の順でない');
    throws(function () { L.stringToBoard('aa........'); }, '同じ大きさは積めない');
    throws(function () { L.stringToBoard('.......'); }, 'マスが8個');
    throws(function () { L.stringToBoard('x........'); }, '未知のコマ');
  });

  test('同じ盤面でも手番が違えば別のキーになる', function () {
    var st = fromCells(withCells([[4, 'a']]), 1);
    var st2 = L.cloneState(st);
    st2.turn = 2;
    ok(L.stateKey(st) !== L.stateKey(st2));
  });

  /* ================= AI ================= */

  test('AI（全レベル）は常に合法手を返す', function () {
    var rng = mulberry32(20261122);
    var levels = ['easy', 'normal', 'hard'];
    for (var li = 0; li < levels.length; li++) {
      for (var game = 0; game < 6; game++) {
        var st = L.createGame();
        var guard = 0;
        while (!st.winner && !st.draw && guard++ < 60) {
          var mv = AI.chooseMove(st, levels[li], { rng: mulberry32(game * 97 + guard), timeMs: 120, maxDepth: 5 });
          ok(mv, levels[li] + ': 合法手があるのに null が返った');
          ok(L.isLegal(st, mv), levels[li] + ': 非法な手 ' + JSON.stringify(mv));
          st = L.applyMove(st, mv);
        }
        ok(st.winner !== 0 || st.draw || guard >= 60, '決着か手数上限で終わる');
      }
    }
  });

  test('AI は決着済みの局面で null を返す', function () {
    var st = fromCells(withCells([[0, 'c'], [1, 'c'], [2, 'b']]), 2);
    var won = L.decodeState(L.encodeState(st));
    eq(AI.chooseMove(won, 'hard'), null);
  });

  test('上級AIは即勝ちの手を選ぶ', function () {
    var st = fromCells(withCells([[0, 'b'], [1, 'b']]), 1);
    var mv = AI.chooseMove(st, 'hard', { timeMs: 300 });
    eq(mv.to, 2);
    eq(AI.play(st, mv).winner, 1);
  });

  test('上級AIは相手の即勝ちを阻止する', function () {
    var st = fromCells(withCells([[4, 'a'], [6, 'A'], [7, 'A']]), 1);
    var mv = AI.chooseMove(st, 'hard', { timeMs: 300 });
    var after = AI.play(st, mv);
    eq(after.winner, 0, '相手に即勝ちを許さない');
    var oppWins = 0;
    var om = L.legalMoves(after);
    for (var i = 0; i < om.length; i++) if (AI.play(after, om[i]).winner === 2) oppWins++;
    eq(oppWins, 0, '相手の即勝ちが残っていない');
  });

  test('中級AIは即勝ちの手を選ぶ', function () {
    var st = fromCells(withCells([[3, 'b'], [4, 'b']]), 1);
    var mv = AI.chooseMove(st, 'normal', { rng: mulberry32(7) });
    eq(AI.play(st, mv).winner, 1);
  });

  test('αβ探索の値は素のミニマックスと完全に一致する', function () {
    // 枝刈りで値がずれると読みが壊れるので、地平線の扱いまで含めて照合する
    function plain(st, depth, me, ply) {
      if (st.winner) return st.winner === me ? AI.WIN - ply : -(AI.WIN - ply);
      if (depth <= 0) {
        if (AI.handWinNow(st.board, st.turn)) return st.turn === me ? AI.WIN - ply : -(AI.WIN - ply);
        return AI.evalBoard(st.board, me);
      }
      var moves = L.legalMoves(st);
      if (!moves.length) return 0;
      var best = st.turn === me ? -Infinity : Infinity;
      for (var i = 0; i < moves.length; i++) {
        var v = plain(AI.play(st, moves[i]), depth - 1, me, ply + 1);
        if (st.turn === me) { if (v > best) best = v; }
        else if (v < best) best = v;
      }
      return best;
    }

    var setups = [
      [[3, 4], [3, 0], [2, 8]],       // 大が中央と角
      [[3, 4], [1, 0], [1, 8], [2, 6]]
    ];
    for (var s = 0; s < setups.length; s++) {
      var st = L.createGame();
      for (var m = 0; m < setups[s].length; m++) {
        st = L.applyMove(st, { t: 'place', s: setups[s][m][0], to: setups[s][m][1] });
      }
      var depth = s === 0 ? 3 : 2;
      var vals = AI.searchValues(st, depth);
      for (var i = 0; i < vals.length; i++) {
        var ref = plain(AI.play(st, vals[i].move), depth - 1, st.turn, 1);
        eq(vals[i].value, ref, 'depth ' + depth + ' ' + L.describeMove(vals[i].move));
      }
    }
  });

  test('上級AIは2手詰み（二重の脅威）を見つける', function () {
    // 先手は中を 1-2 と 2-1 に。後手の大は盤上に出ていて手元に無い。
    // 先手が大を 1-1 に置くと 1-3 と 3-1 の両方が受からない。
    var st = fromCells(withCells([[1, 'b'], [3, 'b'], [5, 'C'], [7, 'C']]), 1);
    var mv = AI.hardMove(st, { timeMs: 400 });
    var after = L.applyMove(st, mv);
    var replies = L.legalMoves(after).filter(function (r) { return !AI.play(after, r).winner; });
    ok(replies.length > 0, '相手に応手がある');
    for (var i = 0; i < replies.length; i++) {
      var after2 = L.applyMove(after, replies[i]);
      var canWin = L.legalMoves(after2).some(function (m) { return AI.play(after2, m).winner === 1; });
      ok(canWin, 'どんな応手でも次に勝てる（応手: ' + L.describeMove(replies[i]) + '）');
    }
  });

  test('初級AIも自爆ばかりはしない（合法手のみ）', function () {
    var rng = mulberry32(99);
    var st = fromCells(withCells([[0, 'A'], [1, 'Ab'], [2, 'B']]), 1);
    for (var i = 0; i < 20; i++) {
      var mv = AI.chooseMove(st, 'easy', { rng: mulberry32(i + 1) });
      ok(L.isLegal(st, mv), '合法手のみ返す');
    }
    ok(rng() >= 0 && rng() <= 1);
  });

  /* ---------------- report ---------------- */

  var failed = 0;
  for (var i = 0; i < results.length; i++) if (!results[i].ok) failed++;

  var summary = {
    total: results.length,
    passed: results.length - failed,
    failed: failed,
    failures: results.filter(function (r) { return !r.ok; }),
    items: results.map(function (r) { return { name: r.name, ok: r.ok, error: r.error || '' }; })
  };

  if (typeof console !== 'undefined' && console && console.log) {
    for (var j = 0; j < results.length; j++) {
      var r = results[j];
      if (!r.ok) console.log('FAIL  ' + r.name + '\n      ' + r.error);
    }
    console.log('');
    console.log('tests: ' + summary.total + ' / passed: ' + summary.passed + ' / failed: ' + summary.failed);
  }

  global.__KOMA_TEST_RESULTS__ = summary;

  if (isNode) {
    process.exitCode = failed ? 1 : 0;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
