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
  VW: 960, VH: 640, WW: 1920, WH: 1280,
  cam: { x: 0, y: 0 },
  zombies: [], devils: [], bosses: [], barrels: [],
  pillars: [],                       // 选靶要过一道视线检测，石柱由各条用例自己摆
  AIM_BACK_BIAS: constant('AIM_BACK_BIAS'),
  AIM_STICKY: constant('AIM_STICKY'),
  AIM_BARREL_PREF: constant('AIM_BARREL_PREF'),
};
vm.createContext(ctx);
// hitPillar / losBlocked / blockingPillar 也从源码里抠，
// 视线规则和绕障判断测的就是仓库里那一份
const SRC = [extract('hitPillar'), extract('losBlocked'), extract('blockingPillar'),
  extract('pickAimTarget'),
  'globalThis.__pick = pickAimTarget; globalThis.__blocking = blockingPillar;'].join(String.fromCharCode(10));
vm.runInContext(SRC, ctx);
const pick = ctx.__pick;
const blockingPillar = ctx.__blocking;

const CONE_MOUSE = constant('AIM_CONE_MOUSE');
const P = () => ({ x: 480, y: 320, aimLock: null });          // 玩家站在视口中心
const Z = (x, y, extra) => Object.assign({ x, y, r: 12, hp: 30 }, extra);
const B = (x, y, extra) => Object.assign({ x, y, r: 11, hp: 1 }, extra);   // 油桶

test.afterEach(() => {
  ctx.zombies = []; ctx.devils = []; ctx.bosses = []; ctx.barrels = [];
  ctx.pillars = [];
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

/* ---------- 视线：石柱后面的不锁 ---------- */

test('石柱挡着的不锁——不然就是一边被咬一边对着石头开枪', () => {
  ctx.pillars = [{ x: 560, y: 320, r: 40 }];        // 正好卡在玩家和僵尸中间
  ctx.zombies = [Z(700, 320)];
  assert.strictEqual(pick(P(), 1, 0, 560, null), null);
});

test('挡住的让位给打得到的，哪怕后者远一截', () => {
  ctx.pillars = [{ x: 560, y: 320, r: 40 }];
  const blocked = Z(700, 320);                      // 220px，但在柱子后面
  const clear   = Z(480, 600);                      // 280px，正下方，路是通的
  ctx.zombies = [blocked, clear];
  assert.strictEqual(pick(P(), 1, 0, 700, null), clear);
});

test('柱子在目标背后不算挡：只看玩家到目标这一段', () => {
  ctx.pillars = [{ x: 820, y: 320, r: 40 }];        // 在僵尸更远的那一侧
  ctx.zombies = [Z(700, 320)];
  assert.strictEqual(pick(P(), 1, 0, 560, null), ctx.zombies[0]);
});

/* ---------- 粘性：这一组针对的就是「方向一换就乱打」 ---------- */

test('冷静期粘性更强：刚换过靶时，小幅更近的抢不走', () => {
  const p = P();
  const locked = Z(400, 320);                       // 80px
  p.aimLock = locked;
  ctx.zombies = [locked, Z(415, 320)];              // 65px，近 19%
  const STICKY = constant('AIM_STICKY');
  const HOLD   = constant('AIM_STICKY_HOLD');
  assert.ok(HOLD > STICKY, '冷静期的粘性必须比常态大，否则这一档没有意义');
  assert.strictEqual(pick(p, 1, 0, 560, null, 'off', STICKY), ctx.zombies[1]);  // 常态会被抢走
  assert.strictEqual(pick(p, 1, 0, 560, null, 'off', HOLD), locked);            // 冷静期抢不走
});

test('冷静期也不是焊死：贴脸的照样抢得过', () => {
  const p = P();
  const locked = Z(400, 320);                       // 80px
  p.aimLock = locked;
  ctx.zombies = [locked, Z(490, 320)];              // 10px
  assert.strictEqual(pick(p, 1, 0, 560, null, 'off', constant('AIM_STICKY_HOLD')),
                     ctx.zombies[1]);
});

/* ---------- 绕障：挡路的是哪根柱子 ---------- */

test('挡路的柱子能认出来，没挡的不认', () => {
  const pil = { x: 300, y: 300, r: 40 };
  ctx.pillars = [pil];
  assert.strictEqual(blockingPillar(200, 300, 500, 300, 12), pil);   // 迎面撞上
  assert.strictEqual(blockingPillar(200, 100, 500, 100, 12), null);  // 从上方 200px 掠过
});

test('两根都挡时取更靠近起点的那一根：先绕眼前这个', () => {
  const near = { x: 300, y: 300, r: 30 };
  const far  = { x: 600, y: 300, r: 30 };
  ctx.pillars = [far, near];                        // 故意把远的放在数组前面
  assert.strictEqual(blockingPillar(200, 300, 900, 300, 12), near);
});

test('判定半径带上自身与余量：擦边过不去的也算挡住', () => {
  const pil = { x: 300, y: 300, r: 30 };
  ctx.pillars = [pil];
  // 从柱心侧向 44px 掠过：光看 30 已经躲开了，但 30+16=46 还是挡着。
  // 贴着柱面擦过去在观感上就是卡住，所以按后者算
  assert.strictEqual(blockingPillar(200, 344, 500, 344, 0), null);
  assert.strictEqual(blockingPillar(200, 344, 500, 344, 16), pil);
});

test('线段之外的柱子不算：目标在柱子这一侧时不该被自己身后的柱子绊住', () => {
  ctx.pillars = [{ x: 100, y: 300, r: 60 }];        // 在起点背后
  assert.strictEqual(blockingPillar(200, 300, 500, 300, 12), null);
});
