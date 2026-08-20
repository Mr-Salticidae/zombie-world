/* 房间状态机 —— 信令服务的全部业务逻辑都在这一个文件里。
 *
 * 它**不碰任何 Cloudflare API**：入参是一个普通对象（房间的当前存储内容），
 * 出参是「HTTP 状态码 + 响应体 + 存储要变成什么样」。Worker 那边只是个适配器。
 * 这么分是为了能在 node:test 里把整条流程跑完，不用起 wrangler、不用连网。
 *
 * 这个服务只做一件事：把房主的 offer 递给客机、把客机的 answer 递回房主，然后消失。
 * 它不碰游戏数据、不做房间状态机（那套仍然跑在房主页面里的 p2p.js），
 * 也不存任何能标识玩家的东西。一间房活 2 分钟。
 */

export const ROOM_TTL_MS = 120000;      // 房间存活 2 分钟：够两个人对一次码，不够别人慢慢扫
export const MAX_SDP = 8192;            // 单条 SDP 上限。带 STUN 的也就 1.5KB，8K 已经很宽
export const MAX_NAME = 12;             // 跟游戏里的昵称上限一致
export const CODE_MIN = 1000, CODE_MAX = 9999;

export function validCode(v){
  return typeof v === 'string' && /^[0-9]{4}$/.test(v) &&
         Number(v) >= CODE_MIN && Number(v) <= CODE_MAX;
}

/* 4 位数字房间号。数字而不是字母：要能在电话里念、能在嘈杂环境里喊。
   9000 个号 + 2 分钟寿命，撞号靠调用方重试几次即可，不需要全局分配器。 */
export function makeCode(random){
  const r = typeof random === 'function' ? random() : Math.random();
  return String(CODE_MIN + Math.floor(r * (CODE_MAX - CODE_MIN + 1)));
}

export function makeToken(random){
  const r = typeof random === 'function' ? random : Math.random;
  let out = '';
  for (let i = 0; i < 4; i++) out += Math.floor(r() * 0xffffffff).toString(16).padStart(8, '0');
  return out;
}

function cleanName(v){
  const s = typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : '';
  return s || '幸存者';
}
function badSdp(v){
  // 只做长度和类型的粗校验：SDP 的合法性由浏览器判，服务器不该假装懂它
  return typeof v !== 'string' || v.length === 0 || v.length > MAX_SDP;
}

export function isLive(store, now){
  return !!(store && store.offer && now - store.createdAt < ROOM_TTL_MS);
}

/* 唯一的入口。op.kind 决定做什么；返回 { status, body, store, drop }。
 * store 有值 = 要写回；drop 为 true = 这间房可以删了。
 */
export function roomOp(store, op, now){
  const kind = op && op.kind;

  // 房主开房。号被占着（且还活着）就退 409，让调用方换个号重试
  if (kind === 'claim'){
    if (isLive(store, now)) return { status: 409, body: { error: 'code_taken' } };
    if (badSdp(op.offer)) return { status: 400, body: { error: 'bad_offer' } };
    if (typeof op.token !== 'string' || op.token.length < 8)
      return { status: 400, body: { error: 'bad_token' } };
    return {
      status: 200,
      body: { ok: true },
      store: { offer: op.offer, hostName: cleanName(op.name), token: op.token,
               createdAt: now, answer: null, guestName: null }
    };
  }

  // 客机凭房间号取 offer。不需要令牌——知道号就够了，房间本来就只活 2 分钟
  if (kind === 'offer'){
    if (!isLive(store, now)) return { status: 404, body: { error: 'no_room' } };
    return { status: 200, body: { offer: store.offer, name: store.hostName } };
  }

  // 客机回 answer。先到先得：第二个人再来只会拿到 409，不会把前一个人的应答顶掉
  if (kind === 'answer'){
    if (!isLive(store, now)) return { status: 404, body: { error: 'no_room' } };
    if (store.answer) return { status: 409, body: { error: 'already_answered' } };
    if (badSdp(op.answer)) return { status: 400, body: { error: 'bad_answer' } };
    return {
      status: 200,
      body: { ok: true },
      store: Object.assign({}, store, { answer: op.answer, guestName: cleanName(op.name) })
    };
  }

  // 房主轮询应答。要令牌：别人知道房间号也不该能替房主把应答取走
  if (kind === 'poll'){
    if (!isLive(store, now)) return { status: 404, body: { error: 'no_room' } };
    if (op.token !== store.token) return { status: 403, body: { error: 'bad_token' } };
    if (!store.answer) return { status: 204, body: null };
    return { status: 200, body: { answer: store.answer, name: store.guestName } };
  }

  // 连上了就主动销毁，把号早点还回号池
  if (kind === 'close'){
    if (!isLive(store, now)) return { status: 200, body: { ok: true }, drop: true };
    if (op.token !== store.token) return { status: 403, body: { error: 'bad_token' } };
    return { status: 200, body: { ok: true }, drop: true };
  }

  return { status: 400, body: { error: 'bad_op' } };
}

/* 建房限流。按 IP 哈希分桶，滑动窗口。
   不限读只限建：读要先知道 4 位号，本身就有门槛；建房才是能把配额烧光的那个动作。 */
export const LIMIT_WINDOW_MS = 600000;   // 10 分钟
export const LIMIT_MAX = 15;             // 一个 IP 10 分钟内最多开 15 间房

export function limitOp(hits, now){
  const kept = (hits || []).filter(t => now - t < LIMIT_WINDOW_MS);
  if (kept.length >= LIMIT_MAX) return { allowed: false, hits: kept };
  kept.push(now);
  return { allowed: true, hits: kept };
}
