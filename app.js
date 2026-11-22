/*!
 * koma-duel  app.js — 画面まわり（盤面・手札・対戦モード・リンク共有）
 *
 * 依存: logic.js (window.KomaLogic), ai.js (window.KomaAI)
 */
(function () {
  'use strict';

  var L = window.KomaLogic;
  var AI = window.KomaAI;
  if (!L || !AI) {
    document.body.innerHTML = '<p style="padding:24px;font:14px/1.7 sans-serif;color:#eee">' +
      '読み込みに失敗しました。ページを再読み込みしてください。</p>';
    return;
  }

  var LEVEL_LABEL = { easy: '初級', normal: '中級', hard: '上級' };
  var LEVEL_HINT = {
    easy: 'ランダム寄り。たまに勝ちや阻止を狙う',
    normal: '1手読みで即勝ちと阻止をする',
    hard: '先まで読む上級。αβ探索で攻める'
  };
  var STORE_KEY = 'komaDuell.v1';
  var AI_NAME = 'ピッコロAI';
  var PLAYER_TAG = { 1: '先手', 2: '後手' };

  function el(id) { return document.getElementById(id); }
  function make(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  /* =====================================================================
     状態
     ===================================================================== */

  var S = {
    mode: 'menu',        // menu | cpu | local | link | room
    me: 1,               // 自分が担当するプレイヤー番号（下側に表示）
    level: 'normal',
    state: null,
    history: [],         // 各手を指す前の状態（待った用）
    sel: null,           // {kind:'hand', size} | {kind:'board', cell}
    busy: false,         // AI 思考中など
    thinking: false,
    over: false,
    sound: true,
    room: null,
    pollTimer: null,
    animKey: '',
    gen: 0,
    saved: null
  };

  function bumpGen() { S.gen += 1; return S.gen; }

  /* =====================================================================
     効果音（Web Audio API）
     ===================================================================== */

  var Sound = (function () {
    var ctx = null;

    function ensure() {
      if (!S.sound) return null;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) {
        try { ctx = new AC(); } catch (e) { return null; }
      }
      if (ctx.state === 'suspended' && ctx.resume) { try { ctx.resume(); } catch (e) {} }
      return ctx;
    }

    function tone(freq, dur, type, vol, slideTo) {
      var c = ensure();
      if (!c) return;
      try {
        var o = c.createOscillator();
        var g = c.createGain();
        o.type = type || 'sine';
        o.frequency.setValueAtTime(freq, c.currentTime);
        if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + dur);
        g.gain.setValueAtTime(0.0001, c.currentTime);
        g.gain.exponentialRampToValueAtTime(vol || 0.14, c.currentTime + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
        o.connect(g);
        g.connect(c.destination);
        o.start();
        o.stop(c.currentTime + dur + 0.03);
      } catch (e) { /* 音が出なくても遊べる */ }
    }

    function seq(freqs, dur, vol, gap) {
      for (var i = 0; i < freqs.length; i++) {
        (function (f, i2) {
          setTimeout(function () { tone(f, dur, 'sine', vol); }, i2 * gap);
        })(freqs[i], i);
      }
    }

    return {
      unlock: function () { ensure(); },
      tap: function () { tone(760, 0.04, 'sine', 0.05); },
      pick: function () { tone(640, 0.06, 'sine', 0.08, 760); },
      place: function () { tone(520, 0.09, 'sine', 0.16, 700); },
      gobble: function () { tone(340, 0.14, 'triangle', 0.2, 170); },
      move: function () { tone(430, 0.1, 'sine', 0.13, 580); },
      invalid: function () { tone(160, 0.12, 'square', 0.07, 120); },
      win: function () { seq([523, 659, 784, 1047], 0.2, 0.13, 92); },
      lose: function () { seq([392, 330, 262], 0.24, 0.11, 118); },
      draw: function () { seq([440, 440], 0.18, 0.09, 150); }
    };
  })();

  /* =====================================================================
     小物
     ===================================================================== */

  var toastTimer = null;
  function toast(msg) {
    var t = el('toast');
    t.textContent = msg;
    t.hidden = false;
    requestAnimationFrame(function () { t.classList.add('on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove('on');
      setTimeout(function () { t.hidden = true; }, 240);
    }, 2100);
  }

  var confirmCb = null;
  function askConfirm(title, note, okLabel, cb) {
    el('confirm-title').textContent = title;
    el('confirm-note').textContent = note || '';
    el('btn-confirm-ok').textContent = okLabel || 'OK';
    confirmCb = cb;
    el('confirm-modal').hidden = false;
  }
  function closeConfirm() {
    el('confirm-modal').hidden = true;
    confirmCb = null;
  }

  function showRules() { el('rules-modal').hidden = false; }
  function hideRules() { el('rules-modal').hidden = true; }

  function hideResult() {
    el('result-modal').hidden = true;
    S.over = false;
  }

  /* =====================================================================
     保存 / 復元
     ===================================================================== */

  function save() {
    try {
      if (!S.state || S.mode === 'menu') return;
      localStorage.setItem(STORE_KEY, JSON.stringify({
        mode: S.mode,
        me: S.me,
        level: S.level,
        sound: S.sound,
        state: L.encodeState(S.state),
        at: Date.now()
      }));
    } catch (e) { /* 保存できなくても遊べる */ }
  }

  function loadSaved() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !d.state) return null;
      d.decoded = L.decodeState(d.state);
      return d;
    } catch (e) { return null; }
  }

  /* =====================================================================
     ユーティリティ
     ===================================================================== */

  function bottomPlayer() { return S.mode === 'local' ? 1 : S.me; }

  function playerName(p) {
    if (S.mode === 'cpu') return p === 1 ? 'あなた' : AI_NAME;
    if (S.mode === 'link' || S.mode === 'room') return p === S.me ? 'あなた' : 'あいて';
    return 'プレイヤー' + p;
  }

  function canControl(player) {
    var st = S.state;
    if (!st || st.winner || st.draw || S.busy || S.thinking) return false;
    if (S.mode === 'local') return player === st.turn;
    return player === S.me && st.turn === player;
  }

  function canPlayNow() { return canControl(S.state.turn); }

  function setModeLabel() {
    var map = {
      cpu: 'CPU対戦（' + LEVEL_LABEL[S.level] + '）',
      local: '2人対戦（この1台で）',
      link: 'リンク対戦',
      room: '部屋コード対戦'
    };
    el('mode-label').textContent = map[S.mode] || '大中小の三目並べ';
  }

  /* =====================================================================
     画面の切り替え
     ===================================================================== */

  function showMenu() {
    stopPolling();
    el('screen-menu').classList.remove('hidden');
    el('screen-game').classList.add('hidden');
    el('mode-label').textContent = '大中小の三目並べ';
    refreshResume();
  }

  function showGame() {
    el('screen-menu').classList.add('hidden');
    el('screen-game').classList.remove('hidden');
    setModeLabel();
  }

  function refreshResume() {
    var saved = loadSaved() || S.saved;
    var btn = el('btn-resume');
    if (saved && saved.decoded && !saved.decoded.winner) {
      var what = saved.mode === 'cpu' ? 'CPU・' + (LEVEL_LABEL[saved.level] || '中級')
        : saved.mode === 'local' ? '2人対戦'
        : saved.mode === 'room' ? '部屋コード対戦'
        : 'リンク対戦';
      btn.hidden = false;
      btn.textContent = '前回の続きから（' + what + '）';
    } else {
      btn.hidden = true;
    }
  }

  /* =====================================================================
     ゲーム開始
     ===================================================================== */

  function startGame(mode, opts) {
    opts = opts || {};
    bumpGen();
    S.mode = mode;
    S.level = opts.level || S.level;
    S.me = opts.me || 1;
    S.state = opts.state || L.createGame();
    S.history = [];
    S.sel = null;
    S.busy = false;
    S.thinking = false;
    S.over = false;
    S.animKey = '';
    if (opts.room !== undefined) S.room = opts.room;
    if (mode !== 'room') S.room = null;

    hideShare();
    hideResult();
    showGame();
    save();
    render();

    if (S.state.winner || S.state.draw) {
      var g0 = S.gen;
      setTimeout(function () { if (g0 === S.gen && !S.over) onGameOver(); }, 420);
      return;
    }
    if (mode === 'cpu') maybeAI();
    if (mode === 'room') pollRoom();
  }

  function restart() {
    bumpGen();
    S.state = L.createGame();
    S.history = [];
    S.sel = null;
    S.busy = false;
    S.thinking = false;
    S.over = false;
    S.animKey = '';
    if (S.mode === 'link' || S.mode === 'room') S.me = 1;
    hideResult();
    hideShare();
    save();
    render();
    if (S.mode === 'cpu' && S.state.turn !== S.me) maybeAI();
    if (S.mode === 'link' || S.mode === 'room') {
      toast(S.mode === 'link' ? '新しい対局です。あなたが先手です' : '新しい対局をはじめました');
    }
  }

  /* =====================================================================
     描画
     ===================================================================== */

  function render() {
    if (!S.state) return;
    var st = S.state;
    var bp = bottomPlayer();
    var tp = L.other(bp);

    el('name-top').textContent = playerName(tp);
    el('name-bottom').textContent = playerName(bp);
    el('tag-top').textContent = PLAYER_TAG[tp];
    el('tag-bottom').textContent = PLAYER_TAG[bp];
    el('dot-top').className = 'pdot p' + tp;
    el('dot-bottom').className = 'pdot p' + bp;
    el('panel-top').classList.toggle('active', st.turn === tp && !st.winner);
    el('panel-top').classList.toggle('p1', tp === 1);
    el('panel-top').classList.toggle('p2', tp === 2);
    el('panel-bottom').classList.toggle('active', st.turn === bp && !st.winner);
    el('panel-bottom').classList.toggle('p1', bp === 1);
    el('panel-bottom').classList.toggle('p2', bp === 2);

    renderHand(el('hand-top'), tp);
    renderHand(el('hand-bottom'), bp);
    renderBoard();
    renderWinLine();
    renderStatus();

    el('btn-undo').disabled = S.history.length === 0 || S.busy || S.thinking;
    el('btn-share').hidden = !(S.mode === 'link' || S.mode === 'room');

    // リンク対戦: 自分の手を指した直後だけ共有ボックスを出す
    if (S.mode === 'link') {
      if (st.winner || st.turn !== S.me) showShare();
      else hideShare();
    } else if (S.mode === 'room') {
      showShare();      // 部屋コード対戦は招待リンクを常に出しておく
    }
  }

  function renderHand(container, player) {
    var hand = L.handCounts(S.state);
    container.innerHTML = '';
    [3, 2, 1].forEach(function (size) {
      var count = hand[player][size];
      var b = make('button', 'hand-piece p' + player);
      b.type = 'button';
      b.dataset.size = String(size);
      b.dataset.player = String(player);
      b.disabled = count === 0 || !canControl(player);
      b.setAttribute('aria-label', L.SIZE_NAME[size] + 'のコマ 残り' + count + '個');
      if (S.sel && S.sel.kind === 'hand' && S.sel.size === size && canControl(player)) {
        b.classList.add('on');
      }
      var chip = make('span', 'disc chip p' + player + ' s' + size);
      b.appendChild(chip);
      var badge = make('span', 'hand-count');
      badge.textContent = String(count);
      b.appendChild(badge);
      container.appendChild(b);
    });
  }

  function targets() {
    var out = {};
    if (!S.sel || !canPlayNow()) return out;
    var moves = L.legalMoves(S.state);
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      if (S.sel.kind === 'hand') {
        if (m.t === 'place' && m.s === S.sel.size) out[m.to] = 1;
      } else if (m.t === 'move' && m.from === S.sel.cell) {
        out[m.to] = 1;
      }
    }
    return out;
  }

  function renderBoard() {
    var st = S.state;
    var boardEl = el('board');
    var tgt = targets();
    var key = st.moveCount + ':' + (st.winner || 0) + ':' + (st.draw ? 'd' : '');
    var animate = key !== S.animKey;
    S.animKey = key;

    boardEl.innerHTML = '';
    for (var i = 0; i < 9; i++) {
      var cell = make('button', 'cell');
      cell.type = 'button';
      cell.dataset.i = String(i);
      cell.setAttribute('role', 'gridcell');

      var stack = st.board[i];
      var label = 'マス' + (Math.floor(i / 3) + 1) + '-' + (i % 3 + 1);
      if (stack.length) {
        var top = stack[stack.length - 1];
        label += '・上のコマ ' + (top.p === 1 ? '金' : '青') + L.SIZE_NAME[top.s];
        cell.classList.add('has-piece');
      } else {
        label += '・空き';
      }
      cell.setAttribute('aria-label', label);

      if (tgt[i]) {
        cell.classList.add('target');
        if (st.turn === 2) cell.classList.add('p2');
      }
      if (S.sel && S.sel.kind === 'board' && S.sel.cell === i) cell.classList.add('picked');
      if (st.lastMove && st.lastMove.to === i) cell.classList.add('last');
      if (st.winLine && st.winLine.indexOf(i) >= 0) cell.classList.add('win');

      for (var k = 0; k < stack.length; k++) {
        var pc = stack[k];
        var piece = make('span', 'disc piece p' + pc.p + ' s' + pc.s + (k === stack.length - 1 ? ' top' : ''));
        piece.style.setProperty('--d', String(stack.length - 1 - k));
        if (animate && st.lastMove && st.lastMove.to === i && k === stack.length - 1) {
          piece.classList.add('pop');
        }
        cell.appendChild(piece);
      }
      boardEl.appendChild(cell);
    }
  }

  function cellCenter(i) {
    var boardEl = el('board');
    var W = boardEl.clientWidth || 300;
    var pad = 7, gap = 7;
    var cell = (W - pad * 2 - gap * 2) / 3;
    var c = i % 3, r = Math.floor(i / 3);
    var k = 300 / W;
    return {
      x: (pad + c * (cell + gap) + cell / 2) * k,
      y: (pad + r * (cell + gap) + cell / 2) * k
    };
  }

  function renderWinLine() {
    var st = S.state;
    var layer = el('win-layer');
    var line = el('win-line');
    if (!st.winLine || st.winLine.length < 2) {
      layer.classList.remove('on');
      return;
    }
    var a = cellCenter(st.winLine[0]);
    var b = cellCenter(st.winLine[st.winLine.length - 1]);
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x));
    line.setAttribute('y2', String(b.y));
    // アニメーションをやり直す
    layer.classList.remove('on');
    void layer.offsetWidth;
    layer.classList.add('on');
  }

  function renderStatus() {
    var st = S.state;
    var dot = el('turn-dot');
    var text = el('turn-text');
    var sub = el('turn-sub');

    dot.className = 'turn-dot' + (st.turn === 2 ? ' p2' : '');

    if (st.winner) {
      text.textContent = S.mode === 'local'
        ? playerName(st.winner) + 'の勝ち'
        : (st.winner === S.me ? 'あなたの勝ち' : playerName(st.winner) + 'の勝ち');
      sub.textContent = st.reason === 'reveal' ? '下から相手のライン' : '';
      return;
    }
    if (st.draw) {
      text.textContent = '引き分け';
      sub.textContent = '';
      return;
    }

    var mine = (S.mode === 'local') ? null : (st.turn === S.me);

    if (S.thinking) {
      text.textContent = AI_NAME + 'が考え中…';
      sub.textContent = '';
      return;
    }

    if (S.mode === 'local') {
      text.textContent = playerName(st.turn) + 'の番';
      sub.textContent = PLAYER_TAG[st.turn] + '・' + (st.turn === 1 ? '金' : '青');
    } else if (mine) {
      text.textContent = 'あなたの番';
      sub.textContent = S.mode === 'link' || S.mode === 'room'
        ? '指したらリンクを送ります'
        : PLAYER_TAG[st.turn];
    } else {
      text.textContent = (S.mode === 'cpu' ? AI_NAME : 'あいて') + 'の番';
      sub.textContent = S.mode === 'link' || S.mode === 'room' ? 'リンクの到着を待っています' : '';
    }
  }

  /* =====================================================================
     操作
     ===================================================================== */

  function onCell(i) {
    if (!canPlayNow()) {
      if (S.thinking || S.busy) return;
      var st0 = S.state;
      var t0 = L.topPiece(st0.board[i]);
      if (!st0.winner && !st0.draw && t0 && t0.p === st0.turn && S.mode !== 'local') {
        // 相手の番に自分のコマを触った
        toast('まだ相手の番です');
      }
      return;
    }
    var st = S.state;
    var top = L.topPiece(st.board[i]);

    if (S.sel) {
      if (S.sel.kind === 'board' && S.sel.cell === i) {
        S.sel = null;
        Sound.tap();
        render();
        return;
      }
      var mv = S.sel.kind === 'hand'
        ? { t: 'place', s: S.sel.size, to: i }
        : { t: 'move', from: S.sel.cell, to: i, s: S.sel.size };

      if (L.isLegal(st, mv)) { commit(mv); return; }

      if (top && top.p === st.turn) {          // 選び直し
        S.sel = { kind: 'board', cell: i };
        Sound.pick();
        render();
        return;
      }
      Sound.invalid();
      shakeCell(i);
      return;
    }

    if (top && top.p === st.turn) {
      S.sel = { kind: 'board', cell: i };
      Sound.pick();
      render();
    } else if (top) {
      toast('相手のコマは動かせません');
    } else {
      toast('下の手札か、自分のコマを選んでからタップ');
    }
  }

  function shakeCell(i) {
    var cell = el('board').querySelector('.cell[data-i="' + i + '"]');
    if (!cell) return;
    cell.classList.remove('shake');
    void cell.offsetWidth;
    cell.classList.add('shake');
  }

  function onHand(size, player) {
    if (!canPlayNow() || player !== S.state.turn) return;
    var hand = L.handCounts(S.state);
    if (hand[player][size] <= 0) { Sound.invalid(); return; }
    if (S.sel && S.sel.kind === 'hand' && S.sel.size === size) {
      S.sel = null;
      Sound.tap();
      render();
      return;
    }
    S.sel = { kind: 'hand', size: size };
    Sound.pick();
    render();
  }

  /* =====================================================================
     1手進める
     ===================================================================== */

  function commit(mv) {
    var prev = S.state;
    var next;
    try {
      next = L.applyMove(prev, mv);
    } catch (e) {
      Sound.invalid();
      return;
    }
    S.history.push(L.cloneState(prev));
    S.state = next;
    S.sel = null;

    var gobbled = prev.board[mv.to] && prev.board[mv.to].length > 0;
    if (gobbled) Sound.gobble();
    else if (mv.t === 'move') Sound.move();
    else Sound.place();

    save();
    render();

    if (S.mode === 'room') pushRoom();      // 決着の局面も相手へ送る

    if (next.winner || next.draw) {
      var gen = S.gen;
      setTimeout(function () { if (gen === S.gen) onGameOver(); }, 620);
      return;
    }
    if (S.mode === 'cpu') maybeAI();
  }

  /* =====================================================================
     ピッコロAI
     ===================================================================== */

  function maybeAI() {
    var st = S.state;
    if (S.mode !== 'cpu' || !st || st.winner || st.draw) return;
    if (st.turn === S.me) return;

    S.thinking = true;
    render();

    var gen = S.gen;
    setTimeout(function () {
      if (gen !== S.gen) return;          // やり直し・待ったの後なら何もしない
      var mv = null;
      try {
        var opts = { rng: Math.random };
        if (S.level === 'hard') {
          opts.timeMs = 520;
          opts.maxDepth = 8;
        }
        mv = AI.chooseMove(S.state, S.level, opts);
      } catch (e) {
        mv = null;
      }
      S.thinking = false;
      if (gen !== S.gen) return;
      if (!mv) { render(); return; }
      commit(mv);
    }, 300);
  }

  /* =====================================================================
     決着
     ===================================================================== */

  function onGameOver() {
    if (S.over) return;
    S.over = true;
    S.sel = null;
    render();

    var st = S.state;
    var winner = st.winner;
    var badge = el('result-badge');
    var title = el('result-title');
    var note = el('result-note');
    var shareBtn = el('btn-result-share');

    badge.className = 'result-badge';
    shareBtn.hidden = !(S.mode === 'link' || S.mode === 'room');

    if (!winner) {
      badge.textContent = '引き分け';
      badge.classList.add('draw');
      title.textContent = '引き分け';
      note.textContent = 'どちらも決め手を欠きました。';
      Sound.draw();
    } else if (S.mode === 'local') {
      badge.textContent = '勝負あり';
      title.textContent = playerName(winner) + 'の勝ち！';
      note.textContent = winner === 1 ? '金（先手）の勝ちです。' : '青（後手）の勝ちです。';
      Sound.win();
    } else if (S.mode === 'cpu') {
      var iWon = winner === S.me;
      badge.textContent = iWon ? '勝ち' : '負け';
      if (!iWon) badge.classList.add('lose');
      title.textContent = iWon ? 'あなたの勝ち！' : AI_NAME + 'の勝ち';
      note.textContent = st.reason === 'reveal'
        ? 'コマを持ち上げた下から相手のラインが出ました。'
        : (iWon ? 'お見事。' : 'もう一回どうぞ。');
      if (iWon) Sound.win(); else Sound.lose();
    } else {
      var mine = winner === S.me;
      badge.textContent = mine ? '勝ち' : '負け';
      if (!mine) badge.classList.add('lose');
      title.textContent = mine ? 'あなたの勝ち！' : 'あいての勝ち';
      note.textContent = st.reason === 'reveal'
        ? 'コマを持ち上げた下から相手のラインが出ました。'
        : '';
      if (mine) Sound.win(); else Sound.lose();
    }

    el('result-modal').hidden = false;
  }

  /* =====================================================================
     待った / やり直し
     ===================================================================== */

  function undo() {
    if (S.busy || S.thinking || !S.history.length) return;
    bumpGen();

    if (S.mode === 'cpu') {
      // 自分の手番の直前まで戻す（AIの手も一緒に取り消す）
      var idx = -1;
      for (var i = S.history.length - 1; i >= 0; i--) {
        if (S.history[i].turn === S.me) { idx = i; break; }
      }
      if (idx < 0) idx = 0;
      S.state = S.history[idx];
      S.history = S.history.slice(0, idx);
    } else {
      S.state = S.history.pop();
    }
    S.sel = null;
    hideResult();
    S.over = false;
    S.animKey = '';
    save();
    render();
  }

  /* =====================================================================
     共有リンク
     ===================================================================== */

  function makeShareUrl(state, me) {
    var base = location.href.split('#')[0];
    return base + '#g=' + L.encodeState(state) + '&me=' + me;
  }

  function showShare() {
    if (S.mode !== 'link' && S.mode !== 'room') return;
    var st = S.state;
    var me = st.winner ? L.other(st.winner) : st.turn;
    var url;
    if (S.mode === 'room' && S.room && S.room.id) {
      url = location.href.split('#')[0] + '#room=' + S.room.id;
      el('share-title').textContent = '部屋に招待する';
      el('share-hint').textContent = '同じ部屋コードの相手と自動で同期します。';
    } else {
      url = makeShareUrl(st, me);
      el('share-title').textContent = st.winner ? '結果の盤面を送る' : 'あなたの手を相手に送る';
      el('share-hint').textContent = st.winner
        ? 'リンクを開くと、この盤面と結果が見えます。'
        : '相手がリンクを開いて指すと、また新しいリンクが届きます。';
    }
    var input = el('share-url');
    var wasHidden = el('share-box').hidden;
    input.value = url;
    el('share-box').hidden = false;
    el('btn-share').hidden = false;
    if (wasHidden) {
      setTimeout(function () {
        try { el('share-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
      }, 60);
    }
  }

  function hideShare() {
    el('share-box').hidden = true;
    if (S.mode !== 'link' && S.mode !== 'room') el('btn-share').hidden = true;
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? 'コピーしました' : '長押しでコピーしてください');
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast('コピーしました'); }, fallback);
    } else {
      fallback();
    }
  }

  function nativeShare() {
    var url = el('share-url').value;
    if (!url) return;
    if (navigator.share) {
      navigator.share({
        title: 'コマ・デュエル',
        text: 'コマ・デュエルのつづきです。あなたの番！',
        url: url
      }).catch(function () {});
    } else {
      copyText(url);
    }
  }

  function parseShareText(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    var g = t.match(/[#&?]g=([A-Za-z0-9_-]+)/);
    var me = t.match(/[#&?]me=([12])/);
    var r = t.match(/[#&?]room=([A-Za-z0-9]+)/i);
    if (g) return { code: g[1], me: me ? Number(me[1]) : null };
    if (r) return { room: r[1].toUpperCase() };
    if (/^[A-Za-z0-9_-]{8,}$/.test(t)) return { code: t, me: null };
    if (/^[A-Za-z0-9]{6}$/.test(t)) return { room: t.toUpperCase() };
    return null;
  }

  function openShared(code, meParam) {
    var st;
    try {
      st = L.decodeState(code);
    } catch (e) {
      toast('リンクが壊れているようです');
      return false;
    }
    var me = (meParam === 1 || meParam === 2) ? meParam : (st.winner ? L.other(st.winner) : st.turn);
    startGame('link', { me: me, state: st });
    return true;
  }

  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return null;
    var out = {};
    var parts = h.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (!kv[0]) continue;
      out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    }
    return out;
  }

  function clearHash() {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }

  /* =====================================================================
     部屋コード（Vercel など API があるときだけ）
     ===================================================================== */

  function apiRoom(payload) {
    return fetch('api/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error('status ' + res.status);
      return res.json();
    });
  }

  function setRoomStatus(msg) { el('room-status').textContent = msg || ''; }

  function createRoom() {
    setRoomStatus('部屋をつくっています…');
    apiRoom({ action: 'create', code: L.encodeState(L.createGame()) }).then(function (r) {
      S.room = { id: r.room, seat: 1, token: r.token, seq: r.seq || 0 };
      setRoomStatus('部屋コード: ' + r.room + '（相手に送ってください）');
      startGame('room', { me: 1, room: S.room });
      toast('部屋コード ' + r.room + ' を作りました');
    }).catch(function () {
      setRoomStatus('このサイトでは部屋コードを使えません（リンク対戦で遊べます）');
      Sound.invalid();
    });
  }

  function joinRoom(code) {
    var room = String(code || '').trim().toUpperCase();
    if (!room) return;
    setRoomStatus('部屋に入っています…');
    apiRoom({ action: 'join', room: room }).then(function (r) {
      var st = L.decodeState(r.code);
      S.room = { id: room, seat: r.seat, token: r.token, seq: r.seq || 0 };
      setRoomStatus('');
      startGame('room', { me: r.seat, state: st, room: S.room });
      toast('部屋 ' + room + ' に入りました');
    }).catch(function () {
      setRoomStatus('部屋が見つかりません（サーバーが無いサイトでは使えません）');
      Sound.invalid();
    });
  }

  function pushRoom() {
    if (!S.room || S.mode !== 'room') return;
    apiRoom({
      action: 'push',
      room: S.room.id,
      token: S.room.token,
      code: L.encodeState(S.state)
    }).then(function (r) {
      if (r && r.seq) S.room.seq = r.seq;
    }).catch(function () {});
  }

  function pollRoom() {
    stopPolling();
    if (S.mode !== 'room' || !S.room) return;
    S.pollTimer = setTimeout(function () {
      apiRoom({ action: 'pull', room: S.room.id, since: S.room.seq }).then(function (r) {
        if (!r || !r.code) return;
        if (r.seq > S.room.seq) {
          var st = L.decodeState(r.code);
          S.room.seq = r.seq;
          if (st.turn === S.me || st.winner || st.draw) {
            S.state = st;
            S.history = [];
            S.sel = null;
            S.animKey = '';
            save();
            render();
            if (st.winner || st.draw) onGameOver();
          }
        }
      }).catch(function () {}).then(function () {
        if (S.mode === 'room' && S.state && !S.state.winner) pollRoom();
      });
    }, 1600);
  }

  function stopPolling() {
    if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; }
  }

  /* =====================================================================
     イベント
     ===================================================================== */

  function bind() {
    // メニュー
    el('btn-start-cpu').addEventListener('click', function () {
      Sound.unlock();
      startGame('cpu', { level: S.level, me: 1 });
    });
    el('btn-start-local').addEventListener('click', function () {
      Sound.unlock();
      startGame('local', { me: 1 });
    });
    el('btn-start-link').addEventListener('click', function () {
      Sound.unlock();
      startGame('link', { me: 1 });
      toast('あなたが先手。1手指すと送るリンクが出ます');
    });
    el('btn-open-link').addEventListener('click', function () {
      el('link-error').textContent = '';
      el('link-input').value = '';
      el('link-modal').hidden = false;
    });
    el('btn-resume').addEventListener('click', function () {
      var saved = loadSaved() || S.saved;
      if (!saved || !saved.decoded) { toast('続きの対局がありません'); return; }
      Sound.unlock();
      if (saved.mode === 'room') {
        // 部屋コードは保存していないので、そのままリンク対戦として続ける
        startGame('link', { me: saved.me || 1, level: saved.level, state: saved.decoded });
      } else {
        startGame(saved.mode || 'local', { me: saved.me || 1, level: saved.level, state: saved.decoded });
      }
    });

    // 強さ
    var seg = el('level-seg');
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-level]');
      if (!b) return;
      S.level = b.dataset.level;
      Array.prototype.forEach.call(seg.querySelectorAll('button'), function (x) {
        x.classList.toggle('on', x === b);
      });
      el('level-hint').textContent = LEVEL_HINT[S.level] || '';
      if (S.mode === 'cpu' && S.state) setModeLabel();
      Sound.tap();
    });

    // ヘッダ
    el('btn-home').addEventListener('click', function () {
      if (S.mode === 'menu' || !S.state) return;
      if (S.state.winner || S.state.draw) { showMenu(); return; }
      askConfirm('メニューへ戻りますか？', '対局は保存され、メニューの「前回の続きから」で戻れます。', '戻る', function () {
        closeConfirm();
        showMenu();
        refreshResume();
      });
    });

    el('btn-sound').addEventListener('click', function () {
      S.sound = !S.sound;
      el('btn-sound').classList.toggle('off', !S.sound);
      el('btn-sound').setAttribute('aria-pressed', S.sound ? 'true' : 'false');
      if (S.sound) { Sound.unlock(); Sound.tap(); }
      save();
    });

    el('btn-rules').addEventListener('click', showRules);
    el('btn-rules-2').addEventListener('click', showRules);
    el('btn-rules-close').addEventListener('click', hideRules);
    el('btn-rules-ok').addEventListener('click', hideRules);
    el('rules-modal').addEventListener('click', function (e) {
      if (e.target === el('rules-modal')) hideRules();
    });

    // 盤面
    el('board').addEventListener('click', function (e) {
      var cell = e.target.closest('.cell');
      if (!cell) return;
      onCell(parseInt(cell.dataset.i, 10));
    });

    // 手札
    ['hand-top', 'hand-bottom'].forEach(function (id) {
      el(id).addEventListener('click', function (e) {
        var b = e.target.closest('.hand-piece');
        if (!b || b.disabled) return;
        onHand(parseInt(b.dataset.size, 10), parseInt(b.dataset.player, 10));
      });
    });

    // 操作
    el('btn-undo').addEventListener('click', undo);
    el('btn-restart').addEventListener('click', function () {
      askConfirm('やり直しますか？', 'いまの対局は消えます。', 'やり直す', function () {
        closeConfirm();
        restart();
      });
    });
    el('btn-share').addEventListener('click', function () {
      var box = el('share-box');
      if (box.hidden) { showShare(); return; }
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    el('btn-copy').addEventListener('click', function () { copyText(el('share-url').value); });
    el('btn-share-native').addEventListener('click', nativeShare);

    // 結果
    el('btn-again').addEventListener('click', function () {
      hideResult();
      restart();
    });
    el('btn-result-share').addEventListener('click', function () {
      el('result-modal').hidden = true;
      showShare();
      var box = el('share-box');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    el('btn-result-menu').addEventListener('click', function () {
      hideResult();
      showMenu();
    });

    el('result-modal').addEventListener('click', function (e) {
      if (e.target === el('result-modal')) hideResult();
    });

    // 確認
    el('btn-confirm-cancel').addEventListener('click', closeConfirm);
    el('btn-confirm-ok').addEventListener('click', function () {
      var cb = confirmCb;
      confirmCb = null;
      el('confirm-modal').hidden = true;
      if (cb) cb();
    });

    // リンク入力
    el('btn-link-close').addEventListener('click', function () { el('link-modal').hidden = true; });
    el('btn-link-open').addEventListener('click', function () {
      var parsed = parseShareText(el('link-input').value);
      if (!parsed) {
        el('link-error').textContent = 'リンクの形が正しくないようです。もう一度コピーしてください。';
        return;
      }
      el('link-modal').hidden = true;
      if (parsed.room) { joinRoom(parsed.room); return; }
      if (!openShared(parsed.code, parsed.me)) {
        el('link-modal').hidden = false;
        el('link-error').textContent = 'このリンクは読み取れませんでした。';
      }
    });

    // 部屋コード
    el('btn-create-room').addEventListener('click', createRoom);
    el('btn-join-room').addEventListener('click', function () {
      joinRoom(el('room-code-input').value);
    });
    el('room-code-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') joinRoom(el('room-code-input').value);
    });

    // 画面サイズ変更で勝利ラインを引き直す
    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { if (S.state) renderWinLine(); }, 120);
    });

    // 最初のタップで音を有効にする（iOS対策）
    var unlock = function () {
      Sound.unlock();
      document.removeEventListener('pointerdown', unlock);
    };
    document.addEventListener('pointerdown', unlock);

    // Escape で閉じる
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!el('link-modal').hidden) el('link-modal').hidden = true;
      else if (!el('confirm-modal').hidden) closeConfirm();
      else if (!el('rules-modal').hidden) hideRules();
      else if (!el('result-modal').hidden) hideResult();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPolling();
      else if (S.mode === 'room' && S.state && !S.state.winner) pollRoom();
    });
  }

  /* =====================================================================
     起動
     ===================================================================== */

  function boot() {
    var saved = loadSaved();
    if (saved) {
      S.saved = saved;
      if (typeof saved.sound === 'boolean') S.sound = saved.sound;
      if (saved.level) S.level = saved.level;
    }
    el('btn-sound').classList.toggle('off', !S.sound);
    el('btn-sound').setAttribute('aria-pressed', S.sound ? 'true' : 'false');
    el('level-hint').textContent = LEVEL_HINT[S.level] || '';
    Array.prototype.forEach.call(el('level-seg').querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.level === S.level);
    });

    bind();
    refreshResume();

    var params = readHash();
    if (params && params.g) {
      if (openShared(params.g, params.me ? Number(params.me) : null)) {
        clearHash();
        return;
      }
    }
    if (params && params.room) {
      clearHash();
      joinRoom(params.room);
      return;
    }

    if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
