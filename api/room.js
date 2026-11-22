'use strict';
/*
 * 部屋コード同期 API（任意）
 *
 * Vercel など Node サーバーレスが動く場所に置いたときだけ使われます。
 * GitHub Pages（静的ホスティングのみ）では呼ばれず、アプリは「リンク対戦」で動きます。
 *
 * メモリ上の部屋なので、サーバーレスでは同時に温まっているインスタンス内だけで有効です。
 * 本格運用なら Redis などに置き換えてください（このファイルだけで完結する軽量版）。
 */

const rooms = (globalThis.__komaRooms = globalThis.__komaRooms || new Map());
const TTL = 6 * 60 * 60 * 1000;
const MAX_ROOMS = 2000;
const MAX_CODE = 400;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomId(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sweep(now) {
  if (rooms.size <= 40) return;
  for (const [key, room] of rooms) {
    if (now - room.updated > TTL) rooms.delete(key);
  }
}

function seatOf(room, token) {
  if (!token) return 0;
  return room.tokens[token] || 0;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method_not_allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    send(res, 400, { error: 'bad_body' });
    return;
  }

  const now = Date.now();
  sweep(now);
  const action = body.action;

  if (action === 'create') {
    if (rooms.size >= MAX_ROOMS) {
      const oldest = [...rooms.entries()].sort((a, b) => a[1].updated - b[1].updated)[0];
      if (oldest) rooms.delete(oldest[0]);
    }
    let id = randomId(5);
    while (rooms.has(id)) id = randomId(5);
    const token = randomId(12);
    const code = typeof body.code === 'string' ? body.code.slice(0, MAX_CODE) : '';
    rooms.set(id, { code, seq: 0, tokens: { [token]: 1 }, updated: now });
    send(res, 200, { room: id, seat: 1, token, seq: 0 });
    return;
  }

  const room = body.room ? rooms.get(String(body.room).toUpperCase()) : null;
  if (!room) {
    send(res, 404, { error: 'room_not_found' });
    return;
  }

  if (action === 'join') {
    const seat = Object.keys(room.tokens).length >= 2 ? 2 : (Object.values(room.tokens).includes(1) ? 2 : 1);
    const token = randomId(12);
    room.tokens[token] = seat;
    room.updated = now;
    send(res, 200, { room: body.room, seat, token, code: room.code, seq: room.seq });
    return;
  }

  if (action === 'push') {
    if (!seatOf(room, body.token)) {
      send(res, 403, { error: 'not_seated' });
      return;
    }
    if (typeof body.code === 'string' && body.code.length <= MAX_CODE) {
      room.code = body.code;
      room.seq += 1;
    }
    room.updated = now;
    send(res, 200, { seq: room.seq });
    return;
  }

  if (action === 'pull') {
    room.updated = now;
    send(res, 200, { code: room.code, seq: room.seq });
    return;
  }

  send(res, 400, { error: 'unknown_action' });
};
