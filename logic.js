/*!
 * koma-duel  core logic
 * 大中小のコマで上書きできる三目並べ (Gobblet-style, 3x3)
 *
 * DOM に触れない純粋関数だけを置く。ブラウザでは window.KomaLogic、
 * Node / QuickJS では module.exports から使える UMD 形式。
 *
 * 盤面表現:
 *   board = 長さ9の配列。各要素は「下から上」に積まれたコマの配列。
 *   コマ = { p: 1|2 (手番の色), s: 1|2|3 (小・中・大) }
 *   各色とも 小2・中2・大2 の計6個。手持ちは盤面から逆算する。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KomaLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CELLS = 9;
  var HAND_PER_SIZE = 2;
  var LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  var SIZE_NAME = { 1: '小', 2: '中', 3: '大' };

  /* ---------------- 盤面・コマ ---------------- */

  function emptyBoard() {
    var b = [];
    for (var i = 0; i < CELLS; i++) b.push([]);
    return b;
  }

  function createGame() {
    return {
      board: emptyBoard(),
      turn: 1,
      winner: 0,
      winLine: null,
      draw: false,
      moveCount: 0,
      lastMove: null,
      reason: null
    };
  }

  function other(p) { return p === 1 ? 2 : 1; }

  function cloneState(state) {
    var board = [];
    for (var i = 0; i < CELLS; i++) {
      var cell = state.board[i] || [];
      var copy = [];
      for (var k = 0; k < cell.length; k++) copy.push({ p: cell[k].p, s: cell[k].s });
      board.push(copy);
    }
    return {
      board: board,
      turn: state.turn,
      winner: state.winner || 0,
      winLine: state.winLine ? state.winLine.slice() : null,
      draw: !!state.draw,
      moveCount: state.moveCount || 0,
      lastMove: state.lastMove ? cloneMove(state.lastMove) : null,
      reason: state.reason || null
    };
  }

  function cloneMove(m) {
    var c = { t: m.t, s: m.s, to: m.to, p: m.p };
    if (m.from !== undefined) c.from = m.from;
    return c;
  }

  function topIndex(cell) { return cell.length - 1; }

  function topPiece(cell) { return cell.length ? cell[cell.length - 1] : null; }

  /** 手持ちの残り数。盤面に載っているコマを数えて 2 から引く。 */
  function handCounts(state) {
    var used = { 1: { 1: 0, 2: 0, 3: 0 }, 2: { 1: 0, 2: 0, 3: 0 } };
    for (var i = 0; i < CELLS; i++) {
      var cell = state.board[i];
      for (var k = 0; k < cell.length; k++) used[cell[k].p][cell[k].s] += 1;
    }
    var hand = { 1: { 1: 0, 2: 0, 3: 0 }, 2: { 1: 0, 2: 0, 3: 0 } };
    for (var p = 1; p <= 2; p++) {
      for (var s = 1; s <= 3; s++) hand[p][s] = HAND_PER_SIZE - used[p][s];
    }
    return hand;
  }

  /** size のコマをこのマスに置けるか（空 or 一番上より小さいコマ）。 */
  function canPlaceOn(cell, size) {
    var t = topPiece(cell);
    return !t || t.s < size;
  }

  /* ---------------- 合法手 ---------------- */

  /**
   * 手番のプレイヤーの合法手。
   *  place: 手持ちを {t:'place', s, to}
   *  move : 盤上の一番上の自分のコマを {t:'move', from, to, s}
   * 同じ大きさのコマは同価値なので、手持ちはサイズごとに1手へまとめる。
   */
  function legalMoves(state) {
    if (state.winner || state.draw) return [];
    var turn = state.turn;
    var hand = handCounts(state);
    var moves = [];
    var s, to, from;
    for (s = 1; s <= 3; s++) {
      if (hand[turn][s] <= 0) continue;
      for (to = 0; to < CELLS; to++) {
        if (canPlaceOn(state.board[to], s)) moves.push({ t: 'place', s: s, to: to });
      }
    }
    for (from = 0; from < CELLS; from++) {
      var top = topPiece(state.board[from]);
      if (!top || top.p !== turn) continue;
      for (to = 0; to < CELLS; to++) {
        if (to === from) continue;
        if (canPlaceOn(state.board[to], top.s)) {
          moves.push({ t: 'move', from: from, to: to, s: top.s });
        }
      }
    }
    return moves;
  }

  function sameMove(a, b) {
    if (!a || !b) return false;
    if (a.t !== b.t || a.to !== b.to || a.s !== b.s) return false;
    if (a.t === 'move' && a.from !== b.from) return false;
    return true;
  }

  function isLegal(state, move) {
    var moves = legalMoves(state);
    for (var i = 0; i < moves.length; i++) if (sameMove(moves[i], move)) return true;
    return false;
  }

  /* ---------------- 勝敗 ---------------- */

  /** 一番上のコマが player で揃っているライン（無ければ null）。 */
  function findLine(board, player) {
    for (var i = 0; i < LINES.length; i++) {
      var line = LINES[i];
      var ok = true;
      for (var k = 0; k < 3; k++) {
        var t = topPiece(board[line[k]]);
        if (!t || t.p !== player) { ok = false; break; }
      }
      if (ok) return line.slice();
    }
    return null;
  }

  function linesOf(board, player) {
    var out = [];
    for (var i = 0; i < LINES.length; i++) {
      var ok = true;
      for (var k = 0; k < 3; k++) {
        var t = topPiece(board[LINES[i][k]]);
        if (!t || t.p !== player) { ok = false; break; }
      }
      if (ok) out.push(LINES[i].slice());
    }
    return out;
  }

  /**
   * 手を指す。状態は破壊せず、新しい状態を返す。
   *
   * 勝敗判定のポイント（自爆チェック）:
   *  ・指した側がラインを作った → 指した側の勝ち（同時に相手のラインが出てもこちら優先）
   *  ・指したコマを持ち上げたことで、下から出てきた相手のコマで相手が揃った → 相手の勝ち
   */
  function applyMove(state, move) {
    if (!isLegal(state, move)) throw new Error('illegal move: ' + JSON.stringify(move));
    var next = cloneState(state);
    var mover = state.turn;
    var piece;

    if (move.t === 'place') {
      piece = { p: mover, s: move.s };
      next.board[move.to].push(piece);
    } else {
      piece = next.board[move.from].pop();
      next.board[move.to].push(piece);
    }
    next.lastMove = { t: move.t, s: move.s, to: move.to, p: mover };
    if (move.from !== undefined) next.lastMove.from = move.from;
    next.moveCount = (state.moveCount || 0) + 1;

    var mine = findLine(next.board, mover);
    var theirs = findLine(next.board, other(mover));

    if (mine) {
      next.winner = mover;
      next.winLine = mine;
      next.reason = 'line';
    } else if (theirs) {
      next.winner = other(mover);
      next.winLine = theirs;
      next.reason = 'reveal';
    }
    next.turn = other(mover);

    if (!next.winner && legalMoves(next).length === 0) next.draw = true;
    return next;
  }

  /** その手を指したときに相手が「下から出てくる」マス（無ければ -1）。 */
  function exposedCell(move) {
    return move && move.t === 'move' ? move.from : -1;
  }

  /* ---------------- シリアライズ / 共有コード ---------------- */

  var CHAR_OF = { '1-1': 'a', '1-2': 'b', '1-3': 'c', '2-1': 'A', '2-2': 'B', '2-3': 'C' };
  var PIECE_OF = {
    a: { p: 1, s: 1 }, b: { p: 1, s: 2 }, c: { p: 1, s: 3 },
    A: { p: 2, s: 1 }, B: { p: 2, s: 2 }, C: { p: 2, s: 3 }
  };
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function boardToString(board) {
    var cells = [];
    for (var i = 0; i < CELLS; i++) {
      var s = '';
      for (var k = 0; k < board[i].length; k++) {
        s += CHAR_OF[board[i][k].p + '-' + board[i][k].s];
      }
      cells.push(s);
    }
    return cells.join('.');
  }

  /**
   * 盤面文字列を検証しながら復元する。
   * ・マスは9個
   * ・各マスは下から上へ「小→大」の順（同じ大きさは積めない）
   * ・各色・各サイズは最大2個
   */
  function stringToBoard(str) {
    if (typeof str !== 'string') throw new Error('board string required');
    var cells = str.split('.');
    if (cells.length !== CELLS) throw new Error('board must have 9 cells');
    var counts = { 1: { 1: 0, 2: 0, 3: 0 }, 2: { 1: 0, 2: 0, 3: 0 } };
    var board = [];
    for (var i = 0; i < CELLS; i++) {
      var cell = [];
      var prevSize = 0;
      for (var k = 0; k < cells[i].length; k++) {
        var pc = PIECE_OF[cells[i][k]];
        if (!pc) throw new Error('unknown piece: ' + cells[i][k]);
        if (pc.s <= prevSize) throw new Error('stack must grow small to large');
        prevSize = pc.s;
        counts[pc.p][pc.s] += 1;
        if (counts[pc.p][pc.s] > HAND_PER_SIZE) throw new Error('too many pieces');
        cell.push({ p: pc.p, s: pc.s });
      }
      board.push(cell);
    }
    return board;
  }

  function checksum(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % 1296;
  }

  function checksumStr(str) {
    var v = checksum(str);
    var hi = Math.floor(v / 36), lo = v % 36;
    return '0123456789abcdefghijklmnopqrstuvwxyz'.charAt(hi) +
      '0123456789abcdefghijklmnopqrstuvwxyz'.charAt(lo);
  }

  function b64urlEncode(ascii) {
    var out = '';
    var i;
    for (i = 0; i + 2 < ascii.length; i += 3) {
      var n = (ascii.charCodeAt(i) << 16) | (ascii.charCodeAt(i + 1) << 8) | ascii.charCodeAt(i + 2);
      out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) +
        B64.charAt((n >> 6) & 63) + B64.charAt(n & 63);
    }
    var rest = ascii.length - i;
    if (rest === 1) {
      var n1 = ascii.charCodeAt(i) << 16;
      out += B64.charAt((n1 >> 18) & 63) + B64.charAt((n1 >> 12) & 63);
    } else if (rest === 2) {
      var n2 = (ascii.charCodeAt(i) << 16) | (ascii.charCodeAt(i + 1) << 8);
      out += B64.charAt((n2 >> 18) & 63) + B64.charAt((n2 >> 12) & 63) + B64.charAt((n2 >> 6) & 63);
    }
    return out;
  }

  function b64urlDecode(text) {
    var clean = String(text).replace(/[^A-Za-z0-9_-]/g, '');
    var out = '';
    var buf = 0, bits = 0;
    for (var i = 0; i < clean.length; i++) {
      var v = B64.indexOf(clean.charAt(i));
      if (v < 0) throw new Error('bad base64url');
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buf >> bits) & 0xff);
      }
    }
    return out;
  }

  /** 盤面と手番を短い文字列へ（共有リンク用）。 */
  function encodeState(state) {
    var payload = state.turn + '|' + boardToString(state.board);
    return b64urlEncode(payload + '~' + checksumStr(payload));
  }

  /** 共有コードから状態を復元。壊れていれば例外。 */
  function decodeState(code) {
    var raw = b64urlDecode(code);
    var cut = raw.lastIndexOf('~');
    if (cut < 0) throw new Error('code is missing checksum');
    var payload = raw.slice(0, cut);
    var sum = raw.slice(cut + 1);
    if (checksumStr(payload) !== sum) throw new Error('checksum mismatch');
    var bar = payload.indexOf('|');
    if (bar < 0) throw new Error('code is malformed');
    var turn = Number(payload.slice(0, bar));
    if (turn !== 1 && turn !== 2) throw new Error('bad turn');
    var board = stringToBoard(payload.slice(bar + 1));

    var state = {
      board: board,
      turn: turn,
      winner: 0,
      winLine: null,
      draw: false,
      moveCount: 0,
      lastMove: null,
      reason: null
    };
    for (var i = 0; i < CELLS; i++) state.moveCount += board[i].length;

    var one = findLine(board, 1);
    var two = findLine(board, 2);
    if (one && two) { state.winner = 1; state.winLine = one; }
    else if (one) { state.winner = 1; state.winLine = one; }
    else if (two) { state.winner = 2; state.winLine = two; }
    state.reason = state.winner ? 'board' : null;
    if (!state.winner && legalMoves(state).length === 0) state.draw = true;
    return state;
  }

  function encodeMoves(moves) {
    return b64urlEncode(JSON.stringify(moves));
  }

  /** AI の置換表用のキー（手番＋盤面）。 */
  function stateKey(state) {
    return state.turn + '|' + boardToString(state.board);
  }

  function describeMove(move) {
    if (!move) return '';
    if (move.t === 'place') {
      return sizeLabel(move.s) + 'を ' + cellName(move.to) + ' へ';
    }
    return sizeLabel(move.s) + 'を ' + cellName(move.from) + ' から ' + cellName(move.to) + ' へ';
  }

  function sizeLabel(s) { return SIZE_NAME[s] || ''; }

  function cellName(i) {
    if (i === undefined || i === null || i < 0) return '';
    var r = Math.floor(i / 3) + 1, c = (i % 3) + 1;
    return r + '-' + c;
  }

  /* ---------------- 対面表示 ---------------- */

  /** 盤面を180°回したときの位置（3x3）。対面で座る2人対戦用。 */
  function flipIndex(i) {
    if (i === undefined || i === null || i < 0 || i >= CELLS) return i;
    return CELLS - 1 - i;
  }

  /* ---------------- ふりかえり（棋譜） ---------------- */

  var TIMELINE_MAX = 400;

  /** 0手目から最終手までの各局面を、1本の文字列にまとめる（共有コードの連結）。 */
  function encodeTimeline(states) {
    if (!states || !states.length) return '';
    var parts = [];
    for (var i = 0; i < states.length && i < TIMELINE_MAX; i++) {
      parts.push(encodeState(states[i]));
    }
    return parts.join(',');
  }

  /** encodeTimeline の逆。壊れた要素は読み飛ばし、読める範囲だけ返す。 */
  function decodeTimeline(text) {
    if (typeof text !== 'string' || !text) return [];
    var parts = text.split(',');
    if (parts.length > TIMELINE_MAX) parts = parts.slice(0, TIMELINE_MAX);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      try {
        out.push(decodeState(parts[i]));
      } catch (e) { /* 読めない局面は飛ばす */ }
    }
    return out;
  }

  /** ふりかえりで表示するラベル。 */
  function timelineLabel(index, total) {
    var t = Math.max(0, Number(total) || 0);
    var i = Math.min(t, Math.max(0, Number(index) || 0));
    return '第' + i + '手 / ' + t + '手';
  }

  function sameCell(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].p !== b[i].p || a[i].s !== b[i].s) return false;
    }
    return true;
  }

  /**
   * 2つの局面を比べて、間の1手を導く（lastMove を失った履歴の復元用）。
   * 保存や共有コードには「直前の手」が入らないので、盤面の差から作る。
   * 差が読めなければ null。
   */
  function deriveMove(prev, next) {
    if (!prev || !next || !prev.board || !next.board) return null;
    var gained = -1;
    var lost = -1;
    var changed = 0;
    for (var i = 0; i < CELLS; i++) {
      var a = prev.board[i] || [];
      var b = next.board[i] || [];
      if (sameCell(a, b)) continue;
      changed += 1;
      if (b.length === a.length + 1) gained = i;
      else if (a.length === b.length + 1) lost = i;
      else return null;               // 同じマスで2枚以上変わっている場合は読めない
    }
    if (gained < 0) return null;
    var top = next.board[gained][next.board[gained].length - 1];
    if (changed === 1 && lost < 0) {
      return { t: 'place', s: top.s, to: gained, p: top.p };
    }
    if (changed === 2 && lost >= 0) {
      var from = prev.board[lost];
      var moved = from.length ? from[from.length - 1] : null;
      if (!moved || moved.p !== top.p || moved.s !== top.s) return null;
      return { t: 'move', from: lost, to: gained, s: top.s, p: top.p };
    }
    return null;
  }

  /* ---------------- 共有の文面 ---------------- */

  /**
   * LINEなどにそのまま貼れる文面。
   *  kind: 'play'（次の手を指してほしい） / 'result'（結果を送る） / 'room'（部屋へ誘う）
   */
  function shareMessage(state, kind) {
    if (kind === 'result') return 'コマ・デュエルで対局しました！結果はこちら👇';
    if (kind === 'room') return 'コマ・デュエルで部屋対戦しよう！👇';
    var next = ((state && state.moveCount) || 0) + 1;
    return 'コマ・デュエルで対局しよう！第' + next + '手👇';
  }

  /* ---------------- 戦績 ---------------- */

  var STATS_VERSION = 1;
  var STATS_LEVELS = ['easy', 'normal', 'hard'];

  function blankRecord() {
    return { w: 0, l: 0, d: 0, streak: 0, best: 0 };
  }

  function createStats() {
    return {
      v: STATS_VERSION,
      cpu: {
        easy: blankRecord(),
        normal: blankRecord(),
        hard: blankRecord()
      },
      local: { p1: 0, p2: 0, d: 0, games: 0 },
      link: blankRecord()
    };
  }

  function num(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0; }

  function normalizeRecord(raw) {
    var r = { w: num(raw && raw.w), l: num(raw && raw.l), d: num(raw && raw.d), streak: num(raw && raw.streak), best: num(raw && raw.best) };
    if (r.streak > r.best) r.best = r.streak;
    return r;
  }

  /** 保存データから戦績を復元（欠けた項目は0で埋める）。 */
  function normalizeStats(raw) {
    var s = createStats();
    if (!raw || typeof raw !== 'object') return s;
    for (var i = 0; i < STATS_LEVELS.length; i++) {
      s.cpu[STATS_LEVELS[i]] = normalizeRecord(raw.cpu && raw.cpu[STATS_LEVELS[i]]);
    }
    s.link = normalizeRecord(raw.link);
    var loc = raw.local || {};
    s.local = { p1: num(loc.p1), p2: num(loc.p2), d: num(loc.d), games: num(loc.games) };
    if (!s.local.games) s.local.games = s.local.p1 + s.local.p2 + s.local.d;
    return s;
  }

  function resetStats() { return createStats(); }

  /**
   * 1局の結果を戦績へ足した新しい戦績を返す（元は書き換えない）。
   *  info = { mode:'cpu'|'local'|'link'|'room', level:'easy'|'normal'|'hard',
   *           result:'win'|'lose'|'draw' }
   *  local の 'win' は先手（プレイヤー1）の勝ち。
   */
  function recordResult(stats, info) {
    var s = normalizeStats(stats);
    info = info || {};
    var result = info.result === 'win' || info.result === 'lose' ? info.result : 'draw';

    if (info.mode === 'cpu') {
      var lv = STATS_LEVELS.indexOf(info.level) >= 0 ? info.level : 'normal';
      var box = s.cpu[lv];
      if (result === 'win') {
        box.w += 1;
        box.streak += 1;
        if (box.streak > box.best) box.best = box.streak;
      } else if (result === 'lose') {
        box.l += 1;
        box.streak = 0;
      } else {
        box.d += 1;
        box.streak = 0;
      }
    } else if (info.mode === 'local') {
      s.local.games += 1;
      if (result === 'win') s.local.p1 += 1;
      else if (result === 'lose') s.local.p2 += 1;
      else s.local.d += 1;
    } else if (info.mode === 'link' || info.mode === 'room') {
      var lb = s.link;
      if (result === 'win') {
        lb.w += 1;
        lb.streak += 1;
        if (lb.streak > lb.best) lb.best = lb.streak;
      } else if (result === 'lose') {
        lb.l += 1;
        lb.streak = 0;
      } else {
        lb.d += 1;
        lb.streak = 0;
      }
    }
    return s;
  }

  /** CPU全レベルの合計。 */
  function statsCpuTotal(stats) {
    var s = normalizeStats(stats);
    var out = { w: 0, l: 0, d: 0 };
    for (var i = 0; i < STATS_LEVELS.length; i++) {
      out.w += s.cpu[STATS_LEVELS[i]].w;
      out.l += s.cpu[STATS_LEVELS[i]].l;
      out.d += s.cpu[STATS_LEVELS[i]].d;
    }
    return out;
  }

  /**
   * 表示用の1行。scope = 'cpu:easy' | 'cpu:normal' | 'cpu:hard' | 'local' | 'link'
   */
  function statsLine(stats, scope) {
    var s = normalizeStats(stats);
    if (scope === 'local') {
      var loc = s.local;
      if (!loc.games) return 'まだ対局なし';
      var txt = '先手 ' + loc.p1 + ' - ' + loc.p2 + ' 後手';
      if (loc.d) txt += '（引き分け ' + loc.d + '）';
      return txt;
    }
    var box;
    if (scope === 'link') {
      box = s.link;
    } else {
      var lv = String(scope || '').split(':')[1] || 'normal';
      box = s.cpu[STATS_LEVELS.indexOf(lv) >= 0 ? lv : 'normal'];
    }
    var total = box.w + box.l + box.d;
    if (!total) return 'まだ対局なし';
    var out = box.w + '勝' + box.l + '敗';
    if (box.d) out += box.d + '分';
    if (box.streak > 0) out += '・' + box.streak + '連勝中';
    if (box.best > 1) out += '（最高' + box.best + '連勝）';
    return out;
  }

  return {
    CELLS: CELLS,
    LINES: LINES,
    HAND_PER_SIZE: HAND_PER_SIZE,
    SIZE_NAME: SIZE_NAME,
    createGame: createGame,
    emptyBoard: emptyBoard,
    cloneState: cloneState,
    other: other,
    topPiece: topPiece,
    topIndex: topIndex,
    handCounts: handCounts,
    canPlaceOn: canPlaceOn,
    legalMoves: legalMoves,
    isLegal: isLegal,
    sameMove: sameMove,
    findLine: findLine,
    linesOf: linesOf,
    applyMove: applyMove,
    exposedCell: exposedCell,
    boardToString: boardToString,
    stringToBoard: stringToBoard,
    encodeState: encodeState,
    decodeState: decodeState,
    encodeMoves: encodeMoves,
    stateKey: stateKey,
    describeMove: describeMove,
    cellName: cellName,
    flipIndex: flipIndex,
    encodeTimeline: encodeTimeline,
    decodeTimeline: decodeTimeline,
    timelineLabel: timelineLabel,
    deriveMove: deriveMove,
    shareMessage: shareMessage,
    createStats: createStats,
    normalizeStats: normalizeStats,
    resetStats: resetStats,
    recordResult: recordResult,
    statsCpuTotal: statsCpuTotal,
    statsLine: statsLine,
    STATS_LEVELS: STATS_LEVELS,
    TIMELINE_MAX: TIMELINE_MAX
  };
});
