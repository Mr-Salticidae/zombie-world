/* 热点直连（p2p.js）的单测。
   p2p.js 是浏览器脚本，但它只依赖一小撮标准全局（EventTarget / crypto / Blob /
   CompressionStream…），这些 Node 都有，所以把 window 指向 globalThis 就能原样 import 进来
   ——测的是仓库里那一份真代码，不是复刻件。

   WebRTC 本身没法在 Node 里跑，也没必要：这个文件里唯一新写的业务逻辑是「房主兼服务器」
   的那套房间状态机，它只吃 JSON 消息、不碰 RTCPeerConnection。把 dc 换成一个记账用的假通道，
   就能把准备 / 开局 / 结束 / 离开整条路径全测到——而这恰恰是没真机时最需要盯住的部分。 */
import test from 'node:test';
import assert from 'node:assert';

globalThis.window = globalThis;                 // p2p.js 结尾是 })(window)
await import('../p2p.js');
const { ZombiePeerNetwork, zombiePeerCodec } = globalThis;

/* ---------- 假通道：记下所有发出去的消息 ---------- */
function fakeChannel(){
  return {
    readyState: 'open',
    sent: [],
    send(text){ this.sent.push(JSON.parse(text)); },
    close(){ this.readyState = 'closed'; },
    lastOf(type){ return [...this.sent].reverse().find(m => m.type === type); }
  };
}

/* 造一个「已经开好房、还没人进来」的房主 */
function makeHost(){
  const net = new ZombiePeerNetwork();
  const events = [];
  for (const name of ['room.state','match.start','match.finish','input','error','room.closed']){
    net.addEventListener(name, e => events.push({ name, detail:e.detail }));
  }
  net.hosting = true;
  net.selfId = 'HOSTID00';
  net.room = {
    code:'ABC234', hostId:'HOSTID00', phase:'lobby', mapIndex:0, capacity:2,
    players:[{ id:'HOSTID00', name:'房主', slot:0, ready:false, connected:true }]
  };
  net.dc = fakeChannel();
  return { net, events, dc:net.dc };
}

function joinGuest(net){
  net.onWire({ type:'hello', name:'队友' });
  return net.room.players[1];
}

test('码：打包再解开还是原来那份东西', async () => {
  const payload = { v:1, t:'offer', sdp:'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=ice-ufrag:abcd\r\n', name:'房主' };
  const code = await zombiePeerCodec.packCode(payload);
  assert.match(code, /^[01]/, '首字节是压缩标记');
  assert.deepStrictEqual(await zombiePeerCodec.unpackCode(code), payload);
});

test('码：中间夹了换行空格也能读（微信转发会插换行）', async () => {
  const code = await zombiePeerCodec.packCode({ v:1, t:'answer', sdp:'v=0', name:'队友' });
  const mangled = code.slice(0, 10) + '\n  ' + code.slice(10, 25) + '\r\n' + code.slice(25);
  assert.deepStrictEqual((await zombiePeerCodec.unpackCode(mangled)).t, 'answer');
});

test('码：残缺或不是本游戏的码要报错，不能静默连不上', async () => {
  await assert.rejects(() => zombiePeerCodec.unpackCode(''), /太短/);
  await assert.rejects(() => zombiePeerCodec.unpackCode('X'), /太短/);
  await assert.rejects(() => zombiePeerCodec.unpackCode('9abcdefgh'), /不是本游戏/);
  await assert.rejects(() => zombiePeerCodec.unpackCode('0@@@@@@@@'), /读不出来|不完整/);
});

test('客机报到：进房、占 1 号位，双方各自拿到自己的 selfId', () => {
  const { net, events, dc } = makeHost();
  const guest = joinGuest(net);

  assert.strictEqual(net.room.players.length, 2);
  assert.strictEqual(guest.slot, 1);
  assert.strictEqual(guest.name, '队友');
  assert.strictEqual(guest.ready, false);

  // 发给客机的那份 selfId 是客机自己的，房主本地那份是房主的——发混了双方都会以为自己是对方
  assert.strictEqual(dc.lastOf('room.state').selfId, guest.id);
  const local = events.filter(e => e.name === 'room.state').pop();
  assert.strictEqual(local.detail.selfId, 'HOSTID00');
  assert.strictEqual(local.detail.capacity, 2);
});

test('一条管道只可能有一个对端：重复 hello 不会挤出第三个人', () => {
  const { net } = makeHost();
  joinGuest(net);
  net.onWire({ type:'hello', name:'插队的' });
  assert.strictEqual(net.room.players.length, 2);
});

test('准备状态：两边各改各的，改完都会广播', () => {
  const { net, dc } = makeHost();
  joinGuest(net);

  net.send('room.ready', { ready:true });          // 房主自己点准备
  assert.strictEqual(net.room.players[0].ready, true);
  net.onWire({ type:'room.ready', ready:true });   // 客机点准备
  assert.strictEqual(net.room.players[1].ready, true);
  assert.strictEqual(dc.lastOf('room.state').players[1].ready, true);
});

test('没准备齐不许开局，并且要说出来而不是默默失败', () => {
  const { net, events, dc } = makeHost();
  joinGuest(net);
  net.send('room.ready', { ready:true });          // 只有房主准备了

  assert.strictEqual(net.send('match.start'), false);
  assert.strictEqual(net.room.phase, 'lobby');
  assert.ok(!dc.lastOf('match.start'), '不该往对面发开局');
  assert.strictEqual(events.filter(e => e.name === 'error').pop().detail.code, 'NOT_READY');
});

test('一个人也不许开局', () => {
  const { net } = makeHost();
  net.send('room.ready', { ready:true });
  assert.strictEqual(net.send('match.start'), false);
  assert.strictEqual(net.room.phase, 'lobby');
});

test('全员准备后开局：两头同时进战局，名单和地图一致', () => {
  const { net, events, dc } = makeHost();
  joinGuest(net);
  net.send('room.config', { mapIndex:3 });
  net.send('room.ready', { ready:true });
  net.onWire({ type:'room.ready', ready:true });

  assert.strictEqual(net.send('match.start'), true);
  assert.strictEqual(net.room.phase, 'playing');

  const wired = dc.lastOf('match.start');
  const local = events.filter(e => e.name === 'match.start').pop().detail;
  assert.strictEqual(wired.mapIndex, 3);
  assert.strictEqual(local.mapIndex, 3);
  assert.deepStrictEqual(wired.players.map(p => p.id), local.players.map(p => p.id));
});

test('地图只认 0–4，越界的钳回去（客机发来的数字不可信）', () => {
  const { net } = makeHost();
  net.send('room.config', { mapIndex:99 });
  assert.strictEqual(net.room.mapIndex, 4);
  net.send('room.config', { mapIndex:-7 });
  assert.strictEqual(net.room.mapIndex, 0);
});

test('打完一局回大厅：准备状态要清掉，否则下一局会自己开起来', () => {
  const { net, dc } = makeHost();
  joinGuest(net);
  net.send('room.ready', { ready:true });
  net.onWire({ type:'room.ready', ready:true });
  net.send('match.start');

  assert.strictEqual(net.send('match.finish'), true);
  assert.strictEqual(net.room.phase, 'lobby');
  assert.ok(net.room.players.every(p => !p.ready), '两个人的准备都该清掉');
  assert.ok(dc.lastOf('match.finish'), '要通知对面回大厅');
});

test('客机的输入在房主这边变成本地 input 事件，游戏那头照单全收', () => {
  const { net, events } = makeHost();
  const guest = joinGuest(net);
  net.onWire({ type:'input', playerId:guest.id, mx:1, my:0, fire:true });

  const input = events.filter(e => e.name === 'input').pop().detail;
  assert.strictEqual(input.playerId, guest.id);
  assert.strictEqual(input.fire, true);
});

test('队友离开：房间退回一个人、回大厅，并通知游戏那头', () => {
  const { net, events } = makeHost();
  joinGuest(net);
  net.send('room.ready', { ready:true });
  net.onWire({ type:'room.ready', ready:true });
  net.send('match.start');

  net.onWire({ type:'leave' });
  assert.strictEqual(net.room.players.length, 1);
  assert.strictEqual(net.room.phase, 'lobby');
  assert.strictEqual(net.room.players[0].ready, false);
  assert.ok(events.some(e => e.name === 'room.closed'));
});

test('方向是单向的：房主不发输入，客机不发快照', () => {
  const { net } = makeHost();
  joinGuest(net);
  assert.strictEqual(net.sendInput({ mx:1 }), false, '房主的输入是本地的，不该上管道');

  const guest = new ZombiePeerNetwork();
  guest.hosting = false;
  guest.dc = fakeChannel();
  assert.strictEqual(guest.sendSnapshot({ tick:1 }), false, '权威快照只能由房主发');
  assert.strictEqual(guest.sendInput({ mx:1 }), true);
});

test('客机收到房间状态后，room 的形状与游戏那头的预期一致', () => {
  const guest = new ZombiePeerNetwork();
  guest.hosting = false;
  guest.onWire({
    type:'room.state', code:'ABC234', hostId:'HOSTID00', phase:'lobby',
    mapIndex:2, capacity:2, selfId:'GUESTID0',
    players:[{ id:'HOSTID00', name:'房主', slot:0, ready:true, connected:true },
             { id:'GUESTID0', name:'队友', slot:1, ready:false, connected:true }]
  });

  assert.strictEqual(guest.selfId, 'GUESTID0');
  assert.strictEqual(guest.isHost, false);
  assert.strictEqual(guest.room.capacity, 2);
  assert.strictEqual(guest.room.mapIndex, 2);
  assert.strictEqual(guest.room.players.length, 2);
});

test('房主身份判定：hostId 等于自己才是房主', () => {
  const { net } = makeHost();
  assert.strictEqual(net.isHost, true);
  net.room.hostId = 'SOMEONE0';
  assert.strictEqual(net.isHost, false);
});

test('断开后 room 清空，游戏那头不会拿着一个死房间继续渲染', () => {
  const { net } = makeHost();
  joinGuest(net);
  net.disconnect(true);
  assert.strictEqual(net.room, null);
  assert.strictEqual(net.selfId, null);
  assert.strictEqual(net.isHost, false);
});

test('通道没开的时候发东西不炸，只是发不出去', () => {
  const net = new ZombiePeerNetwork();
  assert.strictEqual(net.wire('ping', {}), false);
  net.dc = fakeChannel();
  net.dc.readyState = 'connecting';
  assert.strictEqual(net.wire('ping', {}), false);
});
