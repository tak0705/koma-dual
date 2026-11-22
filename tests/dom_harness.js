/*!
 * koma-duel  tests/dom_harness.js — ブラウザ無しで DOM を組み立て、app.js を実際に動かす
 *
 * QuickJS（Python パッケージ）で走る。run_dom_tests.py が index.html を解析した
 * 要素ツリー（__HTML_SPEC__）と app.js のソース（__APP_SRC__）を渡す。
 * 画面の配線（ボタン → 状態 → 描画）を、本物の app.js のまま検証する。
 *
 * 依存ライブラリなし。失敗は __DOM_TEST_RESULTS__.failed に数える。
 */
(function (global) {
  'use strict';

  var L = global.KomaLogic;
  var SPEC = global.__HTML_SPEC__;
  var APP_SRC = global.__APP_SRC__;

  if (!L) throw new Error('KomaLogic が読み込まれていません');
  if (!SPEC) throw new Error('__HTML_SPEC__ がありません（run_dom_tests.py から実行してください）');
  if (!APP_SRC) throw new Error('__APP_SRC__ がありません');

  /* =====================================================================
     極小 DOM 実装
     ===================================================================== */

  var idMap = {};
  var store = {};
  var timers = [];
  var timerSeq = 0;
  var virtualNow = 0;

  function camel(name) {
    return String(name).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
  }

  /** 再現可能な乱数（AI の手も毎回同じにする）。 */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function parseSel(sel) {
    var out = { tag: '', cls: [], attrs: [] };
    var rest = String(sel).trim();
    var m = rest.match(/^[A-Za-z][\w-]*/);
    if (m) { out.tag = m[0].toUpperCase(); rest = rest.slice(m[0].length); }
    var re = /(?:\.([\w-]+))|(?:\[([\w-]+)(?:="([^"]*)")?\])/g;
    var mm;
    while ((mm = re.exec(rest))) {
      if (mm[1]) out.cls.push(mm[1]);
      else if (mm[2]) out.attrs.push({ name: mm[2], value: mm[3] });
    }
    return out;
  }

  function matchSel(el, sel) {
    if (!el || !el.tagName) return false;
    var s = typeof sel === 'string' ? parseSel(sel) : sel;
    if (s.tag && el.tagName !== s.tag) return false;
    for (var i = 0; i < s.cls.length; i++) if (el._classes.indexOf(s.cls[i]) < 0) return false;
    for (var j = 0; j < s.attrs.length; j++) {
      var a = s.attrs[j];
      var v = el.getAttribute(a.name);
      if (v === null || v === undefined) return false;
      if (a.value !== undefined && String(v) !== String(a.value)) return false;
    }
    return true;
  }

  function ClassList(el) { this.el = el; }
  ClassList.prototype.contains = function (c) { return this.el._classes.indexOf(c) >= 0; };
  ClassList.prototype.add = function () {
    for (var i = 0; i < arguments.length; i++) {
      var c = arguments[i];
      if (c && this.el._classes.indexOf(c) < 0) this.el._classes.push(c);
    }
  };
  ClassList.prototype.remove = function () {
    for (var i = 0; i < arguments.length; i++) {
      var k = this.el._classes.indexOf(arguments[i]);
      if (k >= 0) this.el._classes.splice(k, 1);
    }
  };
  ClassList.prototype.toggle = function (c, force) {
    var has = this.contains(c);
    var want = force === undefined ? !has : !!force;
    if (want && !has) this.el._classes.push(c);
    if (!want && has) this.remove(c);
    return want;
  };

  function El(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this._text = '';
    this._classes = [];
    this._listeners = {};
    this._classList = null;
    this.dataset = {};
    this.style = { setProperty: function (k, v) { this[k] = v; } };
    this.disabled = false;
    this._hidden = false;
    this.value = '';
    this.clientWidth = 300;
    this.clientHeight = 300;
    this.offsetWidth = 300;
    this.type = '';
    this.readOnly = false;
  }

  Object.defineProperty(El.prototype, 'className', {
    get: function () { return this._classes.join(' '); },
    set: function (v) { this._classes = String(v === null || v === undefined ? '' : v).split(/\s+/).filter(Boolean); }
  });

  Object.defineProperty(El.prototype, 'classList', {
    get: function () {
      if (!this._classList) this._classList = new ClassList(this);
      return this._classList;
    }
  });

  Object.defineProperty(El.prototype, 'id', {
    get: function () { return this.attrs.id || ''; },
    set: function (v) { this.attrs.id = String(v); idMap[String(v)] = this; }
  });

  Object.defineProperty(El.prototype, 'textContent', {
    get: function () { return this._text; },
    set: function (v) { this._text = String(v === null || v === undefined ? '' : v); this.children = []; }
  });

  Object.defineProperty(El.prototype, 'innerHTML', {
    get: function () { return ''; },
    set: function (v) { if (String(v) === '') this.children = []; }
  });

  Object.defineProperty(El.prototype, 'hidden', {
    get: function () { return this._hidden; },
    set: function (v) { this._hidden = !!v; }
  });

  El.prototype.getAttribute = function (name) {
    if (name === 'class') return this.className;
    if (name === 'id') return this.attrs.id === undefined ? null : this.attrs.id;
    if (name.indexOf('data-') === 0) {
      var key = camel(name.slice(5));
      return this.dataset[key] === undefined ? null : String(this.dataset[key]);
    }
    return this.attrs[name] === undefined ? null : this.attrs[name];
  };

  El.prototype.setAttribute = function (name, value) {
    if (name === 'class') { this.className = value; return; }
    if (name === 'id') { this.id = value; return; }
    if (name === 'hidden') { this._hidden = !!value; return; }
    if (name.indexOf('data-') === 0) { this.dataset[camel(name.slice(5))] = String(value); return; }
    this.attrs[name] = String(value);
  };

  El.prototype.removeAttribute = function (name) {
    if (name === 'class') { this._classes = []; return; }
    if (name.indexOf('data-') === 0) { delete this.dataset[camel(name.slice(5))]; return; }
    delete this.attrs[name];
  };

  El.prototype.appendChild = function (child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  };

  El.prototype.removeChild = function (child) {
    var i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  };

  El.prototype.querySelectorAll = function (sel) {
    var out = [];
    (function walk(node) {
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (matchSel(c, sel)) out.push(c);
        walk(c);
      }
    })(this);
    return out;
  };

  El.prototype.querySelector = function (sel) {
    var all = this.querySelectorAll(sel);
    return all.length ? all[0] : null;
  };

  El.prototype.closest = function (sel) {
    var node = this;
    while (node && node.tagName) {
      if (matchSel(node, sel)) return node;
      node = node.parentNode;
    }
    return null;
  };

  El.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };

  El.prototype.removeEventListener = function (type, fn) {
    var list = this._listeners[type] || [];
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };

  El.prototype.scrollIntoView = function () {};
  El.prototype.select = function () {};
  El.prototype.setSelectionRange = function () {};
  El.prototype.focus = function () {};

  /* ---------------- document / window / タイマー ---------------- */

  var doc = {
    readyState: 'complete',
    hidden: false,
    title: '',
    body: null,
    documentElement: null,
    _listeners: {},
    getElementById: function (id) { return idMap[id] || null; },
    createElement: function (tag) { return new El(tag); },
    addEventListener: function (type, fn) {
      (doc._listeners[type] = doc._listeners[type] || []).push(fn);
    },
    removeEventListener: function (type, fn) {
      var list = doc._listeners[type] || [];
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }
  };

  var location = {
    href: 'https://koma.test/index.html',
    protocol: 'https:',
    host: 'koma.test',
    pathname: '/index.html',
    search: '',
    hash: ''
  };

  var winListeners = {};

  function addTimer(fn, ms) {
    var id = ++timerSeq;
    timers.push({ id: id, fn: fn, at: virtualNow + (Number(ms) || 0), seq: id, cancelled: false });
    return id;
  }

  function clearTimer(id) {
    for (var i = 0; i < timers.length; i++) if (timers[i].id === id) timers[i].cancelled = true;
  }

  function flush(limit) {
    var guard = 0;
    var cap = limit || 2000;
    while (guard++ < cap) {
      var next = null;
      for (var i = 0; i < timers.length; i++) {
        var t = timers[i];
        if (t.cancelled) continue;
        if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t;
      }
      if (!next) break;
      next.cancelled = true;
      virtualNow = next.at;
      next.fn();
    }
    // 実行済み・取消済みを掃除
    timers = timers.filter(function (t) { return !t.cancelled; });
  }

  global.window = global;
  global.document = doc;
  global.navigator = { userAgent: 'koma-duel-harness', language: 'ja' };
  global.location = location;
  global.history = { replaceState: function () {} };
  global.isSecureContext = false;
  global.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    clear: function () { for (var k in store) if (Object.prototype.hasOwnProperty.call(store, k)) delete store[k]; }
  };
  global.setTimeout = addTimer;
  global.clearTimeout = clearTimer;
  global.requestAnimationFrame = function (fn) { return addTimer(fn, 0); };
  global.addEventListener = function (type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); };
  global.removeEventListener = function (type, fn) {
    var list = winListeners[type] || [];
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };

  /* ---------------- HTML ツリーの組み立て ---------------- */

  function buildNode(spec) {
    var node = new El(spec.t);
    var attrs = spec.a || {};
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (k === 'class') node.className = v;
      else if (k === 'id') node.id = v;
      else if (k === 'hidden') node.hidden = true;
      else if (k === 'value') node.value = v;
      else if (k.indexOf('data-') === 0) node.dataset[camel(k.slice(5))] = v;
      else node.attrs[k] = v;
    }
    if (spec.x) node._text = String(spec.x).replace(/\s+/g, ' ').trim();
    var kids = spec.c || [];
    for (var i = 0; i < kids.length; i++) node.appendChild(buildNode(kids[i]));
    return node;
  }

  function buildDom() {
    idMap = {};
    doc.body = buildNode(SPEC);
    doc.documentElement = doc.body;
    doc._listeners = {};
  }

  /* ---------------- イベント ---------------- */

  function fire(elem, type) {
    var e = {
      type: type,
      target: elem,
      currentTarget: null,
      preventDefault: function () {},
      stopPropagation: function () {}
    };
    var node = elem;
    while (node && node.tagName) {
      var list = node._listeners[type];
      if (list) {
        for (var i = 0; i < list.length; i++) {
          e.currentTarget = node;
          list[i].call(node, e);
        }
      }
      node = node.parentNode;
    }
    var dlist = doc._listeners[type];
    if (dlist) {
      for (var j = 0; j < dlist.length; j++) {
        e.currentTarget = doc;
        dlist[j].call(doc, e);
      }
    }
  }

  /* =====================================================================
     ハーネス API
     ===================================================================== */

  var H = {
    store: store,
    flush: flush,
    fire: fire,
    click: function (elem) { fire(elem, 'click'); flush(); },
    reset: function (opts) {
      opts = opts || {};
      if (!opts.keepStore) {
        for (var k in store) if (Object.prototype.hasOwnProperty.call(store, k)) delete store[k];
      }
      timers = [];
      timerSeq = 0;
      virtualNow = 0;
      Math.random = mulberry32(opts.seed || 20261122);   // AI も再現可能にする
      buildDom();
      location.hash = opts.hash || '';
      location.href = 'https://koma.test/index.html' + location.hash;
      eval(APP_SRC);
      return H;
    }
  };
  global.__H = H;

  function byId(id) { return doc.getElementById(id); }
  H.byId = byId;
  H.cell = function (i) { return byId('board').querySelector('.cell[data-i="' + i + '"]'); };

  /* =====================================================================
     テスト
     ===================================================================== */

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

  function hidden(el) {
    return !el || el.hidden === true || (el.classList && el.classList.contains('hidden'));
  }

  function has(el, cls) { return !!(el && el.classList && el.classList.contains(cls)); }

  function handBtn(which, size) {
    return byId('hand-' + which).querySelector('.hand-piece[data-size="' + size + '"]');
  }

  function place(which, size, i) {
    H.click(handBtn(which, size));
    H.click(H.cell(i));
  }

  function pieceCount() {
    return byId('board').querySelectorAll('.piece').length;
  }

  function winLocalGame() {
    H.reset();
    H.click(byId('btn-start-local'));
    place('bottom', 2, 0);   // 先手 中
    place('top', 1, 3);      // 後手 小
    place('bottom', 1, 1);   // 先手 小
    place('top', 1, 4);      // 後手 小
    place('bottom', 1, 2);   // 先手 小 → 0-1-2 で勝ち
  }

  /* ---------------- 起動 ---------------- */

  test('起動: メニューが出て、戦績は「まだ対局なし」', function () {
    H.reset();
    ok(!hidden(byId('screen-menu')), 'メニューが表示される');
    ok(hidden(byId('screen-game')), '対局画面は隠れている');
    eq(byId('stats-sum').textContent, 'まだ対局なし');
    ok(hidden(byId('btn-resume')), '続きの対局は無い');
    eq(byId('level-seg').querySelectorAll('button').length, 3);
  });

  /* ---------------- CPU対戦 ---------------- */

  test('CPU対戦: 9マス・手札3種・AIの応手', function () {
    H.reset();
    H.click(byId('btn-start-cpu'));
    ok(!hidden(byId('screen-game')), '対局画面に切り替わる');
    eq(byId('board').querySelectorAll('.cell').length, 9);
    eq(byId('hand-bottom').querySelectorAll('.hand-piece').length, 3);
    eq(byId('hand-top').querySelectorAll('.hand-piece').length, 3);
    eq(byId('name-top').textContent, 'ピッコロAI');
    ok(hidden(byId('replay-bar')), '手が無いのでふりかえりは出ない');
    ok(hidden(byId('btn-flip')), 'CPU戦では対面表示は出ない');

    H.click(handBtn('bottom', 1));
    H.click(H.cell(4));
    eq(H.cell(4).querySelectorAll('.piece').length, 1, '自分のコマが置かれる');
    eq(byId('turn-text').textContent, 'あなたの番', 'AIが指し返して自分の番に戻る');
    eq(byId('replay-pos').textContent, '第2手 / 2手');
    ok(!hidden(byId('replay-bar')), 'ふりかえりが出る');
  });

  /* ---------------- 2人対戦の決着と戦績 ---------------- */

  test('2人対戦: 最後まで指すと結果画面と戦績', function () {
    winLocalGame();
    ok(!hidden(byId('result-modal')), '結果画面が出る');
    eq(byId('result-title').textContent, 'プレイヤー1の勝ち！');
    eq(byId('result-badge').textContent, '勝負あり');
    eq(byId('result-stats').textContent, '2人対戦の通算 先手 1 - 0 後手');
    eq(H.cell(0).querySelectorAll('.piece').length, 1);
    ok(has(H.cell(0), 'win') && has(H.cell(1), 'win') && has(H.cell(2), 'win'), '勝ちラインに印');
    eq(byId('replay-pos').textContent, '第5手 / 5手');

    var raw = JSON.parse(store['komaDuell.stats.v1']);
    eq(raw.local.p1, 1);
    eq(raw.local.games, 1);
  });

  /* ---------------- 重なりとガブ ---------------- */

  test('重なり: 2段・3段のリングと段数バッジ、ガブの演出', function () {
    H.reset();
    H.click(byId('btn-start-local'));
    place('bottom', 1, 4);            // 先手 小
    eq(H.cell(4).querySelectorAll('.stack-ring').length, 0, '1枚ならリング無し');

    place('top', 2, 4);               // 後手 中 → 2段
    eq(H.cell(4).querySelectorAll('.piece').length, 2);
    eq(H.cell(4).querySelectorAll('.stack-ring').length, 1);
    eq(H.cell(4).querySelector('.stack-badge').textContent, '2段');
    ok(H.cell(4).getAttribute('aria-label').indexOf('2枚重なり') > 0, '読み上げにも段数');

    place('bottom', 3, 4);            // 先手 大 → 3段・ガブ
    eq(H.cell(4).querySelectorAll('.piece').length, 3);
    eq(H.cell(4).querySelectorAll('.stack-ring').length, 2);
    eq(H.cell(4).querySelector('.stack-badge').textContent, '3段');
    ok(has(H.cell(4), 'gobble'), 'ガブの強調クラス');
    ok(H.cell(4).querySelector('.fx-wave'), '波紋エフェクト');
    ok(has(H.cell(4).querySelector('.piece.top'), 'slam'), '叩きつけアニメ');
  });

  /* ---------------- 自爆（露出勝ち） ---------------- */

  test('自爆（露出勝ち）: 下から出たラインが光り、相手の勝ち', function () {
    var cells = ['A', 'Ab', 'B', '', '', '', '', '', ''];
    var board = L.stringToBoard(cells.join('.'));
    var st = {
      board: board, turn: 1, winner: 0, winLine: null, draw: false,
      moveCount: 0, lastMove: null, reason: null
    };
    for (var i = 0; i < 9; i++) st.moveCount += board[i].length;
    var code = L.encodeState(st);

    H.reset({ hash: '#g=' + code + '&me=1' });
    ok(!hidden(byId('screen-game')), 'リンクから対局画面が開く');
    eq(byId('replay-pos').textContent, '第0手 / 0手');

    // 1-2 の先手の中を持ち上げると、下から後手の小が出て 0-1-2 が揃う
    H.click(H.cell(1));
    ok(has(H.cell(1), 'picked'), '持ち上げるコマを選ぶ');
    H.click(H.cell(3));
    ok(!hidden(byId('result-modal')), '結果画面が出る');
    eq(byId('result-title').textContent, 'あいての勝ち');
    eq(byId('result-badge').textContent, '負け');
    ok(has(byId('board'), 'reveal'), '露出勝ちの強調');
    ok(has(H.cell(2), 'win'), '揃ったラインに印');
    ok(H.cell(1).querySelector('.piece.top').classList.contains('p2'), '露出した後手のコマが一番上');

    var raw = JSON.parse(store['komaDuell.stats.v1']);
    eq(raw.link.l, 1, 'リンク対戦の負けが記録される');
  });

  /* ---------------- ふりかえり ---------------- */

  test('ふりかえり: 初手・1手戻る・1手進む・最終手', function () {
    winLocalGame();
    H.click(byId('btn-result-replay'));
    ok(hidden(byId('result-modal')), '結果画面は閉じる');
    eq(byId('replay-pos').textContent, '第0手 / 5手');
    eq(pieceCount(), 0, '初手は空の盤面');
    ok(!hidden(byId('replay-badge')), 'ふりかえり中の表示');
    ok(!hidden(byId('btn-replay-live')), '今の局面へボタン');
    ok(byId('btn-replay-first').disabled, '初手ではこれ以上戻れない');

    H.click(byId('btn-replay-next'));
    eq(byId('replay-pos').textContent, '第1手 / 5手');
    eq(pieceCount(), 1);
    ok(byId('replay-desc').textContent.indexOf('第1手・プレイヤー1') === 0, '手の説明が出る');

    // ふりかえり中は盤面を触れない
    H.click(handBtn('bottom', 1));
    H.click(H.cell(8));
    eq(pieceCount(), 1, 'ふりかえり中は指せない');

    H.click(byId('btn-replay-prev'));
    eq(byId('replay-pos').textContent, '第0手 / 5手');
    H.click(byId('btn-replay-last'));
    eq(byId('replay-pos').textContent, '第5手 / 5手');
    eq(pieceCount(), 5);
    ok(hidden(byId('replay-badge')), '最終手は「今の局面」');
    ok(has(H.cell(0), 'win'), '勝ちラインも戻る');
  });

  /* ---------------- 戦績カード ---------------- */

  test('戦績: メニューに出て、リセットで消える', function () {
    winLocalGame();
    H.click(byId('btn-result-menu'));
    ok(!hidden(byId('screen-menu')), 'メニューへ戻る');
    ok(byId('stats-sum').textContent.indexOf('2人 先手1-0後手') >= 0, 'メニューに累計スコア');
    eq(byId('stats-rows').querySelectorAll('.stats-row').length, 5);

    H.click(byId('btn-stats-reset'));
    ok(!hidden(byId('confirm-modal')));
    H.click(byId('btn-confirm-ok'));
    eq(byId('stats-sum').textContent, 'まだ対局なし');
    eq(JSON.parse(store['komaDuell.stats.v1']).local.games, 0);
  });

  /* ---------------- 対面表示 ---------------- */

  test('対面表示: 手番のプレイヤーが手前に来て、盤面が180°反転する', function () {
    H.reset();
    H.click(byId('btn-start-local'));
    ok(!hidden(byId('btn-flip')), '2人対戦では出る');
    eq(byId('name-bottom').textContent, 'プレイヤー1');
    eq(byId('board').querySelectorAll('.cell')[0].dataset.i, '0');

    H.click(byId('btn-flip'));
    ok(has(byId('btn-flip'), 'on'));
    eq(byId('btn-flip').getAttribute('aria-pressed'), 'true');
    eq(byId('name-bottom').textContent, 'プレイヤー1', '先手の番なので手前は先手のまま');

    // 先手が指すと手番が後手へ。対面表示では盤面も後手から見た向きになる
    place('bottom', 1, 0);
    eq(byId('name-bottom').textContent, 'プレイヤー2', '手前（下）が後手になる');
    eq(byId('board').querySelectorAll('.cell')[0].dataset.i, '8', '左上は 3-3');
    eq(byId('board').querySelectorAll('.cell')[8].dataset.i, '0', '右下は 1-1');
    ok(byId('turn-sub').textContent.indexOf('対面表示') >= 0);

    // 反転していても、マスの指定は正しい（後手は 5 に置く）
    place('bottom', 1, 5);
    eq(H.cell(5).querySelectorAll('.piece').length, 1, '反転中もマスの指定は正しい');
    eq(byId('name-bottom').textContent, 'プレイヤー1', 'また先手の番に戻る');
    eq(byId('board').querySelectorAll('.cell')[0].dataset.i, '0');

    // 対面表示を切ると、常に先手が手前
    H.click(byId('btn-flip'));
    eq(byId('name-bottom').textContent, 'プレイヤー1');
    eq(byId('board').querySelectorAll('.cell')[0].dataset.i, '0');
  });

  /* ---------------- 移動と待った ---------------- */

  test('移動: 盤上のコマを選んで動かすと、下のコマが出てくる', function () {
    H.reset();
    H.click(byId('btn-start-local'));
    place('bottom', 1, 0);   // 先手 小
    place('top', 1, 4);      // 後手 小
    place('bottom', 2, 0);   // 先手 中（自分の小の上に重なる）
    place('top', 1, 8);      // 後手 小
    eq(H.cell(0).querySelectorAll('.piece').length, 2);

    H.click(H.cell(0));
    ok(has(H.cell(0), 'picked'), '一番上の自分のコマを選べる');
    H.click(H.cell(7));
    eq(H.cell(0).querySelectorAll('.piece').length, 1, '下のコマが出てくる');
    eq(H.cell(0).querySelectorAll('.stack-ring').length, 0, '重なり表示も消える');
    eq(H.cell(7).querySelectorAll('.piece').length, 1, '移動先にコマが入る');
    eq(byId('replay-pos').textContent, '第5手 / 5手');
    ok(byId('replay-desc').textContent.indexOf('から') > 0, '移動の説明が出る');
  });

  test('待った: 1手戻すと盤面も棋譜も戻る', function () {
    H.reset();
    H.click(byId('btn-start-local'));
    place('bottom', 1, 0);
    place('top', 1, 4);
    eq(byId('replay-pos').textContent, '第2手 / 2手');
    H.click(byId('btn-undo'));
    eq(pieceCount(), 1, '直前の手が取り消される');
    eq(byId('replay-pos').textContent, '第1手 / 1手');
    H.click(byId('btn-undo'));
    eq(pieceCount(), 0);
    ok(hidden(byId('replay-bar')), '0手ならふりかえりは隠れる');
  });

  /* ---------------- CPU対戦を1局通す ---------------- */

  /** 手札を大きい順に試して、置けるマスに置く（自動で1局進める）。 */
  function autoPlaceOnce() {
    var before = byId('replay-pos').textContent;
    for (var s = 3; s >= 1; s--) {
      var hb = handBtn('bottom', s);
      if (!hb || hb.disabled) continue;
      H.click(hb);
      for (var i = 0; i < 9; i++) {
        var c = H.cell(i);
        if (!c) continue;
        H.click(c);
        if (byId('replay-pos').textContent !== before) return true;
      }
      H.click(hb);
    }
    return false;
  }

  test('CPU対戦: 最後まで進めると結果と難易度別の戦績が残る', function () {
    H.reset();
    H.click(byId('level-seg').querySelector('button[data-level="easy"]'));
    H.click(byId('btn-start-cpu'));

    for (var step = 0; step < 40 && hidden(byId('result-modal')); step++) {
      if (!autoPlaceOnce()) break;
    }
    ok(!hidden(byId('result-modal')), '決着まで進む');
    eq(byId('result-title').textContent, 'あなたの勝ち！', '乱数固定のため毎回同じ結果');
    eq(byId('result-stats').textContent, 'このレベルの通算 1勝0敗・1連勝中');

    var raw = JSON.parse(store['komaDuell.stats.v1']);
    eq(raw.cpu.easy.w, 1);
    eq(raw.cpu.easy.streak, 1);
    eq(raw.cpu.easy.best, 1);
    eq(raw.cpu.normal.w, 0, '中級には入らない');
    eq(raw.cpu.hard.w, 0, '上級には入らない');

    H.click(byId('btn-result-menu'));
    ok(byId('stats-sum').textContent.indexOf('CPU 1勝0敗') >= 0);
  });

  /* ---------------- リンク対戦の文面 ---------------- */

  test('リンク対戦: 共有文面は「第2手👇」＋URL', function () {
    H.reset();
    H.click(byId('btn-start-link'));
    H.click(handBtn('bottom', 1));
    H.click(H.cell(0));
    ok(!hidden(byId('share-box')), '共有ボックスが出る');
    eq(byId('share-preview').textContent, 'コマ・デュエルで対局しよう！第2手👇');
    var url = byId('share-url').value;
    ok(url.indexOf('#g=') > 0, 'URLに局面');
    ok(url.indexOf('&me=2') > 0, '相手の手番');
    ok(url.indexOf('コマ・デュエル') < 0, 'URL自体はコードだけ');
  });

  /* ---------------- 保存と復元 ---------------- */

  test('保存復元: 「前回の続きから」で棋譜ごと戻る', function () {
    H.reset();
    H.click(byId('btn-start-local'));
    place('bottom', 2, 4);
    place('top', 1, 8);
    eq(byId('replay-pos').textContent, '第2手 / 2手');

    // リロード相当（保存だけ残す）
    H.reset({ keepStore: true });
    ok(!hidden(byId('btn-resume')), '続きからが出る');
    ok(byId('btn-resume').textContent.indexOf('2人対戦') > 0);
    H.click(byId('btn-resume'));
    eq(pieceCount(), 2, '盤面が戻る');
    eq(byId('replay-pos').textContent, '第2手 / 2手', '棋譜も戻る');
    H.click(byId('btn-replay-first'));
    eq(pieceCount(), 0);
  });

  /* ---------------- 報告 ---------------- */

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
      if (!results[j].ok) console.log('FAIL  ' + results[j].name + '\n      ' + results[j].error);
    }
  }

  global.__DOM_TEST_RESULTS__ = summary;
})(typeof globalThis !== 'undefined' ? globalThis : this);
