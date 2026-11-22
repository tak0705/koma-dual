/*!
 * koma-duel  AI (ピッコロAI)
 *
 *  easy   : ランダム寄り（たまに即勝ち・阻止を狙う）
 *  normal : 1手読み＋即勝ち／即負け阻止
 *  hard   : 反復深化ミニマックス＋αβ枝刈り＋置換表＋地平線対策
 *
 * ブラウザでは window.KomaAI、Node / QuickJS では module.exports。
 * 探索は盤面を作り直さず「置く→戻す」で進めるので、スマホでも深く読める。
 */
(function (root, factory) {
  var logic = (typeof module === 'object' && module.exports) ? require('./logic.js') : root.KomaLogic;
  var api = factory(logic);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KomaAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (L) {
  'use strict';

  var WIN = 1000000;
  var LINES = L.LINES;
  var B64CH = 'abcdefghij';

  function topOf(cell) { return cell.length ? cell[cell.length - 1] : null; }
  function other(p) { return p === 1 ? 2 : 1; }

  /* ---------------- 盤面ヘルパ ---------------- */

  function cloneBoard(board) {
    var out = [];
    for (var i = 0; i < 9; i++) {
      var cell = board[i], copy = [];
      for (var k = 0; k < cell.length; k++) copy.push({ p: cell[k].p, s: cell[k].s });
      out.push(copy);
    }
    return out;
  }

  function handOf(board) {
    var used = { 1: { 1: 0, 2: 0, 3: 0 }, 2: { 1: 0, 2: 0, 3: 0 } };
    for (var i = 0; i < 9; i++) {
      var cell = board[i];
      for (var k = 0; k < cell.length; k++) used[cell[k].p][cell[k].s] += 1;
    }
    var hand = { 1: { 1: 0, 2: 0, 3: 0 }, 2: { 1: 0, 2: 0, 3: 0 } };
    for (var p = 1; p <= 2; p++) for (var s = 1; s <= 3; s++) hand[p][s] = 2 - used[p][s];
    return hand;
  }

  function canTop(cell, size) {
    var t = topOf(cell);
    return !t || t.s < size;
  }

  /** 盤面から直接、手番 turn の合法手を作る。 */
  function genMoves(board, turn, hand) {
    if (!hand) hand = handOf(board);
    var moves = [];
    for (var s = 1; s <= 3; s++) {
      if (hand[turn][s] <= 0) continue;
      for (var to = 0; to < 9; to++) if (canTop(board[to], s)) moves.push({ t: 'place', s: s, to: to });
    }
    for (var from = 0; from < 9; from++) {
      var top = topOf(board[from]);
      if (!top || top.p !== turn) continue;
      for (var to2 = 0; to2 < 9; to2++) {
        if (to2 === from) continue;
        if (canTop(board[to2], top.s)) moves.push({ t: 'move', from: from, to: to2, s: top.s });
      }
    }
    return moves;
  }

  function applyOnBoard(board, mv, turn) {
    if (mv.t === 'place') {
      board[mv.to].push({ p: turn, s: mv.s });
      return { k: 0, to: mv.to };
    }
    var piece = board[mv.from].pop();
    board[mv.to].push(piece);
    return { k: 1, from: mv.from, to: mv.to };
  }

  function undoOnBoard(board, rec) {
    if (rec.k === 0) board[rec.to].pop();
    else board[rec.from].push(board[rec.to].pop());
  }

  function winnerAfter(board, mover) {
    if (L.findLine(board, mover)) return mover;
    var o = other(mover);
    if (L.findLine(board, o)) return o;
    return 0;
  }

  /** 外部 API 用: 状態を複製して1手進める。 */
  function play(state, mv) {
    var board = cloneBoard(state.board);
    var mover = state.turn;
    applyOnBoard(board, mv, mover);
    var next = {
      board: board,
      turn: other(mover),
      winner: 0,
      winLine: null,
      draw: false,
      moveCount: (state.moveCount || 0) + 1,
      lastMove: mv
    };
    var w = winnerAfter(board, mover);
    if (w) {
      next.winner = w;
      next.winLine = L.findLine(board, w);
    }
    return next;
  }

  /* ---------------- 形勢評価 ---------------- */

  var HAND_W = { 1: 0.10, 2: 0.45, 3: 0.90 };

  /**
   * me から見た形勢。ラインの脅威を主軸に、
   * ・3マス目が相手の大きなコマなら脅威は弱い（上書きしにくい）
   * ・大きいコマを手元に残す価値
   * ・中央・角の位置価値
   * を足す。
   */
  function evalBoard(board, me) {
    var opp = other(me);
    var score = 0;

    for (var i = 0; i < 8; i++) {
      var line = LINES[i];
      var mc = 0, oc = 0, mt = 0, ot = 0, otherSize = 0;
      for (var k = 0; k < 3; k++) {
        var t = topOf(board[line[k]]);
        if (t && t.p === me) { mc++; if (t.s > mt) mt = t.s; }
        else { oc++; if (t) { if (t.s > ot) ot = t.s; otherSize = t.s; } }
      }
      if (oc === 0) {
        score += (mc === 2 ? 17 : mc === 1 ? 2.6 : 0) + mt * 0.5;
      } else if (mc === 0) {
        score -= (oc === 2 ? 17 : oc === 1 ? 2.6 : 0) + ot * 0.5;
      } else if (mc === 2) {
        score += otherSize === 3 ? 5.5 : 13;          // 相手の大は上書きしにくい
      } else if (oc === 2) {
        score -= otherSize === 3 ? 5.5 : 13;
      }
    }

    for (var c = 0; c < 9; c++) {
      var top = topOf(board[c]);
      if (!top) continue;
      var pos = c === 4 ? 2.4 : (c % 2 === 0 ? 1.2 : 0.85);
      var sizeW = top.s === 3 ? 1.5 : top.s === 2 ? 1.1 : 0.8;
      score += (top.p === me ? 1 : -1) * pos * sizeW;
    }

    var hand = handOf(board);
    for (var s = 1; s <= 3; s++) {
      score += (hand[me][s] - hand[opp][s]) * HAND_W[s];
    }
    return score;
  }

  /**
   * 地平線対策: 手番 turn が「手持ちのコマを置くだけ」で勝てるなら true。
   * （動かして勝つ手は、自分のラインを崩す場合があるのでここでは数えない）
   */
  function handWinNow(board, turn, hand, maxHandSize) {
    if (!hand) hand = handOf(board);
    if (maxHandSize === undefined) {
      maxHandSize = 0;
      for (var s = 3; s >= 1; s--) if (hand[turn][s] > 0) { maxHandSize = s; break; }
    }
    if (!maxHandSize) return false;
    for (var i = 0; i < 8; i++) {
      var line = LINES[i];
      var mc = 0, third = -1, bad = false;
      for (var k = 0; k < 3; k++) {
        var t = topOf(board[line[k]]);
        if (t && t.p === turn) mc++;
        else { if (third !== -1) { bad = true; break; } third = line[k]; }
      }
      if (bad || mc !== 2 || third < 0) continue;
      if (canTop(board[third], maxHandSize)) return true;
    }
    return false;
  }

  /* ---------------- 探索 ---------------- */

  function boardKey(board, turn) {
    var out = '';
    for (var i = 0; i < 9; i++) {
      var cell = board[i];
      for (var k = 0; k < cell.length; k++) {
        out += (cell[k].p === 1 ? cell[k].s + 2 : cell[k].s + 5).toString(36);
      }
      out += '.';
    }
    return turn + out;
  }

  function search(board, turn, depth, alpha, beta, me, ctx, ply) {
    if (depth <= 0) {
      var h = handOf(board);
      if (handWinNow(board, turn, h)) return turn === me ? WIN - ply : -(WIN - ply);
      return evalBoard(board, me);
    }

    ctx.nodes++;
    if ((ctx.nodes & 127) === 0 && Date.now() > ctx.deadline) ctx.aborted = true;
    if (ctx.aborted) return evalBoard(board, me);

    var key = boardKey(board, turn) + ':' + depth;
    var cached = ctx.tt.get(key);
    if (cached !== undefined) return cached;

    var hand = handOf(board);
    var moves = genMoves(board, turn, hand);
    if (!moves.length) return 0;

    var maximizing = turn === me;
    var best = maximizing ? -Infinity : Infinity;
    var a0 = alpha, b0 = beta;

    // 並べ替え: 勝てる手を先に、次に形勢の良い手から
    var scored = [];
    for (var i = 0; i < moves.length; i++) {
      var rec = applyOnBoard(board, moves[i], turn);
      var w = winnerAfter(board, turn);
      var sc;
      if (w) sc = w === me ? 1e9 : -1e9;
      else sc = evalBoard(board, me);
      undoOnBoard(board, rec);
      scored.push({ mv: moves[i], w: w, sc: sc });
    }
    scored.sort(function (x, y) { return (maximizing ? y.sc - x.sc : x.sc - y.sc); });

    for (var j = 0; j < scored.length; j++) {
      var s = scored[j];
      var rec2 = applyOnBoard(board, s.mv, turn);
      var v;
      if (s.w) v = s.w === me ? WIN - ply - 1 : -(WIN - ply - 1);
      else v = search(board, other(turn), depth - 1, alpha, beta, me, ctx, ply + 1);
      undoOnBoard(board, rec2);

      if (maximizing) {
        if (v > best) best = v;
        if (best > alpha) alpha = best;
      } else {
        if (v < best) best = v;
        if (best < beta) beta = best;
      }
      if (alpha >= beta) break;
    }
    if (!ctx.aborted && best > a0 && best < b0) {
      if (ctx.tt.size < 200000) ctx.tt.set(key, best);
    }
    return best;
  }

  function rootSearch(board, turn, depth, me, ctx) {
    var hand = handOf(board);
    var moves = genMoves(board, turn, hand);
    if (!moves.length) return { move: null, score: 0, ties: [], aborted: ctx.aborted };

    var scored = [];
    for (var i = 0; i < moves.length; i++) {
      var rec = applyOnBoard(board, moves[i], turn);
      var w = winnerAfter(board, turn);
      var sc = w ? (w === me ? 1e9 : -1e9) : evalBoard(board, me);
      undoOnBoard(board, rec);
      scored.push({ mv: moves[i], w: w, sc: sc });
    }
    scored.sort(function (x, y) { return y.sc - x.sc; });

    var bestMove = scored[0].mv;
    var bestScore = -Infinity;
    var ties = [];
    var alpha = -Infinity, beta = Infinity;
    for (var j = 0; j < scored.length; j++) {
      var s = scored[j];
      var rec2 = applyOnBoard(board, s.mv, turn);
      var v;
      if (s.w) v = s.w === me ? WIN - 1 : -(WIN - 1);
      else v = search(board, other(turn), depth - 1, alpha, beta, me, ctx, 1);
      undoOnBoard(board, rec2);

      if (v > bestScore) { bestScore = v; bestMove = s.mv; ties = [s.mv]; }
      else if (v === bestScore) ties.push(s.mv);
      if (v > alpha) alpha = v;
      if (ctx.aborted) break;
    }
    return { move: bestMove, score: bestScore, ties: ties, aborted: ctx.aborted };
  }

  /** 診断・テスト用: 各合法手をフルウィンドウで探索した値（枝刈りなしと同じ値になるはず）。 */
  function searchValues(state, depth) {
    var board = cloneBoard(state.board);
    var me = state.turn;
    var ctx = { tt: new Map(), nodes: 0, deadline: Infinity, aborted: false };
    var moves = genMoves(board, me, handOf(board));
    var out = [];
    for (var i = 0; i < moves.length; i++) {
      var rec = applyOnBoard(board, moves[i], me);
      var w = winnerAfter(board, me);
      var v;
      if (w) v = w === me ? WIN - 1 : -(WIN - 1);
      else v = search(board, other(me), depth - 1, -Infinity, Infinity, me, ctx, 1);
      undoOnBoard(board, rec);
      out.push({ move: moves[i], value: v });
    }
    return out;
  }

  /* ---------------- 即勝ちの手 ---------------- */

  function immediateWinsState(state, player) {
    var out = [];
    if (state.turn !== player) return out;
    var moves = L.legalMoves(state);
    for (var i = 0; i < moves.length; i++) {
      if (play(state, moves[i]).winner === player) out.push(moves[i]);
    }
    return out;
  }

  function pick(arr, rng) {
    var r = rng ? rng() : Math.random();
    var i = Math.floor(r * arr.length) % arr.length;
    return arr[i];
  }

  /* ---------------- easy ---------------- */

  function easyMove(state, rng) {
    var me = state.turn;
    var moves = L.legalMoves(state);
    if (!moves.length) return null;
    var wins = immediateWinsState(state, me);
    var r = rng();

    if (wins.length && r < 0.55) return pick(wins, rng);

    if (r < 0.68) {
      var blocks = [];
      for (var i = 0; i < moves.length; i++) {
        var child = play(state, moves[i]);
        if (child.winner) continue;
        var om = L.legalMoves(child);
        var found = false;
        for (var k = 0; k < om.length; k++) {
          if (play(child, om[k]).winner === other(me)) { found = true; break; }
        }
        if (found) blocks.push(moves[i]);
      }
      if (blocks.length) return pick(blocks, rng);
    }

    var safe = [];
    for (var j = 0; j < moves.length; j++) {
      if (!play(state, moves[j]).winner) safe.push(moves[j]);
    }
    return pick(safe.length ? safe : moves, rng);
  }

  /* ---------------- normal ---------------- */

  function normalMove(state, rng) {
    var me = state.turn;
    var moves = L.legalMoves(state);
    if (!moves.length) return null;
    var wins = immediateWinsState(state, me);
    if (wins.length) return pick(wins, rng);

    var opp = other(me);
    var bestScore = -Infinity;
    var best = [];
    for (var i = 0; i < moves.length; i++) {
      var child = play(state, moves[i]);
      if (child.winner) continue;                 // 自爆・相手の勝ちになる手は選ばない
      var om = L.legalMoves(child);
      var oppWins = 0;
      for (var k = 0; k < om.length; k++) {
        if (play(child, om[k]).winner === opp) oppWins++;
      }
      var score = -oppWins * 140 + evalBoard(child.board, me);
      if (score > bestScore + 1e-9) { bestScore = score; best = [moves[i]]; }
      else if (score > bestScore - 1e-9) { best.push(moves[i]); }
    }
    if (!best.length) {
      for (var j = 0; j < moves.length; j++) {
        var s2 = evalBoard(play(state, moves[j]).board, me);
        if (s2 > bestScore) { bestScore = s2; best = [moves[j]]; }
      }
    }
    if (!best.length) return pick(moves, rng);
    return pick(best, rng);
  }

  /* ---------------- hard ---------------- */

  function hardMove(state, opts) {
    opts = opts || {};
    var debug = !!opts.debug;
    var t0 = Date.now();
    var me = state.turn;

    if (state.winner || state.draw) {
      return debug ? { move: null, depth: 0, score: 0, nodes: 0, ms: 0 } : null;
    }

    var moves = L.legalMoves(state);
    if (!moves.length) return debug ? { move: null, depth: 0, score: 0, nodes: 0, ms: 0 } : null;

    var wins = immediateWinsState(state, me);
    if (wins.length) {
      return debug ? { move: wins[0], depth: 0, score: WIN, nodes: 0, ms: Date.now() - t0 } : wins[0];
    }

    var board = cloneBoard(state.board);
    var hand = handOf(board);

    // 相手の即勝ちをすべて消せる手を優先候補にする
    var safeMoves = [];
    for (var i = 0; i < moves.length; i++) {
      var rec = applyOnBoard(board, moves[i], me);
      var w = winnerAfter(board, me);
      var ok = !w;
      if (ok) {
        var oppHand = handOf(board);
        var oppMoves = genMoves(board, other(me), oppHand);
        for (var k = 0; k < oppMoves.length; k++) {
          var r2 = applyOnBoard(board, oppMoves[k], other(me));
          var w2 = winnerAfter(board, other(me));
          undoOnBoard(board, r2);
          if (w2 === other(me)) { ok = false; break; }
        }
      }
      undoOnBoard(board, rec);
      if (ok) safeMoves.push(moves[i]);
    }

    var timeMs = (opts.timeMs !== undefined) ? opts.timeMs : 480;
    var maxDepth = (opts.maxDepth !== undefined) ? opts.maxDepth : 8;
    var rng = opts.rng || null;

    var ctx = { tt: new Map(), nodes: 0, deadline: t0 + timeMs, aborted: false };
    var best = safeMoves.length ? safeMoves[0] : moves[0];
    var bestScore = -Infinity;
    var ties = [best];
    var bestDepth = 0;

    for (var d = 1; d <= maxDepth; d++) {
      var res = rootSearch(board, me, d, me, ctx);
      if (res.aborted) break;
      if (res.move) {
        best = res.move;
        bestScore = res.score;
        ties = (res.ties && res.ties.length) ? res.ties : [best];
        bestDepth = d;
      }
      if (bestScore >= WIN - 1000) break;
      if (Date.now() > ctx.deadline) break;
    }

    // 同じ深さで同点だった手だけから選ぶ（浅い値で選び直すと悪手になる）
    if (rng && ties.length > 1) best = ties[Math.floor(rng() * ties.length) % ties.length];

    if (debug) {
      return { move: best, depth: bestDepth, score: bestScore, nodes: ctx.nodes, ms: Date.now() - t0, ties: ties.length };
    }
    return best;
  }

  function chooseMove(state, level, opts) {
    opts = opts || {};
    if (!state || state.winner || state.draw) return null;
    var rng = opts.rng || null;
    if (level === 'easy') return easyMove(state, rng || Math.random);
    if (level === 'hard') return hardMove(state, opts);
    return normalMove(state, rng || Math.random);
  }

  return {
    WIN: WIN,
    chooseMove: chooseMove,
    play: play,
    evalBoard: evalBoard,
    immediateWins: immediateWinsState,
    handWinNow: handWinNow,
    genMoves: genMoves,
    handOf: handOf,
    easyMove: function (s, rng) { return easyMove(s, rng || Math.random); },
    normalMove: function (s, rng) { return normalMove(s, rng || Math.random); },
    hardMove: function (s, opts) { return hardMove(s, opts || {}); },
    searchValues: searchValues,
    analyze: function (s, opts) { return hardMove(s, Object.assign({}, opts || {}, { debug: true })); }
  };
});
