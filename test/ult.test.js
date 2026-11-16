import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../script.js', import.meta.url), 'utf8');

function fixture(){
  const player = makePlayer('host', 1);
  const guest = makePlayer('guest', 0);
  const dropped = [];
  const context = vm.createContext({
    player, players: new Map([[player.id, player], [guest.id, guest]]),
    state: 'play', netMode: 'host', WN: 9,
    frameN: 1, kills: 0, streak: 0, comboTimer: 0, score: 0, multiplier: 2, shake: 0,
    zombies: [], devils: [], bosses: [], pickups: [], particles: [], banners: [],
    dropCoin(...args){ dropped.push(args); },
    coinValue: baseScore => baseScore / 5,
    updateMulti(){}, sfx(){}, blood(){},
  });
  const functions = ['activateUlt', 'enemyDamage', 'updatePlayerFromInput', 'killReward'].map(name => {
    const definition = source.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^}', 'm'));
    assert.ok(definition, name);
    return definition[0];
  });
  const constants = source.match(/^const ULT_(?:DURATION|KILLS_REQUIRED) = \d+;$/gm);
  assert.equal(constants?.length, 2);
  vm.runInContext([...constants, ...functions].join('\n'), context);
  return { context, player, guest, dropped };
}

function makePlayer(id, ultCharge){
  return { id, name: id, hp: 70, x: 0, y: 0, ultCharge, ultT: 0, ultKills: 0, lastUltSeq: 0 };
}

test('无双发动后持续 12 秒，期间 50 次击杀只发放战斗奖励', () => {
  const { context, player, dropped } = fixture();
  context.activateUlt(player);
  assert.equal(player.ultCharge, 0);
  assert.equal(player.ultT, 12);

  context.updatePlayerFromInput(player, {}, .016, 0);
  for (let i = 0; i < 50; i++) context.killReward(1, 1, 10, player.id);

  assert.equal(player.ultKills, 0);
  assert.equal(player.ultCharge, 0);
  assert.equal(context.kills, 50);
  assert.equal(context.streak, 50);
  assert.equal(context.score, 1_000);
  assert.equal(dropped.length, 50);
});

test('无双最后一刀不充能，下一帧的击杀可充满', () => {
  const { context, player } = fixture();
  context.activateUlt(player);
  player.ultKills = 49;
  player.ultT = .01;
  const enemy = { x: 20, y: 0, r: 12, hp: 10 };
  context.zombies.push(enemy);
  context.updatePlayerFromInput(player, {}, .016, 0);

  assert.equal(player.ultT, 0);
  assert.ok(enemy.hp <= 0);
  context.killReward(enemy.x, enemy.y, 10, enemy.lastHitBy);
  assert.equal(player.ultKills, 49);
  assert.equal(player.ultCharge, 0);

  context.frameN++;
  context.killReward(0, 0, 10, player.id);
  assert.equal(player.ultKills, 0);
  assert.equal(player.ultCharge, 1);
});

test('联机房主只锁定正在无双的玩家，队友照常充能', () => {
  const { context, player, guest } = fixture();
  player.ultCharge = 0;
  guest.ultCharge = 1;
  context.updatePlayerFromInput(guest, { ultSeq: 1 }, .016, 0);
  assert.ok(guest.ultT > 11);

  context.killReward(0, 0, 10, guest.id);
  context.killReward(0, 0, 10, player.id);
  assert.equal(guest.ultKills, 0);
  assert.equal(player.ultKills, 1);
});
