/* 自动瞄准选靶的单测。
   script.js 是一整个挂在 DOM 上的文件，没法 import，所以这里用花括号配平
   把 pickAimTarget 的源码原样抠出来丢进 vm 跑——测的是仓库里那一份真代码，
   不是复刻件；改了实现这里会跟着红。依赖的全局在 ctx 里注入。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'script.js'), 'utf8');

function extract(name){
  const start = src.indexOf('function ' + name);
  assert.ok(start > 0, '没找到 ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++){
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(name + ' 的花括号没配平');
}
// 常量也从源码里读，免得测试和实现各写一份数值、调参时对不上
function constant(name){
  const m = src.match(new RegExp('const ' + name + '\\s*=\\s*([-\\d.]+)'));
  assert.ok(m, '没找到常量 ' + name);
  return Number(m[1]);
}

const ctx = {
  VW: 960, VH: 640,
  cam: { x: 0, y: 0 },
  zombies: [], devils: [], bosses: [], barrels: [],
  AIM_BACK_BIAS: constant('AIM_BACK_BIAS'),
  AIM_STICKY: constant('AIM_STICKY'),
  AIM_BARREL_PREF: constant('AIM_BARREL_PREF'),
};
vm.createContext(ctx);
vm.runInContext(extract('pickAimTarget') + '\nglobalThis.__pick = pickAimTarget;', ctx);
const pick = ctx.__pick;

const CONE_MOUSE = constant('AIM_CONE_MOUSE');
const P = () => ({ x: 480, y: 320, aimLock: null });          // 玩家站在视口中心
const Z = (x, y, extra) => Object.assign({ x, y, r: 12, hp: 30 }, extra);
const B = (x, y, extra) => Object.assign({ x, y, r: 11, hp: 1 }, extra);   // 油桶

test.afterEach(() => {
  ctx.zombies = []; ctx.devils = []; ctx.bosses = []; ctx.barrels = [];
  ctx.cam = { x:0, y:0 };
});

test('硬锁定：跟在身后的僵尸能被锁上', () => {
  // 这条就是玩家反馈的根因——朝向锁在移动方向上时，身后这只永远打不到，
  // 只能先拉开距离再转身对冲。
  ctx.zombies = [Z(360, 320)];                      // 玩家朝右跑，僵尸在正后方 120px
  assert.strictEqual(pick(P(), 1, 0, 560, null), ctx.zombies[0]);
});

test('硬锁定：贴脸的优先，不会为了「面朝前」放过要咬到你的那只', () => {
  const behind = Z(400, 320);                       //  80px 正后方
  const ahead  = Z(580, 320);                       // 100px 正前方
  ctx.zombies = [ahead, behind];
  assert.strictEqual(pick(P(), 1, 0, 560, null), behind);
});

test('硬锁定：前后等距时选正前方，朝向不会无缘无故往后甩', () => {
  ctx.zombies = [Z(380, 320), Z(580, 320)];         // 都是 100px
  assert.strictEqual(pick(P(), 1, 0, 560, null), ctx.zombies[1]);
});

test('软吸附：锥角外一律不碰，瞄准权留给玩家', () => {
  ctx.zombies = [Z(480, 200)];                                        // 正上方，偏离 90°
  assert.strictEqual(pick(P(), 1, 0, 560, CONE_MOUSE), null);         // 朝右瞄，够不着
  assert.strictEqual(pick(P(), 0, -1, 560, CONE_MOUSE), ctx.zombies[0]);
});

test('软吸附：擦边的能吸住——「辐射范围窄」说的就是这一枪', () => {
  ctx.zombies = [Z(780, 275)];                                        // 偏离约 8.4°
  assert.strictEqual(pick(P(), 1, 0, 560, CONE_MOUSE), ctx.zombies[0]);
});

test('锁定半径跟着武器走：喷火器够不到的不锁', () => {
  ctx.zombies = [Z(780, 320)];                                        // 300px
  assert.strictEqual(pick(P(), 1, 0, 150, null), null);               // 喷火器 aim=150
  assert.strictEqual(pick(P(), 1, 0, 560, null), ctx.zombies[0]);     // 手枪 aim=560
});

test('屏幕外不锁，哪怕射程够', () => {
  ctx.zombies = [Z(480, -100)];                     // 视口 y 是 0–640
  assert.strictEqual(pick(P(), 1, 0, 700, null), null);
});

test('按镜头矩形判可见，不假设玩家在正中（贴地图边缘时镜头会被夹住）', () => {
  const p = { x: 120, y: 320, aimLock: null };      // 玩家靠左，镜头夹在 x=0
  ctx.zombies = [Z(600, 320)];                      // 距玩家 480，仍在屏幕里
  assert.strictEqual(pick(p, 1, 0, 560, null), ctx.zombies[0]);
});

test('已锁目标有粘性：小幅差距不换人，被围时朝向不抖', () => {
  const p = P();
  const locked = Z(400, 320);                       // 80px
  ctx.zombies = [locked, Z(395, 320)];              // 85px，只近 6%，抢不走
  p.aimLock = locked;
  assert.strictEqual(pick(p, 1, 0, 560, null), locked);
});

test('粘性不是焊死：明显更近的新目标要能抢过来', () => {
  const p = P();
  const locked = Z(400, 320);                       // 80px
  ctx.zombies = [locked, Z(490, 320)];              // 10px，贴脸了
  p.aimLock = locked;
  assert.strictEqual(pick(p, 1, 0, 560, null), ctx.zombies[1]);
});

test('死掉的不锁，尸体上不会留着括号', () => {
  ctx.zombies = [Z(400, 320, { hp: 0 })];
  assert.strictEqual(pick(P(), 1, 0, 560, null), null);
});

test('恶魔和 BOSS 同样进选靶池', () => {
  ctx.devils = [Z(560, 320)];
  ctx.bosses = [Z(700, 320, { r: 30, boss: true })];
  assert.strictEqual(pick(P(), 1, 0, 700, null), ctx.devils[0]);
  ctx.devils = [];
  assert.strictEqual(pick(P(), 1, 0, 700, null), ctx.bosses[0]);
});

/* ---------- 油桶 ---------- */

test("硬锁定（'off'）不看油桶：桶不能把枪口从要咬你的僵尸身上抢走", () => {
  ctx.barrels = [B(500, 320)];      // 20px，比僵尸近得多
  ctx.zombies = [Z(680, 320)];      // 200px
  assert.strictEqual(pick(P(), 1, 0, 560, null, 'off'), ctx.zombies[0]);
});

test("油桶模式（'only'，按住 Shift）只瞄桶，敌人一概不看", () => {
  ctx.barrels = [B(680, 320)];
  ctx.zombies = [Z(500, 320)];      // 贴脸，但这时不该被选
  assert.strictEqual(pick(P(), 1, 0, 560, null, 'only'), ctx.barrels[0]);
});

test("油桶模式下范围内没桶就放手，等于临时把自动瞄准交回玩家", () => {
  ctx.zombies = [Z(500, 320)];
  assert.strictEqual(pick(P(), 1, 0, 560, null, 'only'), null);
});

test("软吸附（'prefer'）：准星压在油桶上时，优先于旁边的僵尸", () => {
  // 油桶的价值就在于旁边站着僵尸，被那只僵尸把准星吸走这一枪就白瞄了
  const p = P();
  ctx.barrels = [B(680, 320)];                  // 正前方 200px，偏离 0°
  ctx.zombies = [Z(676, 344)];                  // 就在桶边上，偏离约 7°
  assert.strictEqual(pick(p, 1, 0, 560, CONE_MOUSE, 'prefer'), ctx.barrels[0]);
});

test("软吸附：明确瞄着僵尸时，旁边的油桶抢不走", () => {
  const p = P();
  ctx.barrels = [B(676, 296)];                  // 偏离约 7°
  ctx.zombies = [Z(680, 320)];                  // 准星正对，偏离 0°
  assert.strictEqual(pick(p, 1, 0, 560, CONE_MOUSE, 'prefer'), ctx.zombies[0]);
});

test('已经点着引信的油桶不锁，再补一枪是浪费', () => {
  ctx.barrels = [B(680, 320, { fuse: .4 })];
  assert.strictEqual(pick(P(), 1, 0, 560, null, 'only'), null);
});

test('不传 barrelMode 时按硬锁定的老行为走，油桶不进池', () => {
  ctx.barrels = [B(500, 320)];
  ctx.zombies = [Z(680, 320)];
  assert.strictEqual(pick(P(), 1, 0, 560, null), ctx.zombies[0]);
});
