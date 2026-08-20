/* 信令服务的单测。
   room.js 是纯逻辑（不碰任何 Cloudflare API），所以这里能把整条握手流程原样跑一遍，
   不用起 wrangler、不用连网。Worker 那边只是个适配器，逻辑全在这儿。 */
import test from 'node:test';
import assert from 'node:assert';
import {
  roomOp, limitOp, validCode, makeCode, makeToken,
  isLive, ROOM_TTL_MS, MAX_SDP, LIMIT_MAX, LIMIT_WINDOW_MS,
} from '../signal/room.js';

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n…offer…';
const ANSWER = 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\n…answer…';

// 一间房的「服务端」：把 roomOp 的写回和删除都落到一个普通对象上
function makeRoom(){
  let store = null;
  return {
    get store(){ return store; },
    op(o, now){
      const out = roomOp(store, o, now);
      if (out.drop) store = null;
      else if (out.store) store = out.store;
      return out;
    },
  };
}

/* ---------- 房间号 ---------- */

test('房间号是 4 位数字，能在电话里念出来', () => {
  for (let i = 0; i < 200; i++){
    const c = makeCode();
    assert.ok(validCode(c), c);
    assert.strictEqual(c.length, 4);
  }
  assert.strictEqual(makeCode(() => 0), '1000');
  assert.strictEqual(makeCode(() => 0.999999), '9999');
});

test('乱七八糟的房间号一律不认', () => {
  for (const bad of ['', '123', '12345', '0999', 'abcd', '12 3', '１２３４', null, 1234, undefined])
    assert.strictEqual(validCode(bad), false, String(bad));
});

test('房主令牌够长，猜不出来', () => {
  const a = makeToken(), b = makeToken();
  assert.ok(a.length >= 32);
  assert.notStrictEqual(a, b);
});

/* ---------- 一次完整的握手 ---------- */

test('房主开房 → 客机取 offer → 客机回 answer → 房主收到 → 销毁', () => {
  const room = makeRoom();
  const t0 = 1000000;

  const claim = room.op({ kind:'claim', offer:OFFER, name:'房主', token:'tok-abcdefgh' }, t0);
  assert.strictEqual(claim.status, 200);

  // 客机还没回话，房主轮询拿到 204 —— 这是「还在等」，不是错误
  assert.strictEqual(room.op({ kind:'poll', token:'tok-abcdefgh' }, t0 + 500).status, 204);

  const got = room.op({ kind:'offer' }, t0 + 1000);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.body.offer, OFFER);
  assert.strictEqual(got.body.name, '房主');

  assert.strictEqual(room.op({ kind:'answer', answer:ANSWER, name:'队友' }, t0 + 2000).status, 200);

  const poll = room.op({ kind:'poll', token:'tok-abcdefgh' }, t0 + 2500);
  assert.strictEqual(poll.status, 200);
  assert.strictEqual(poll.body.answer, ANSWER);
  assert.strictEqual(poll.body.name, '队友');

  assert.strictEqual(room.op({ kind:'close', token:'tok-abcdefgh' }, t0 + 3000).status, 200);
  assert.strictEqual(room.store, null, '销毁之后房间号要能马上再被别人用');
});

/* ---------- 抢占与越权 ---------- */

test('号被占着的时候不能被顶掉 —— 否则两个人会同时以为自己是房主', () => {
  const room = makeRoom();
  const t0 = 1000000;
  room.op({ kind:'claim', offer:OFFER, name:'甲', token:'tok-11111111' }, t0);
  const second = room.op({ kind:'claim', offer:'别的 offer', name:'乙', token:'tok-22222222' }, t0 + 1000);
  assert.strictEqual(second.status, 409);
  assert.strictEqual(room.store.hostName, '甲');
  assert.strictEqual(room.store.offer, OFFER);
});

test('过期的号可以被新房主接手', () => {
  const room = makeRoom();
  const t0 = 1000000;
  room.op({ kind:'claim', offer:OFFER, name:'甲', token:'tok-11111111' }, t0);
  const later = room.op({ kind:'claim', offer:'新 offer', name:'乙', token:'tok-22222222' }, t0 + ROOM_TTL_MS + 1);
  assert.strictEqual(later.status, 200);
  assert.strictEqual(room.store.hostName, '乙');
});

test('应答先到先得：第二个人顶不掉第一个人的应答', () => {
  const room = makeRoom();
  const t0 = 1000000;
  room.op({ kind:'claim', offer:OFFER, name:'房主', token:'tok-abcdefgh' }, t0);
  assert.strictEqual(room.op({ kind:'answer', answer:ANSWER, name:'甲' }, t0 + 1000).status, 200);
  const second = room.op({ kind:'answer', answer:'别人的 answer', name:'乙' }, t0 + 1100);
  assert.strictEqual(second.status, 409);
  assert.strictEqual(room.store.answer, ANSWER);
  assert.strictEqual(room.store.guestName, '甲');
});

test('拿不到令牌就取不走应答 —— 知道房间号也不行', () => {
  const room = makeRoom();
  const t0 = 1000000;
  room.op({ kind:'claim', offer:OFFER, name:'房主', token:'tok-abcdefgh' }, t0);
  room.op({ kind:'answer', answer:ANSWER, name:'队友' }, t0 + 1000);
  assert.strictEqual(room.op({ kind:'poll', token:'猜的' }, t0 + 1100).status, 403);
  assert.strictEqual(room.op({ kind:'poll', token:'' }, t0 + 1100).status, 403);
  assert.strictEqual(room.op({ kind:'poll' }, t0 + 1100).status, 403);
});

test('拿不到令牌也删不掉别人的房间', () => {
  const room = makeRoom();
  const t0 = 1000000;
  room.op({ kind:'claim', offer:OFFER, name:'房主', token:'tok-abcdefgh' }, t0);
  assert.strictEqual(room.op({ kind:'close', token:'猜的' }, t0 + 100).status, 403);
  assert.ok(room.store, '房间还在');
});

/* ---------- 过期 ---------- */

test('房间只活 2 分钟，过期后取 offer / 回应答一律 404', () => {
  const room = makeRoom();
  const t0 = 1000000;
  room.op({ kind:'claim', offer:OFFER, name:'房主', token:'tok-abcdefgh' }, t0);
  assert.strictEqual(isLive(room.store, t0 + ROOM_TTL_MS - 1), true);
  assert.strictEqual(isLive(room.store, t0 + ROOM_TTL_MS), false);
  const late = t0 + ROOM_TTL_MS + 1;
  assert.strictEqual(room.op({ kind:'offer' }, late).status, 404);
  assert.strictEqual(room.op({ kind:'answer', answer:ANSWER }, late).status, 404);
  assert.strictEqual(room.op({ kind:'poll', token:'tok-abcdefgh' }, late).status, 404);
});

test('房间不存在时不会把 404 说成别的：客机输错号要能收到明确答复', () => {
  const room = makeRoom();
  assert.strictEqual(room.op({ kind:'offer' }, 1).status, 404);
  assert.strictEqual(room.op({ kind:'poll', token:'x' }, 1).status, 404);
});

/* ---------- 输入校验 ---------- */

test('SDP 空的、超长的、不是字符串的一律拒', () => {
  const room = makeRoom();
  const t0 = 1000000;
  for (const bad of ['', 'x'.repeat(MAX_SDP + 1), null, undefined, 123, {}]){
    const r = room.op({ kind:'claim', offer:bad, name:'房主', token:'tok-abcdefgh' }, t0);
    assert.strictEqual(r.status, 400, String(bad).slice(0, 20));
  }
  assert.strictEqual(room.store, null);
});

test('令牌太短不给开房：短令牌等于没有令牌', () => {
  const room = makeRoom();
  const r = room.op({ kind:'claim', offer:OFFER, name:'房主', token:'abc' }, 1000000);
  assert.strictEqual(r.status, 400);
});

test('昵称会被裁到 12 字，空的给个默认值', () => {
  const room = makeRoom();
  const t0 = 1000000;
  room.op({ kind:'claim', offer:OFFER, name:'一二三四五六七八九十十一十二', token:'tok-abcdefgh' }, t0);
  assert.strictEqual(room.store.hostName.length, 12);
  const room2 = makeRoom();
  room2.op({ kind:'claim', offer:OFFER, name:'   ', token:'tok-abcdefgh' }, t0);
  assert.strictEqual(room2.store.hostName, '幸存者');
});

test('不认识的操作不会被当成合法请求', () => {
  const room = makeRoom();
  assert.strictEqual(room.op({ kind:'drop-table' }, 1).status, 400);
  assert.strictEqual(room.op({}, 1).status, 400);
});

/* ---------- 建房限流 ---------- */

test('同一个 IP 十分钟内开房有上限，超了就拦', () => {
  let hits = [];
  const t0 = 1000000;
  for (let i = 0; i < LIMIT_MAX; i++){
    const out = limitOp(hits, t0 + i);
    assert.strictEqual(out.allowed, true, '第 ' + (i+1) + ' 次该放行');
    hits = out.hits;
  }
  assert.strictEqual(limitOp(hits, t0 + LIMIT_MAX).allowed, false);
});

test('窗口滑过去就重新放行，不是永久封禁', () => {
  let hits = [];
  const t0 = 1000000;
  for (let i = 0; i < LIMIT_MAX; i++) hits = limitOp(hits, t0 + i).hits;
  assert.strictEqual(limitOp(hits, t0 + LIMIT_WINDOW_MS + 1).allowed, true);
});

test('限流只记时间戳，不留任何能标识人的东西', () => {
  const out = limitOp([], 1000000);
  assert.ok(out.hits.every(v => typeof v === 'number'));
});
