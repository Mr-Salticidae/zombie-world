/* Cloudflare Worker —— 僵尸危机的信令服务。
 *
 * 全部业务逻辑在 room.js 里（可单测）；这个文件只做三件事：
 * 路由、CORS、把请求转给对应的 Durable Object。
 *
 * 为什么用 Durable Object 而不是 KV：信令状态只活 2 分钟，放 DO 内存里正合适。
 * KV 免费层每天只能写 1000 次，一局要写 2 次 = 500 局/天就到顶；DO 没有这个坎，
 * 只剩 Workers 的 10 万请求/天。SQLite-backed DO 在免费层可用且不计存储费。
 *
 * 部署见同目录 README.md。
 */
import { roomOp, limitOp, validCode, makeCode, makeToken, ROOM_TTL_MS, MAX_SDP } from './room.js';

const MAX_BODY = MAX_SDP + 512;          // SDP 上限再留一点给 JSON 外壳
const CLAIM_TRIES = 8;                   // 撞号就换一个再试

/* CORS 一律放开。这里没有任何要保护的东西：房间只活 2 分钟、内容是一次性的 SDP、
   也不存任何能标识玩家的信息。收紧到某个 Origin 反而会在 B站 换域名那天把联机整个搞挂，
   而那种故障在真机上极难查。滥用靠建房限流挡，不靠 Origin。 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(status, body){
  if (status === 204) return new Response(null, { status, headers: CORS });
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS),
  });
}

async function readBody(request){
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new Error('body_too_large');
  try { return JSON.parse(raw); } catch (_) { throw new Error('bad_json'); }
}

async function callRoom(env, code, op){
  const stub = env.ROOM.get(env.ROOM.idFromName('room:' + code));
  const res = await stub.fetch('https://room/op', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(op),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

export default {
  async fetch(request, env){
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const code = url.searchParams.get('code') || '';
    const token = url.searchParams.get('token') || '';

    // 健康检查：客户端启动时用它判断信令服务在不在，不在就只显示复制粘贴那条路
    if (path === '/' || path === '/health'){
      return json(200, { ok: true, service: 'zombie-signal', ttl: ROOM_TTL_MS });
    }

    try {
      if (path === '/new' && request.method === 'POST'){
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        const limiter = env.LIMIT.get(env.LIMIT.idFromName('ip:' + ip));
        const lim = await limiter.fetch('https://limit/hit', { method: 'POST' });
        if (lim.status === 429) return json(429, { error: 'too_many_rooms' });

        const body = await readBody(request);
        const hostToken = makeToken();
        for (let i = 0; i < CLAIM_TRIES; i++){
          const c = makeCode();
          const r = await callRoom(env, c, { kind: 'claim', offer: body.offer, name: body.name, token: hostToken });
          if (r.status === 200) return json(200, { code: c, token: hostToken, ttl: ROOM_TTL_MS });
          if (r.status !== 409) return json(r.status, r.body);      // 400 之类的直接回，别在这儿空转
        }
        return json(503, { error: 'no_free_code' });
      }

      if (!validCode(code)) return json(400, { error: 'bad_code' });

      if (path === '/offer' && request.method === 'GET'){
        const r = await callRoom(env, code, { kind: 'offer' });
        return json(r.status, r.body);
      }
      if (path === '/answer' && request.method === 'POST'){
        const body = await readBody(request);
        const r = await callRoom(env, code, { kind: 'answer', answer: body.answer, name: body.name });
        return json(r.status, r.body);
      }
      if (path === '/answer' && request.method === 'GET'){
        const r = await callRoom(env, code, { kind: 'poll', token });
        return json(r.status, r.body);
      }
      if (path === '/close' && request.method === 'POST'){
        const r = await callRoom(env, code, { kind: 'close', token });
        return json(r.status, r.body);
      }
    } catch (e){
      const why = e && e.message === 'body_too_large' ? 'body_too_large' : 'bad_json';
      return json(400, { error: why });
    }

    return json(404, { error: 'not_found' });
  },
};

/* 一个 DO 实例 = 一个房间号。名字就是房间号，所以不需要全局的号码分配器。 */
export class Room {
  constructor(state){ this.state = state; }

  async fetch(request){
    const op = await request.json();
    const now = Date.now();
    const store = (await this.state.storage.get('room')) || null;
    const out = roomOp(store, op, now);

    if (out.drop){
      await this.state.storage.deleteAll();
    } else if (out.store){
      await this.state.storage.put('room', out.store);
      // 到点自动清干净，别让过期房间一直占着存储
      await this.state.storage.setAlarm(now + ROOM_TTL_MS + 30000);
    }
    if (out.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  async alarm(){ await this.state.storage.deleteAll(); }
}

/* 建房限流。一个 DO 实例 = 一个 IP。 */
export class Limiter {
  constructor(state){ this.state = state; }

  async fetch(){
    const now = Date.now();
    const hits = (await this.state.storage.get('hits')) || [];
    const out = limitOp(hits, now);
    await this.state.storage.put('hits', out.hits);
    await this.state.storage.setAlarm(now + 900000);
    return new Response(null, { status: out.allowed ? 204 : 429 });
  }

  async alarm(){ await this.state.storage.deleteAll(); }
}
