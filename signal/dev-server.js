/* 本地跑的信令服务，接口与 Cloudflare Worker 完全一致。
 *
 * 用途有两个：本地开发时不用连 Cloudflare；以及万一哪天要换托管，
 * 这份就是「服务端到底该做什么」的可执行说明——它和 worker.js 共用同一份 room.js，
 * 所以两边的行为不可能漂移。
 *
 *   node signal/dev-server.js            # 默认 8787
 *   node signal/dev-server.js 9000
 *
 * 然后在游戏页面的控制台里指过来（p2p.js 会读这个键）：
 *   localStorage.setItem('zombie-world-signal', 'http://localhost:8787')
 *
 * 它把房间放在进程内存里，重启即清空——本来就只该活 2 分钟，不值得持久化。
 */
import http from 'node:http';
import { roomOp, limitOp, validCode, makeCode, makeToken, ROOM_TTL_MS, MAX_SDP } from './room.js';

const PORT = Number(process.argv[2]) || 8787;
const MAX_BODY = MAX_SDP + 512;
const CLAIM_TRIES = 8;

const rooms = new Map();      // code -> store
const limits = new Map();     // ip -> 时间戳数组

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function send(res, status, body){
  if (status === 204){ res.writeHead(204, CORS); res.end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }, CORS));
  res.end(text);
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY) reject(new Error('body_too_large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (_) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

// 跟 Worker 里的 DO 一样：读出来、跑 roomOp、写回去
function op(code, o, now){
  const out = roomOp(rooms.get(code) || null, o, now);
  if (out.drop) rooms.delete(code);
  else if (out.store) rooms.set(code, out.store);
  return out;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS'){ res.writeHead(204, CORS); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const code = url.searchParams.get('code') || '';
  const token = url.searchParams.get('token') || '';
  const now = Date.now();

  // 过期的顺手清掉，免得内存里越攒越多
  for (const [c, store] of rooms) if (now - store.createdAt >= ROOM_TTL_MS) rooms.delete(c);

  if (path === '/' || path === '/health')
    return send(res, 200, { ok: true, service: 'zombie-signal-dev', ttl: ROOM_TTL_MS });

  try {
    if (path === '/new' && req.method === 'POST'){
      const ip = req.socket.remoteAddress || 'unknown';
      const lim = limitOp(limits.get(ip), now);
      limits.set(ip, lim.hits);
      if (!lim.allowed) return send(res, 429, { error: 'too_many_rooms' });

      const body = await readBody(req);
      const hostToken = makeToken();
      for (let i = 0; i < CLAIM_TRIES; i++){
        const c = makeCode();
        const r = op(c, { kind: 'claim', offer: body.offer, name: body.name, token: hostToken }, now);
        if (r.status === 200) return send(res, 200, { code: c, token: hostToken, ttl: ROOM_TTL_MS });
        if (r.status !== 409) return send(res, r.status, r.body);
      }
      return send(res, 503, { error: 'no_free_code' });
    }

    if (!validCode(code)) return send(res, 400, { error: 'bad_code' });

    if (path === '/offer' && req.method === 'GET'){
      const r = op(code, { kind: 'offer' }, now);
      return send(res, r.status, r.body);
    }
    if (path === '/answer' && req.method === 'POST'){
      const body = await readBody(req);
      const r = op(code, { kind: 'answer', answer: body.answer, name: body.name }, now);
      return send(res, r.status, r.body);
    }
    if (path === '/answer' && req.method === 'GET'){
      const r = op(code, { kind: 'poll', token }, now);
      return send(res, r.status, r.body);
    }
    if (path === '/close' && req.method === 'POST'){
      const r = op(code, { kind: 'close', token }, now);
      return send(res, r.status, r.body);
    }
  } catch (e){
    return send(res, 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'bad_json' });
  }

  return send(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log('信令服务（开发版）跑在 http://localhost:' + PORT);
  console.log("游戏页面控制台里执行：localStorage.setItem('zombie-world-signal', 'http://localhost:" + PORT + "')");
});
