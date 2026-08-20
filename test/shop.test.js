/* 局内货币与波间商店的单测。
   跟 aim.test.js 同一套路：把 script.js 里的真函数原样抠出来丢进 vm，
   测的是仓库里那一份，不是复刻件。依赖的全局在 ctx 里注入。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'script.js'), 'utf8');

function balanced(start, open, close){
  let depth = 0;
  for (let i = src.indexOf(open, start); i < src.length; i++){
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('括号没配平：' + src.slice(start, start + 40));
}
function extract(name){
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > 0, '没找到 ' + name);
  return balanced(start, '{', '}');
}
// 武器表也从源码里读——价钱是按 unlock 算的，表和公式必须是同一份
function constArray(name){
  const start = src.indexOf('const ' + name + ' = [');
  assert.ok(start > 0, '没找到 ' + name);
  return balanced(start, '[', ']');
}
function constant(name){
  // 不写死 const 前缀：这几个常量是 `const A = 1, B = 2;` 这样并排声明的
  const m = src.match(new RegExp('\\b' + name + '\\s*=\\s*([-\\d.]+)'));
  assert.ok(m, '没找到常量 ' + name);
  return Number(m[1]);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext([
  constArray('WEAPONS') + ';',
  'const WN = WEAPONS.length;',
  'const SHOP_HEAL = ' + constant('SHOP_HEAL') + ';',
  'const SHOP_HEAL_COST = ' + constant('SHOP_HEAL_COST') + ';',
  'const SHOP_ULT_COST = ' + constant('SHOP_ULT_COST') + ';',
  'const SHOP_ULT_MAX = ' + constant('SHOP_ULT_MAX') + ';',
  extract('coinValue'),
  extract('ammoPackAmount'),
  extract('ammoPackCost'),
  extract('shopCatalog'),
  extract('buyItem'),
  'globalThis.API = { WEAPONS, WN, coinValue, ammoPackAmount, ammoPackCost, shopCatalog, buyItem };',
].join(String.fromCharCode(10)), ctx);

const { WEAPONS, WN, coinValue, ammoPackAmount, ammoPackCost, shopCatalog, buyItem } = ctx.API;
const HEAL = constant('SHOP_HEAL'), HEAL_COST = constant('SHOP_HEAL_COST');
const ULT_COST = constant('SHOP_ULT_COST'), ULT_MAX = constant('SHOP_ULT_MAX');

// 一个「打到中期」的玩家：解锁到乌兹，手上有点钱
function P(over){
  return Object.assign({
    cash: 100, hp: 100, ultCharge: 1,
    unlocked: WEAPONS.map((w, i) => i <= 2),
    ammo: WEAPONS.map((w, i) => w.infinite ? Infinity : (i <= 2 ? 10 : 0)),
  }, over);
}
// 拼成字符串再比：数组是从 vm 那个 realm 出来的，deepStrictEqual 会因为原型不同判不等
const ids = p => shopCatalog(p).map(it => it.id).join(',');

/* ---------- 金币面值 ---------- */

test('钱按击杀基础分折算，不乘连击倍数', () => {
  // 倍数已经在管武器解锁了，再让它管钱，后期会「枪全解锁 + 钱多到没处花」两条线一起失重
  assert.strictEqual(coinValue(10), 2);      // 普通僵尸
  assert.strictEqual(coinValue(40), 8);      // 红恶魔
  assert.strictEqual(coinValue(120), 24);    // 一级 BOSS
  assert.strictEqual(coinValue(440), 88);    // 僵尸博士
});

test('再小的击杀也至少值 1 —— 掉一枚 0 元金币是纯粹的噪音', () => {
  assert.strictEqual(coinValue(1), 1);
  assert.strictEqual(coinValue(0), 1);
});

/* ---------- 弹药包 ---------- */

test('弹药包的量跟地上捡的补给一致（give 的一半）', () => {
  for (let i = 0; i < WN; i++){
    if (WEAPONS[i].infinite) continue;
    assert.strictEqual(ammoPackAmount(i), Math.ceil(WEAPONS[i].give * .5), WEAPONS[i].name);
  }
});

test('价钱按解锁门槛单调递增：越靠后解锁的枪越贵', () => {
  const paid = [];
  for (let i = 0; i < WN; i++){
    if (WEAPONS[i].infinite) continue;
    paid.push({ name: WEAPONS[i].name, unlock: WEAPONS[i].unlock, cost: ammoPackCost(i) });
  }
  const byUnlock = paid.slice().sort((a, b) => a.unlock - b.unlock);
  for (let i = 1; i < byUnlock.length; i++){
    assert.ok(byUnlock[i].cost > byUnlock[i-1].cost,
      byUnlock[i].name + ' 应该比 ' + byUnlock[i-1].name + ' 贵');
  }
});

/* ---------- 货架 ---------- */

test('只卖消耗品：货架上不存在任何一件能买到枪的东西', () => {
  // 枪的所有权归连击。钱能买枪的话，「连击解锁武器」这条核心成长线当场作废
  const p = P({ cash: 99999 });
  for (const it of shopCatalog(p)) assert.ok(['ammo', 'heal', 'ult'].includes(it.kind), it.id);
});

test('没解锁的枪不上货架，无限弹药的手枪也不上', () => {
  const p = P();
  assert.strictEqual(ids(p), 'ammo1,ammo2,heal,ult');   // 手枪(0) 无限，3 以后没解锁
  assert.ok(WEAPONS[0].infinite, '前提：0 号是无限弹药的手枪');
});

test('钱不够的置灰但仍然列出来 —— 要让人看见「还差多少」', () => {
  const p = P({ cash: 0 });
  const cat = shopCatalog(p);
  assert.ok(cat.length > 0);
  assert.ok(cat.every(it => it.ok === false));
  assert.ok(cat.every(it => it.cost > 0));
});

test('满血时医疗包标成已满，不是「买不起」', () => {
  const full = shopCatalog(P({ hp: 100 })).find(it => it.id === 'heal');
  assert.strictEqual(full.full, true);
  assert.strictEqual(full.ok, false);
  const hurt = shopCatalog(P({ hp: 99 })).find(it => it.id === 'heal');
  assert.strictEqual(hurt.full, false);
  assert.strictEqual(hurt.ok, true);
});

test('无双充能有上限，攒满了就不再卖', () => {
  const maxed = shopCatalog(P({ cash: 9999, ultCharge: ULT_MAX })).find(it => it.id === 'ult');
  assert.strictEqual(maxed.full, true);
  assert.strictEqual(maxed.ok, false);
});

/* ---------- 结账 ---------- */

test('买弹药：扣钱、加弹，两件事都要发生', () => {
  const p = P({ cash: 100 });
  assert.strictEqual(buyItem(p, 'ammo2'), true);
  assert.strictEqual(p.cash, 100 - ammoPackCost(2));
  assert.strictEqual(p.ammo[2], 10 + ammoPackAmount(2));
});

test('买医疗包不会超过 100 血，钱照扣（是玩家自己选的时机）', () => {
  const p = P({ cash: 100, hp: 95 });
  assert.strictEqual(buyItem(p, 'heal'), true);
  assert.strictEqual(p.hp, 100);
  assert.strictEqual(p.cash, 100 - HEAL_COST);
});

test('买无双充能：+1 次，封顶不溢出', () => {
  const p = P({ cash: ULT_COST * 3, ultCharge: 0 });
  assert.strictEqual(buyItem(p, 'ult'), true);
  assert.strictEqual(p.ultCharge, 1);
  assert.strictEqual(buyItem(p, 'ult'), true);
  assert.strictEqual(p.ultCharge, ULT_MAX);
  assert.strictEqual(buyItem(p, 'ult'), false);      // 已满
  assert.strictEqual(p.cash, ULT_COST * 3 - ULT_COST * 2);
});

test('钱不够就买不成，而且一分钱都不能扣', () => {
  const p = P({ cash: ammoPackCost(1) - 1 });
  const before = p.cash;
  assert.strictEqual(buyItem(p, 'ammo1'), false);
  assert.strictEqual(p.cash, before);
  assert.strictEqual(p.ammo[1], 10);
});

test('没解锁的枪买不到弹药：绕开货架直接报 id 也不行', () => {
  // 这条是给联机准备的：客机发过来的 id 不可信，结账这一关必须自己再验一遍
  const p = P({ cash: 99999 });
  assert.strictEqual(buyItem(p, 'ammo8'), false);    // 火箭筒没解锁
  assert.strictEqual(p.ammo[8], 0);
  assert.strictEqual(p.cash, 99999);
});

test('乱七八糟的 id 一律不成交，也不报错', () => {
  const p = P({ cash: 99999 });
  for (const bad of ['', 'weapon8', 'ammo', 'ammo99', 'ammo-1', '__proto__', 'heal ', null, undefined, 7, {}])
    assert.strictEqual(buyItem(p, bad), false, String(bad));
  assert.strictEqual(p.cash, 99999);
});

test('把钱花光：能买的越来越少，最后一件都买不动', () => {
  const p = P({ cash: 200, hp: 60 });
  let bought = 0;
  for (let guard = 0; guard < 30; guard++){
    const next = shopCatalog(p).filter(it => it.ok).sort((a, b) => b.cost - a.cost)[0];
    if (!next) break;
    assert.strictEqual(buyItem(p, next.id), true);
    bought++;
  }
  assert.ok(bought > 0, '200 块总得买得起点什么');
  assert.ok(p.cash >= 0, '钱不能花成负数');
  assert.strictEqual(shopCatalog(p).some(it => it.ok), false);
});
