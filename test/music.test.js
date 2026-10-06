/* 背景音乐的单测。
   music.js 不碰 DOM，直接在 vm 里跑；AudioContext 用一个假的，只记录「哪个节点在什么时刻开始」。
   假的 AudioParam 会检查自动化事件的时间是否单调——真浏览器里时间倒着排不会报错，
   只会出怪声，这类 bug 只能在这里抓。
   musicScene() 在 script.js 里，照 aim.test.js 的办法把源码原样抠出来测。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert';

const here = path.dirname(fileURLToPath(import.meta.url));
const musicSrc = readFileSync(path.join(here, '..', 'music.js'), 'utf8');
const scriptSrc = readFileSync(path.join(here, '..', 'script.js'), 'utf8');

function loadMusic(){
  const ctx = { window:{} };
  vm.createContext(ctx);
  vm.runInContext(musicSrc, ctx);
  return ctx.window.ZombieMusic;
}
const M = loadMusic();
// vm 里造的数组和这里的不是同一个领域，deepStrictEqual 连原型一起比，先转成普通数据
const plain = x => JSON.parse(JSON.stringify(x));

/* ---------- 假的 AudioContext ---------- */
class Param {
  constructor(v = 0){ this.value = v; this.last = -Infinity; }
  at(t, what){
    assert.ok(Number.isFinite(t), what + ' 的时间不是有限数：' + t);
    assert.ok(t >= this.last - 1e-9, what + ' 的时间倒着排了：' + t + ' < ' + this.last);
    this.last = t;
  }
  setValueAtTime(v, t){ this.at(t, 'setValueAtTime'); this.value = v; }
  linearRampToValueAtTime(v, t){ this.at(t, 'linearRamp'); this.value = v; }
  exponentialRampToValueAtTime(v, t){
    assert.ok(v > 0, '指数斜坡的目标必须 > 0');
    this.at(t, 'exponentialRamp'); this.value = v;
  }
  cancelScheduledValues(){ this.last = -Infinity; }
}
class Node { constructor(ac){ this.ac = ac; } connect(n){ return n; } disconnect(){} }
class Osc extends Node {
  constructor(ac){ super(ac); this.frequency = new Param(440); this.detune = new Param(0); this.type = 'sine'; }
  setPeriodicWave(w){ this.wave = w; }
  start(t){ this.ac.starts.push({ kind:'osc', t, node:this }); }
  stop(t){ this.stopAt = t; }
}
class Src extends Node {
  start(t){ this.ac.starts.push({ kind:'noise', t, node:this }); }
  stop(t){ this.stopAt = t; }
}
class Gain extends Node { constructor(ac){ super(ac); this.gain = new Param(1); } }
class Filter extends Node { constructor(ac){ super(ac); this.frequency = new Param(350); this.type = 'lowpass'; } }
class FakeAC {
  constructor(){ this.currentTime = 0; this.sampleRate = 8000; this.destination = new Node(this); this.starts = []; }
  createGain(){ return new Gain(this); }
  createOscillator(){ return new Osc(this); }
  createBiquadFilter(){ return new Filter(this); }
  createBufferSource(){ return new Src(this); }
  createBuffer(ch, len){ return { getChannelData:() => new Float32Array(len) }; }
  createPeriodicWave(real, imag){ return { real, imag }; }
}

// 按 dt 一帧一帧推着时间走，每帧 tick 一次（模拟游戏主循环）
function run(engine, ac, until, dt = 1 / 60, each){
  while (ac.currentTime < until - 1e-9){
    ac.currentTime = Math.min(until, ac.currentTime + dt);
    if (each) each(ac.currentTime);
    engine.tick();
  }
}
const stepSec = bpm => 60 / bpm / 4;

/* ---------- 曲谱 ---------- */
test('每首曲子的每个声部都有谱、每小节 16 格，音高在合理音域内', () => {
  for (const [key, song] of Object.entries(M.SONGS)){
    assert.ok(song.bars.length > 0, key + ' 没有小节');
    for (const [bi, bar] of song.bars.entries()){
      for (const tr of song.tracks){
        assert.ok(bar[tr.src], `${key} 第 ${bi + 1} 小节缺「${tr.src}」这行谱`);
        assert.strictEqual(bar[tr.src].length, M.STEPS);
        for (const evs of bar[tr.src]) for (const e of evs){
          if (tr.inst === 'drums') continue;
          const m = e.midi + (tr.shift || 0);
          assert.ok(m >= 30 && m <= 96, `${key} ${tr.src} 音高越界：${m}`);
          assert.ok(e.step + e.len <= M.STEPS, `${key} ${tr.src} 的音拖出了小节`);
        }
      }
    }
  }
  for (const [key, sc] of Object.entries(M.SCENES)) assert.ok(M.SONGS[sc.song], key + ' 指向不存在的曲子');
});

test('谱面解析：延音只接紧挨着的音，休止后的延音仍是休止；格数不对、音名不对都报错', () => {
  const ev = M.parseMelody('A4 - - . - C5 - . . . . . . . . .');
  assert.deepStrictEqual(plain(ev.map(e => [e.step, e.len, e.midi])), [[0, 3, 69], [5, 2, 72]]);
  assert.throws(() => M.parseMelody('A4 - -'), /16 格/);
  assert.throws(() => M.parseMelody('H4 . . . . . . . . . . . . . . .'), /音名/);
  assert.throws(() => M.parseDrums('kx . . . . . . . . . . . . . . .'), /鼓/);
  assert.strictEqual(M.midiOf('C#5'), 73);
  assert.strictEqual(M.midiOf('Bb3'), 58);
  assert.deepStrictEqual(plain(M.chordMidis("Am", 3)), [57, 60, 64]);     // A3 C4 E4：往上摞，不会掉到根音下面
});

/* ---------- 引擎 ---------- */
test('只排未来 LOOKAHEAD 秒内的音，而且包络时间点全部单调', () => {
  const ac = new FakeAC();
  const e = M.createEngine(ac);
  e.setScene('combat', { level:4, bpm:162 });
  run(e, ac, 3, 1 / 60, now => {
    for (const s of ac.starts) assert.ok(s.t <= now + M.LOOKAHEAD + 1e-6, `排得太远：${s.t} > ${now} + ${M.LOOKAHEAD}`);
  });
  assert.ok(ac.starts.length > 50, '三秒的满编战斗曲应该排了不少音');
});

test('换曲等到小节线；BOSS 这种急事等到下一拍，并先敲一声吊镲', () => {
  const ac = new FakeAC();
  const e = M.createEngine(ac);
  e.setScene('menu');
  run(e, ac, 0.05);
  const t0 = ac.starts[0].t;                                   // 主菜单第一拍（第一个排出的音）
  const bar = stepSec(M.SCENES.menu.bpm) * M.STEPS;
  run(e, ac, t0 + bar * 0.4);                              // 停在第一小节中间
  e.setScene('shop');
  let switchedAt = null;
  run(e, ac, t0 + bar * 2, 1 / 60, () => {
    if (switchedAt === null && e.playing && e.playing.key === 'shop') switchedAt = ac.currentTime;
  });
  assert.ok(switchedAt !== null, '一直没换到商店曲');
  assert.ok(switchedAt >= t0 + bar - M.LOOKAHEAD - 1e-6, '商店曲在小节线之前就切进来了');

  // 急事：BOSS 登场在下一拍切，吊镲是一个持续约 1 秒的噪声
  const ac2 = new FakeAC();
  const e2 = M.createEngine(ac2);
  e2.setScene('combat', { level:2, bpm:144 });
  run(e2, ac2, 0.05);
  const c0 = ac2.starts[0].t;
  run(e2, ac2, c0 + stepSec(144) * 5.5);                   // 第 6 格附近
  const before = ac2.starts.length;
  e2.setScene('boss');
  run(e2, ac2, c0 + stepSec(144) * 9);
  const crash = ac2.starts.slice(before).find(s => s.kind === 'noise' && s.node.stopAt - s.t > 0.9);
  assert.ok(crash, 'BOSS 登场没有吊镲');
  const beat = stepSec(144) * 4;
  const k = Math.round((crash.t - c0) / beat);
  assert.ok(Math.abs(crash.t - (c0 + k * beat)) < 1e-6, '吊镲没落在拍子上：' + crash.t);
  assert.strictEqual(k, 2, '应该在第 2 拍（第 8 格）切进来');
});

test('后台标签页回来：落后太多就跳到现在，不把攒下的音一口气补出来', () => {
  const ac = new FakeAC();
  const e = M.createEngine(ac);
  e.setScene('combat', { level:4, bpm:162 });
  run(e, ac, 1);
  const n = ac.starts.length;
  ac.currentTime = 11;                                     // 十秒没调 tick（主循环停了）
  e.tick();
  const burst = ac.starts.slice(n);
  for (const s of burst) assert.ok(s.t >= 11, '补出了过去时刻的音：' + s.t);
  const maxSteps = Math.ceil((M.LOOKAHEAD + 0.05) / stepSec(162)) + 1;
  const perStep = 40;                                      // 一格最多也就十几个节点，留足余量
  assert.ok(burst.length <= maxSteps * perStep, '回来第一帧排了 ' + burst.length + ' 个节点');
});

test('档位越高声部越多；速度只在整首回到开头时生效', () => {
  const count = (level) => {
    const ac = new FakeAC();
    const e = M.createEngine(ac);
    e.setScene('combat', { level, bpm:144 });
    run(e, ac, stepSec(144) * M.STEPS * 2);
    return ac.starts.length;
  };
  const counts = [0, 1, 2, 3, 4].map(count);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] > counts[i - 1], '档位 ' + i + ' 没比 ' + (i - 1) + ' 厚：' + counts);

  const ac = new FakeAC();
  const e = M.createEngine(ac);
  e.setScene('combat', { level:2, bpm:144 });
  run(e, ac, stepSec(144) * M.STEPS * 1.5);
  e.setScene('combat', { level:2, bpm:162 });              // 同一首曲子中途要求变速
  run(e, ac, stepSec(144) * M.STEPS * 3);
  assert.strictEqual(e.playing.bpm, 144, '中途就变速了');
  const songBars = M.SONGS.combat.bars.length;
  run(e, ac, stepSec(144) * M.STEPS * (songBars + 1));
  assert.strictEqual(e.playing.bpm, 162, '回到曲首也没变速');
});

test('阵亡收尾只放一遍，之后静着，换到结算才接着放', () => {
  const ac = new FakeAC();
  const e = M.createEngine(ac);
  e.setScene('gameover');
  const len = stepSec(M.SCENES.gameover.bpm) * M.STEPS * M.SONGS.gameover.bars.length;
  run(e, ac, len + 1);
  assert.strictEqual(e.playing, null, '放完还在放');
  const n = ac.starts.length;
  run(e, ac, len + 3);
  assert.strictEqual(ac.starts.length, n, '放完之后还在排音');
  e.setScene('results');
  run(e, ac, len + 4);
  assert.ok(ac.starts.length > n, '换到结算没有接着放');
  assert.strictEqual(e.playing.key, 'results');
});

test('关掉音乐：不再创建节点，但位置照走，再打开从当下接着放', () => {
  const ac = new FakeAC();
  const e = M.createEngine(ac);
  e.setScene('menu');
  e.setEnabled(false);
  run(e, ac, 2);
  assert.strictEqual(ac.starts.filter(s => s.t > 0.5).length, 0, '关着还在排音');
  const pos = e.playing.bar * M.STEPS + e.playing.step;
  assert.ok(pos > 0, '关着的时候位置没往前走');
  e.setEnabled(true);
  run(e, ac, 3);
  assert.ok(ac.starts.some(s => s.t >= 2), '打开之后没声音');
});

/* ---------- script.js 的 musicScene ---------- */
function extract(name){
  const start = scriptSrc.indexOf('function ' + name);
  assert.ok(start > 0, '没找到 ' + name);
  let depth = 0;
  for (let i = scriptSrc.indexOf('{', start); i < scriptSrc.length; i++){
    if (scriptSrc[i] === '{') depth++;
    else if (scriptSrc[i] === '}' && --depth === 0) return scriptSrc.slice(start, i + 1);
  }
  throw new Error(name + ' 的花括号没配平');
}
function sceneCtx(over = {}){
  const hold = Number(scriptSrc.match(/const MUSIC_BOSS_HOLD\s*=\s*(\d+)/)[1]);
  const ctx = Object.assign({
    state:'play', shopOpen:false, bosses:[], zombies:[], devils:[], wave:1,
    cam:{ x:0, y:0 }, VW:960, VH:640, MUSIC_BOSS_HOLD:hold, musicBossSeenAt:-Infinity,
  }, over);
  vm.createContext(ctx);
  vm.runInContext(extract('musicScene'), ctx);
  return ctx;
}

test('musicScene：菜单、阵亡、结算、商店各归各的', () => {
  for (const s of ['menu', 'mapsel', 'help', 'online', 'rank']) assert.strictEqual(sceneCtx({ state:s }).musicScene(0).scene, 'menu');
  assert.strictEqual(sceneCtx({ state:'dying' }).musicScene(0).scene, 'gameover');
  assert.strictEqual(sceneCtx({ state:'over' }).musicScene(0).scene, 'results');
  assert.strictEqual(sceneCtx({ shopOpen:true, bosses:[{ x:10, y:10 }] }).musicScene(0).scene, 'shop');
  assert.strictEqual(sceneCtx({ state:'pause' }).musicScene(0).scene, 'combat', '暂停不换曲，只压低');
});

test('musicScene：BOSS 走进画面才切 BOSS 曲，离开画面撑够时间才切回', () => {
  const ctx = sceneCtx({ bosses:[{ x:2000, y:2000 }] });   // 在画面外
  assert.strictEqual(ctx.musicScene(0).scene, 'combat');
  ctx.bosses[0].x = 400; ctx.bosses[0].y = 300;            // 走进来
  assert.strictEqual(ctx.musicScene(1000).scene, 'boss');
  ctx.bosses[0].x = 2000;                                  // 又出去了
  assert.strictEqual(ctx.musicScene(1000 + ctx.MUSIC_BOSS_HOLD - 1).scene, 'boss', '刚出画面就切回去了');
  assert.strictEqual(ctx.musicScene(1000 + ctx.MUSIC_BOSS_HOLD + 1).scene, 'combat');
  ctx.bosses.length = 0;                                   // 死了：立刻回战斗曲
  assert.strictEqual(ctx.musicScene(1100).scene, 'combat');
});

test('musicScene：战斗随波次和尸潮加厚、提速', () => {
  const at = (wave, alive) => sceneCtx({ wave, zombies:Array.from({ length:alive }, () => ({})) }).musicScene(0);
  assert.strictEqual(at(0, 0).level, 1);
  assert.strictEqual(at(1, 0).level, 2);
  assert.strictEqual(at(1, 12).level, 3, '第一波尸潮一密就该上主旋律');
  assert.strictEqual(at(3, 0).level, 3);
  assert.strictEqual(at(3, 30).level, 4);
  assert.strictEqual(at(6, 0).level, 4);
  assert.strictEqual(at(1, 0).bpm, 144);
  assert.strictEqual(at(5, 0).bpm, 152);
  assert.strictEqual(at(20, 0).bpm, 162, '速度要封顶');
});
