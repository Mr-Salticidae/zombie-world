import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../script.js', import.meta.url), 'utf8');

function setup(){
  const functions = ['guardFaces', 'turnGuard', 'enemyDamage', 'blockingPillar', 'stationDetour', 'updateRoadblockBoss'];
  const code = functions.map(name => {
    const fn = source.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^}', 'm'));
    assert.ok(fn, name);
    return fn[0];
  });
  const ram = source.match(/^const ROADBLOCK_RAM_SPEED = .*;$/m);
  assert.ok(ram);
  const ctx = vm.createContext({
    WW:1920, WH:1280, STATION_CROSSINGS:[300,960,1620], wave:3, shake:0, banners:[], pillars:[],
    livingPlayers:() => [], losBlocked:() => false, collide(){}, sfx(){}, sparks(){},
  });
  vm.runInContext([ram[0], ...code].join('\n'), ctx);
  return ctx;
}

test('越过同一段护栏前保持通道路线，视线短暂清空也不折返', () => {
  const ctx = setup();
  const rail = { x:510, y:420, r:42, rail:true };
  const z = { x:510, y:350, r:15 };
  const dx = ctx.stationDetour(z, 510, 560, rail)[0];
  assert.ok(dx < 0);
  z.x = z.railRoute.x;
  z.y = 420;
  const [crossX, crossY] = ctx.stationDetour(z, 510, 560, null);
  assert.equal(crossX, 0);
  assert.ok(crossY > 0);
  z.y = z.railRoute.exitY;
  assert.equal(ctx.stationDetour(z, 510, 560, null), null);
});

test('盾尸挡正面、露侧面，转身速度给绕侧留出反应时间', () => {
  const ctx = setup();
  const z = { shield:true, fx:1, fy:0 };
  assert.equal(ctx.guardFaces(z, 100, 0), true);
  ctx.turnGuard(z, -100, 0, .2);
  assert.equal(ctx.guardFaces(z, -100, 0), false);
  assert.equal(ctx.guardFaces(z, 0, 100), false);
  assert.equal(ctx.guardFaces(z, 100, 0), true);
});

test('路障巨尸沿预警方向冲锋，撞护栏后才进入破防状态', () => {
  const ctx = setup();
  ctx.pillars.push({ x:340, y:200, r:42, rail:true });
  const b = { x:100, y:200, r:26, T:{ roadblock:true }, fx:0, fy:1, mode:'walk', cool2:0, walk:0 };
  const p = { x:220, y:200 };
  ctx.updateRoadblockBoss(b, p, 120, .02);
  assert.equal(b.mode, 'ramTele');
  p.y += 150;
  ctx.updateRoadblockBoss(b, p, 190, .86);
  assert.equal(b.mode, 'ramDash');
  assert.equal(b.dashy, 0);
  for (let i = 0; i < 30 && b.mode === 'ramDash'; i++) ctx.updateRoadblockBoss(b, p, 190, .02);
  assert.equal(b.mode, 'ramStun');
  assert.equal(b.y, 200);
  assert.equal(ctx.guardFaces(b, 100, 0), false);
  assert.equal(ctx.enemyDamage(b, 25), 40);
  ctx.updateRoadblockBoss(b, p, 190, 2.5);
  assert.equal(b.mode, 'walk');
  assert.equal(ctx.guardFaces(b, 100, 0), true);
});

test('冲到地图边缘只收招', () => {
  const ctx = setup();
  const b = {
    x:30, y:200, r:26, T:{ roadblock:true }, mode:'ramDash', t:.8, dashx:-1, dashy:0
  };
  ctx.updateRoadblockBoss(b, null, 190, .025);
  assert.equal(b.mode, 'ramRecover');
  assert.equal(ctx.enemyDamage(b, 25), 25);
});
