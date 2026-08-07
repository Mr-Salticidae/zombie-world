"use strict";
/* ============================================================
   僵尸危机：方块头 · 经典复刻版 v2
   原创代码与手绘风美术，致敬童年经典 Boxhead 系列玩法
   v2：沙地大地图 + 镜头跟随 + 描边卡通渲染 + 重制音效
   ============================================================ */
const cvs = document.getElementById('game');
const ctx = cvs.getContext('2d');
const wrap = document.getElementById('wrap');
const rotateTip = document.getElementById('rotate');
let VW = 960, VH = 640;            // 视口（虚拟坐标系）：横屏 960×640，竖屏换成竖版比例
const WW = 1920, WH = 1280;        // 世界尺寸
const VIEW_AREA = 960 * 640;       // 可视面积恒定：竖屏不会因为看得更少而凭空变难
let viewScale = 1;                 // 一个虚拟像素当前占几个屏幕像素
const ULT_BTN = { x: VW-52, y: VH-104, r: 28 };   // PC 端画在画布里的无双圆钮

// 多设备环境判断（参照 Toy 多设备自适应指南：组合 pointer/hover/visualViewport，不只看 UA）
const coarsePointer = matchMedia('(pointer: coarse)').matches;
const isTouch = coarsePointer || ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
function isPhone(){ return Math.min(innerWidth, innerHeight) <= 540; }

// 视口比例跟着容器走：横屏（含 PC）保持经典 960×640；竖屏换成等面积的竖版视口。
// 竖屏因此是「能正常玩的另一种版式」，不再需要把人挡在「请旋转到横屏」后面——
// B站 App 内嵌 WebView 常常锁竖屏，转不过来的人以前是直接玩不了。
function applyViewport(availW, availH){
  let vw = 960, vh = 640;
  const raw = (availW > 0 && availH > 0) ? availW / availH : 1.5;
  if (raw < 1.15){
    const a = Math.max(.55, Math.min(1.15, raw));
    vw = Math.round(Math.sqrt(VIEW_AREA * a));
    vh = Math.round(Math.sqrt(VIEW_AREA / a));
  }
  vw = Math.min(vw, WW); vh = Math.min(vh, WH);
  if (vw === VW && vh === VH) return;
  VW = vw; VH = vh;
  cvs.width = VW; cvs.height = VH;
  ULT_BTN.x = VW - 52; ULT_BTN.y = VH - 104;
  if (cam){                                   // 视口变了，镜头范围要重新夹紧
    cam.x = Math.max(0, Math.min(WW-VW, cam.x));
    cam.y = Math.max(0, Math.min(WH-VH, cam.y));
  }
}

// 画布按容器尺寸等比缩放（扣除安全区内边距）；逻辑用虚拟坐标，渲染时映射真实像素
function fit(){
  const cs = getComputedStyle(wrap);
  const availW = wrap.clientWidth  - parseFloat(cs.paddingLeft)  - parseFloat(cs.paddingRight);
  const availH = wrap.clientHeight - parseFloat(cs.paddingTop)   - parseFloat(cs.paddingBottom);
  applyViewport(availW, availH);
  viewScale = Math.min(availW / VW, availH / VH);
  cvs.style.width  = Math.round(VW * viewScale) + 'px';
  cvs.style.height = Math.round(VH * viewScale) + 'px';
  layoutTouchUI();
}

function localStoreGet(key){
  try { return window.localStorage ? window.localStorage.getItem(key) : null; }
  catch (_) { return null; }
}
function localStoreSet(key, value){
  try {
    if (window.localStorage) window.localStorage.setItem(key, value);
    return true;
  } catch (_) { return false; }
}

// 竖屏只给一条可关掉的横幅提示，绝不冻结游戏
const ROTATE_KEY = 'zombie-world-rotate-tip';
let rotateTipShown = false, rotateTipTimer = null;
function hideRotateTip(){
  clearTimeout(rotateTipTimer); rotateTipTimer = null;
  rotateTip.classList.add('hidden');
}
function checkOrient(){
  if (innerHeight <= innerWidth){ hideRotateTip(); return; }
  if (rotateTipShown || !isPhone() || localStoreGet(ROTATE_KEY) === 'off') return;
  rotateTipShown = true;
  rotateTip.classList.remove('hidden');
  rotateTipTimer = setTimeout(hideRotateTip, 6500);
}
document.getElementById('rotateOk').onclick = () => {
  localStoreSet(ROTATE_KEY, 'off');
  hideRotateTip();
};
function onViewportChange(){ fit(); checkOrient(); }
addEventListener('resize', onViewportChange);
addEventListener('orientationchange', onViewportChange);
if (window.visualViewport) visualViewport.addEventListener('resize', onViewportChange);

/* ========================================================
   音效 v2 —— 全部 Web Audio 实时合成，强调打击感
   ======================================================== */
let AC = null, master = null, comp = null;
function audioInit(){
  if (AC){
    if (AC.state === 'suspended') AC.resume().catch(() => {});
    return;
  }
  AC = new (window.AudioContext || window.webkitAudioContext)();
  comp = AC.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = .002; comp.release.value = .12;
  master = AC.createGain(); master.gain.value = 0.6;
  master.connect(comp); comp.connect(AC.destination);
}
// 全局复用一块 2 秒白噪声，避免每次音效都重新分配+填充缓冲
let noiseBuf = null;
function nbuf(){
  if (!noiseBuf){
    const len = (AC.sampleRate * 2) | 0;
    noiseBuf = AC.createBuffer(1, len, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}
// 小工具：噪声 -> 滤波 -> 包络
function noiseHit(dur, ftype, freq, q, vol, fEnd){
  const n = AC.createBufferSource(); n.buffer = nbuf();
  const off = Math.random() * Math.max(0, 2 - dur);   // 随机起点，保留每发音色差异
  const f = AC.createBiquadFilter(); f.type = ftype; f.Q.value = q || 1;
  const t = AC.currentTime;
  f.frequency.setValueAtTime(freq, t);
  if (fEnd) f.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
  const g = AC.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(.0008, t + dur);
  n.connect(f); f.connect(g); g.connect(master);
  n.start(t, off); n.stop(t + dur + .05);
}
// 小工具：振荡器扫频
function sweep(type, f0, f1, dur, vol, delay){
  const t = AC.currentTime + (delay || 0);
  const o = AC.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = AC.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(.0008, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + .02);
}
function sfx(type){
  if (!AC) return;
  const t = AC.currentTime;
  switch (type){
    case 'pistol':
      noiseHit(.14, 'bandpass', 1900, .7, .8, 500);   // 枪口爆音
      sweep('square', 320, 70, .09, .35);              // 低频冲击
      sweep('sine', 90, 40, .12, .5);                  // 胸腔感
      noiseHit(.04, 'highpass', 5200, 1, .35);         // 机械咔哒
      break;
    case 'uzi':
      noiseHit(.07, 'bandpass', 2400, .8, .5, 800);
      sweep('square', 260, 90, .05, .22);
      sweep('sine', 110, 50, .07, .3);
      break;
    case 'shotgun':
      noiseHit(.42, 'lowpass', 1500, .6, 1.1, 120);
      sweep('sine', 95, 26, .4, .9);
      noiseHit(.06, 'highpass', 4200, 1, .5);
      // 拉栓声
      setTimeout(() => { if (AC){ noiseHit(.05,'bandpass',2800,3,.25); setTimeout(()=>AC&&noiseHit(.05,'bandpass',2200,3,.25),90);} }, 320);
      break;
    case 'rocket':
      noiseHit(.5, 'bandpass', 600, .8, .6, 180);
      sweep('sawtooth', 180, 60, .45, .25);
      break;
    case 'boom': {
      sweep('sine', 70, 22, .75, 1.1);                 // 深沉低频
      noiseHit(.8, 'lowpass', 1000, .6, 1.1, 50);      // 主爆
      noiseHit(.25, 'highpass', 2600, 1, .4);          // 碎裂
      // 余烬噼啪
      for (let i = 0; i < 4; i++)
        setTimeout(() => AC && noiseHit(.05, 'bandpass', 1500+Math.random()*2500, 4, .14), 150 + i*110 + Math.random()*60);
      break;
    }
    case 'groan': {
      // 双振荡器失谐 + 颤音 + 低通：更"肉"的僵尸吼
      const base = 75 + Math.random() * 55;
      const dur = .55 + Math.random() * .3;
      const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
      const g = AC.createGain();
      g.gain.setValueAtTime(.0001, t);
      g.gain.linearRampToValueAtTime(.16, t + .08);
      g.gain.exponentialRampToValueAtTime(.0008, t + dur);
      f.connect(g); g.connect(master);
      const lfo = AC.createOscillator(); lfo.frequency.value = 6 + Math.random()*4;
      const lg = AC.createGain(); lg.gain.value = 14;
      lfo.connect(lg);
      [1, 1.013].forEach(mul => {
        const o = AC.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(base * mul, t);
        o.frequency.linearRampToValueAtTime(base * mul * .62, t + dur);
        lg.connect(o.frequency);
        o.connect(f); o.start(t); o.stop(t + dur + .05);
      });
      lfo.start(t); lfo.stop(t + dur + .05);
      break;
    }
    case 'splat':
      noiseHit(.12, 'lowpass', 700, .8, .55, 150);
      sweep('sine', 320, 70, .09, .3);
      break;
    case 'hurt':
      sweep('square', 240, 60, .2, .35);
      noiseHit(.1, 'lowpass', 500, 1, .3);
      break;
    case 'pickup':
      sweep('square', 660, 660, .06, .18);
      sweep('square', 990, 990, .1, .18, .06);
      break;
    case 'unlock':
      [523, 659, 784, 1046].forEach((fq, i) => sweep('square', fq, fq, .16, .16, i * .09));
      break;
    case 'wave':
      // 僵尸群入场：多声重叠呻吟 + 低频地鸣
      sweep('sine', 55, 28, .9, .5);
      noiseHit(.6, 'lowpass', 380, .8, .35, 90);
      sfx('groan');
      setTimeout(() => AC && sfx('groan'), 180);
      setTimeout(() => AC && sfx('groan'), 390);
      break;
    case 'roar': {
      // Boss 入场咆哮：超低双振荡 + 颤音 + 轰鸣
      const base = 44 + Math.random()*8;
      const dur = 1.1;
      const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 320;
      const g = AC.createGain();
      g.gain.setValueAtTime(.0001, t);
      g.gain.linearRampToValueAtTime(.4, t + .1);
      g.gain.exponentialRampToValueAtTime(.0008, t + dur);
      f.connect(g); g.connect(master);
      const lfo = AC.createOscillator(); lfo.frequency.value = 5;
      const lg = AC.createGain(); lg.gain.value = 10;
      lfo.connect(lg);
      [1, 1.02].forEach(mul => {
        const o = AC.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(base * mul, t);
        o.frequency.linearRampToValueAtTime(base * mul * .55, t + dur);
        lg.connect(o.frequency);
        o.connect(f); o.start(t); o.stop(t + dur + .05);
      });
      lfo.start(t); lfo.stop(t + dur + .05);
      noiseHit(.7, 'lowpass', 600, .7, .5, 60);
      sweep('sine', 80, 24, .9, .6);
      break;
    }
    case 'fire':
      noiseHit(.28, 'highpass', 700, .8, .35, 2800);
      sweep('sawtooth', 500, 160, .25, .12);
      break;
    case 'click':
      noiseHit(.04, 'bandpass', 2600, 4, .25);
      break;
  }
}

/* ========================================================
   世界生成：沙地 + 灰斑 + 草丛刮痕 + 六棱石柱
   ======================================================== */
let rngSeed = 7;
function rnd(){ rngSeed = (rngSeed * 16807) % 2147483647; return (rngSeed - 1) / 2147483646; }

// 障碍物：六棱石柱（圆形碰撞体）
const pillars = [];
function buildPillars(){
  pillars.length = 0;
  const add = (x, y, r, h) => pillars.push({ x, y, r, h });
  // 仿截图：成簇的大柱 + 一排小柱
  add(540, 230, 64, 120); add(700, 215, 60, 116);
  add(420, 150, 30, 56);  add(840, 160, 30, 56); add(905, 175, 28, 52);
  add(1430, 300, 62, 118); add(1580, 270, 58, 110);
  add(1330, 220, 30, 54);
  add(330, 880, 58, 108); add(470, 940, 62, 116);
  add(1250, 960, 60, 112); add(1400, 1000, 56, 104); add(1330, 870, 30, 56);
  add(960, 620, 34, 62);
}
buildPillars();

// 地图上预置的油桶（灰色橙条，可引爆）
const BARREL_SPOTS = [
  [260,470],[300,470],[760,760],[1120,420],[1160,440],[1680,720],
  [560,1120],[600,1100],[1500,520],[860,980],[900,1000],[1720,1080]
];

/* ---------- 预渲染地面 ---------- */
const ground = document.createElement('canvas');
ground.width = WW; ground.height = WH;
const gctx = ground.getContext('2d');
function blob(c, x, y, r, color, alpha){
  c.globalAlpha = alpha;
  c.fillStyle = color;
  c.beginPath();
  const n = 9 + (rnd()*5|0);
  for (let i = 0; i <= n; i++){
    const a = i/n * Math.PI*2;
    const rr = r * (.6 + rnd()*.65);
    const px = x + Math.cos(a)*rr, py = y + Math.sin(a)*rr*.8;
    i ? c.lineTo(px, py) : c.moveTo(px, py);
  }
  c.closePath(); c.fill();
  c.globalAlpha = 1;
}
function tuft(c, x, y, s, color){
  c.strokeStyle = color; c.lineWidth = 1.6; c.globalAlpha = .8;
  const n = 7 + (rnd()*6|0);
  for (let i = 0; i < n; i++){
    const a = rnd()*Math.PI*2, l = s*(.4+rnd()*.8);
    c.beginPath();
    c.moveTo(x + Math.cos(a)*s*.15, y + Math.sin(a)*s*.1);
    c.lineTo(x + Math.cos(a)*l, y + Math.sin(a)*l*.55);
    c.stroke();
  }
  c.globalAlpha = 1;
}
/* ---------- 五种地图主题 ---------- */
const MAPS = [
  { name:'沙漠荒野', base:'#dccfb2', patch1:'#c3bdb2', patch2:'#cdc6ba', light:'#e6dcc1',
    dark:'#c9b894', tuft1:'#b9ad8d', tuft2:'#a8a08c', pil:['#bdb8ae','#a8a399','#e9e6df'] },
  { name:'冰原雪地', base:'#e8edf1', patch1:'#cdd8de', patch2:'#dbe3e8', light:'#f6f9fb',
    dark:'#b9c8d1', tuft1:'#9fb4bf', tuft2:'#8aa1ad', pil:['#c3ccd3','#aab5be','#eef2f5'] },
  { name:'丛林草原', base:'#a9bc72', patch1:'#8fa45e', patch2:'#9cb068', light:'#bccd85',
    dark:'#7d9354', tuft1:'#5f7a40', tuft2:'#6f8a4a', pil:['#9aa089','#838974','#d6d9c8'] },
  { name:'熔岩焦土', base:'#5b504b', patch1:'#4a403c', patch2:'#534741', light:'#6b5e57',
    dark:'#3c3330', tuft1:'#7a3a26', tuft2:'#8f4527', pil:['#6e6660','#57504b','#8d847d'],
    accent:'#d8521e' },
  { name:'夜幕街区', base:'#8d9095', patch1:'#797c82', patch2:'#84878c', light:'#9da0a5',
    dark:'#6c6f74', tuft1:'#5d6065', tuft2:'#54575c', pil:['#a3a6ab','#8b8e93','#c8cbd0'] },
];
let mapIndex = 0;

function buildGround(){
  const m = MAPS[mapIndex];
  rngSeed = 7;
  gctx.fillStyle = m.base;                     // 地面底色
  gctx.fillRect(0, 0, WW, WH);
  // 大块硬地斑块
  for (let i = 0; i < 22; i++)
    blob(gctx, rnd()*WW, rnd()*WH, 90 + rnd()*190, rnd()<.5 ? m.patch1 : m.patch2, .9);
  for (let i = 0; i < 26; i++)                 // 浅色二层
    blob(gctx, rnd()*WW, rnd()*WH, 40 + rnd()*110, m.light, .7);
  for (let i = 0; i < 18; i++)                 // 深色小块
    blob(gctx, rnd()*WW, rnd()*WH, 24 + rnd()*60, m.dark, .5);
  if (m.accent)                                // 主题点缀（如熔岩裂隙）
    for (let i = 0; i < 12; i++)
      blob(gctx, rnd()*WW, rnd()*WH, 12 + rnd()*34, m.accent, .42);
  // 草丛刮痕
  for (let i = 0; i < 90; i++)
    tuft(gctx, rnd()*WW, rnd()*WH, 10 + rnd()*16, rnd()<.5 ? m.tuft1 : m.tuft2);
  // 细碎噪点
  for (let i = 0; i < 1600; i++){
    gctx.fillStyle = rnd()<.5 ? 'rgba(0,0,0,.05)' : 'rgba(255,255,255,.07)';
    gctx.fillRect(rnd()*WW, rnd()*WH, 2, 2);
  }
}
buildGround();

/* ---------- 血迹 / 焦痕 / 尸体：带寿命贴片（15 秒后淡出消失） ---------- */
const DECAL_LIFE = 15;        // 存活秒数
const decals = [];           // { cv,x,y,born } 或 { dot:true,x,y,r,born }
function decalCanvas(S){
  const cv = document.createElement('canvas');
  cv.width = cv.height = Math.ceil(S*2);
  return [cv, cv.getContext('2d')];
}
function pushDecal(d){
  decals.push(d);
  if (decals.length > 260) decals.shift();
}

// 鲜红泼溅状血迹（减量版）
function bloodSplat(x, y, size){
  const S = size*2.2 + 10;
  const [cv, c] = decalCanvas(S);
  const main = '#cf2318', dark = '#a81b12';
  c.globalAlpha = .78;
  for (let i = 0; i < 2; i++)
    blob(c, S + (Math.random()-.5)*size*.5, S + (Math.random()-.5)*size*.4,
         size*(.45 + Math.random()*.4), i ? main : dark, .85);
  for (let i = 0; i < 4 + size/6; i++){
    const a = Math.random()*Math.PI*2, d = size*(.6 + Math.random()*1.1);
    const r = 1.2 + Math.random()*2.2;
    c.fillStyle = main;
    c.beginPath();
    c.arc(S + Math.cos(a)*d, S + Math.sin(a)*d*.8, r, 0, 7);
    c.fill();
  }
  c.globalAlpha = 1;
  pushDecal({ cv, x, y, born: time });
}
function scorch(x, y, r){
  const S = r*1.3 + 6;
  const [cv, c] = decalCanvas(S);
  blob(c, S, S, r, '#6f675c', .45);
  blob(c, S, S, r*.6, '#4d463d', .4);
  pushDecal({ cv, x, y, born: time });
}

/* ========================================================
   游戏状态
   ======================================================== */
const WEAPONS = [
  { name:'手枪',   icon:'pistol',  rate:270, auto:false, unlock:1,  infinite:true,  give:0   },
  { name:'马格南', icon:'magnum',  rate:430, auto:false, unlock:3,  infinite:false, give:60  },
  { name:'乌兹',   icon:'uzi',     rate:85,  auto:true,  unlock:5,  infinite:false, give:150 },
  { name:'霰弹枪', icon:'shotgun', rate:620, auto:false, unlock:8,  infinite:false, give:40  },
  { name:'加特林', icon:'gatling', rate:55,  auto:true,  unlock:11, infinite:false, give:260 },
  { name:'手雷',   icon:'grenade', rate:520, auto:false, unlock:13, infinite:false, give:12  },
  { name:'油桶',   icon:'barrel',  rate:420, auto:false, unlock:15, infinite:false, give:6   },
  { name:'喷火器', icon:'flamer',  rate:50,  auto:true,  unlock:17, infinite:false, give:300 },
  { name:'火箭筒', icon:'rocket',  rate:750, auto:false, unlock:20, infinite:false, give:10  },
];
const WN = WEAPONS.length;

/* ---------- 难度档（玩家反馈「第六波打不过」：给出选择，而不是一刀切改死） ---------- */
const DIFFS = [
  { key:'easy',   name:'轻松', count:.75, hp:.8,  dmg:.7,  boss:.72,
    tip:'少一点敌人，扛得住一点' },
  { key:'normal', name:'标准', count:1,   hp:1,   dmg:1,   boss:1,
    tip:'重调过的默认曲线' },
  { key:'hard',   name:'硬核', count:1.3, hp:1.3, dmg:1.35, boss:1.45,
    tip:'给能打穿十波的人' },
];
const DIFF_KEY = 'zombie-world-difficulty';
let diffIndex = 1;
function DIF(){ return DIFFS[diffIndex]; }

/* ---------- 五级 Boss 体系 ---------- */
const BOSS_TYPES = [
  { name:'壮汉巨尸', scale:1.45, hp:w => 220 + w*60,  spd:48, melee:13, chain:1,
    sk:{ summon:1 },                                    eye:'#ff9d2e', vcol:'#aab6c2' },
  { name:'掠行猎尸', scale:1.5,  hp:w => 330 + w*75,  spd:66, melee:15, chain:2,
    sk:{ charge:1, spit:1 },                            eye:'#7ddb3c', vcol:'#3f6a35' },
  { name:'碎地暴尸', scale:1.7,  hp:w => 500 + w*90,  spd:44, melee:17, chain:1,
    sk:{ summon:1, charge:1, slam:1 },                  eye:'#ff3326', vcol:'#8e3a34' },
  { name:'灾祸巨像', scale:2.0,  hp:w => 800 + w*105, spd:38, melee:20, chain:1,
    sk:{ summon:1, charge:1, slam:1, barrage:1 },       eye:'#c06bff', vcol:'#5d3a7a' },
  { name:'僵尸博士', scale:2.5,  hp:w => 1150 + w*130, spd:42, melee:24, chain:3,
    sk:{ summon:1, charge:1, slam:1, barrage:1, pools:1, rage:1 },
    eye:'#39ff88', vcol:'#2f6a4a', doctor:true },
];
const SK_NAMES = { summon:'召唤', charge:'冲锋', spit:'毒吐', slam:'震地',
                   barrage:'弹幕', pools:'毒池', rage:'狂暴' };

let state = 'menu';
let controlMode = 'classic';   // 'classic' 键盘经典 | 'mouse' 鼠标点击移动
let player, zombies, devils, bosses, bullets, grenades, rockets, barrels, fireballs,
    particles, pickups, banners, hazards, cam;
let wave, spawnQueue, devilQueue, spawnTimer, waveRest, score, kills,
    streak, multiplier, bestMulti, comboTimer, decayTimer, shake, time, frameN;
let gameOverTimer = null;

/* ---------- 多人战局：房主权威，客端只发输入/收快照 ---------- */
const net = window.zombieNetwork;
const PLAYER_COLORS = ['#3f4652','#79d7ff','#ffcb55','#79e39f'];
let players = new Map();
let netMode = 'solo';          // solo | host | guest
let netInputs = new Map();
let localInputSeq = 0, localUltSeq = 0, localDesiredWeapon = null, lastInputSent = 0;
let snapshotTick = 0, lastSnapshotSent = 0;
let lastGuestSnapshotAt = 0;
let restoringSavedSession = false;

function makePlayer(member, slot){
  const spawns = [[-42,-42],[42,-42],[-42,42],[42,42]];
  const off = spawns[slot] || [0,0];
  return { id:member.id, name:member.name || ('玩家' + (slot+1)), slot,
             color:PLAYER_COLORS[slot % PLAYER_COLORS.length],
             x:WW/2+off[0], y:WH/2+off[1], r:13, hp:100, alive:true, fx:1, fy:0,
             walk: 0, moving: false, lastShot: 0, weapon: 0,
             target: null,
             ammo: WEAPONS.map((w,i) => i ? 0 : Infinity),
             unlocked: WEAPONS.map((w,i) => i === 0), inv: 0, flash: 0,
             ultCharge:1, ultT:0, ultKills:0, swing:0, slashT:0,
             lastUltSeq:0, inputAt:0 };
}

function allPlayers(){ return Array.from(players.values()); }
function livingPlayers(){ return allPlayers().filter(p => p.alive !== false && p.hp > 0); }
function nearestLivingPlayer(o){
  let best = null, bestD = Infinity;
  for (const p of livingPlayers()){
    const d = Math.hypot(p.x-o.x, p.y-o.y);
    if (d < bestD){ best = p; bestD = d; }
  }
  return best ? { player:best, distance:bestD } : null;
}
function multiplayerActive(){ return netMode !== 'solo'; }

function reset(roster){
  clearTimeout(gameOverTimer);
  gameOverTimer = null;
  const members = Array.isArray(roster) && roster.length
    ? roster.slice(0, 4)
    : [{ id:'local', name:'幸存者', slot:0 }];
  players = new Map();
  members.forEach((member, index) => {
    const slot = Number.isInteger(member.slot) ? member.slot : index;
    const p = makePlayer(member, slot);
    players.set(p.id, p);
  });
  const localId = netMode === 'solo' ? 'local' : net.selfId;
  player = players.get(localId) || players.values().next().value;
  netInputs = new Map();
  localInputSeq = 0; localUltSeq = 0; localDesiredWeapon = null; snapshotTick = 0;
  cam = { x: WW/2 - VW/2, y: WH/2 - VH/2 };
  zombies = []; devils = []; bosses = []; bullets = []; grenades = []; rockets = [];
  fireballs = []; particles = []; pickups = []; banners = []; hazards = [];
  barrels = BARREL_SPOTS.map(([x,y]) => ({ x, y, r: 11, hp: 1 }));
  wave = 0; spawnQueue = 0; devilQueue = 0; spawnTimer = 0; waveRest = 2.2;
  score = 0; kills = 0; streak = 0; multiplier = 1; bestMulti = 1;
  comboTimer = 0; decayTimer = 0; shake = 0; time = 0; frameN = 0;
  decals.length = 0;
}

function startWave(){
  const cleared = wave;
  wave++;
  // 波间补给：撑过一波就回一口血，避免前一波被磨掉的血一路带进下一波
  if (cleared > 0){
    const healed = livingPlayers().filter(p => p.hp < 100);
    for (const p of healed) p.hp = Math.min(100, p.hp + 20);
    if (healed.length) banners.push({ text:'波间补给', sub:'回复 20 生命', life:1.6, small:true });
  }
  for (const p of allPlayers()){
    if (p.alive === false || p.hp <= 0){
      const spawns = [[-42,-42],[42,-42],[-42,42],[42,42]];
      const off = spawns[p.slot] || [0,0];
      p.x = WW/2 + off[0]; p.y = WH/2 + off[1];
      p.hp = 60; p.alive = true; p.inv = 2;
      banners.push({ text:p.name + ' 重返战场', sub:'新波次复活 · 60 生命', life:1.8, small:true });
    }
  }
  const D = DIF();
  const partyScale = 1 + Math.max(0, livingPlayers().length - 1) * .55;
  spawnQueue = Math.ceil((6 + wave * 4) * partyScale * D.count);
  devilQueue = wave >= 4 ? Math.ceil((wave - 3) * 1.5 * partyScale * D.count) : 0;
  banners.push({ text: '第 ' + wave + ' 波', sub: '僵尸来袭！', life: 2.2, big: true });
  sfx('wave');
  // 每波一只 Boss：前五波五级递进；第 6 波起在前四级之间轮转、每逢 5 的倍数波博士回归。
  // 原来是 min(wave,5)-1，第 5 波之后永远是满技能僵尸博士，这正是第六波过不去的主因。
  const tier = wave <= 5 ? wave - 1 : (wave % 5 === 0 ? 4 : (wave - 1) % 5);
  const T = BOSS_TYPES[tier];
  const s = edgeSpawn();
  const bhp = Math.ceil(T.hp(wave) * (1 + Math.max(0, livingPlayers().length - 1) * .5) * D.boss);
  bosses.push({ x:s.x, y:s.y, r:12*T.scale + 4, hp:bhp, maxhp:bhp, boss:true, tier, T,
    walk:0, fx:0, fy:1, hit:0, atk:0,
    mode:'walk', t:0, dashx:0, dashy:0, dashN:0, rage:false,
    cool1: 4 + Math.random()*2,     // 召唤
    cool2: 3 + Math.random()*2,     // 冲锋
    cool3: 6,                       // 震地
    cool4: 5,                       // 毒吐/弹幕
    cool5: 8 });                    // 毒池
  setTimeout(() => AC && sfx('roar'), 500);
  const skills = Object.keys(T.sk).map(k => SK_NAMES[k]).join('/');
  banners.push({ text:'BOSS · ' + T.name, sub:'技能：' + skills, life:2.8 });
  if (T.doctor) banners.push({ text:'警告', sub:'巨大威胁逼近——僵尸博士驾到！', life:3, small:true });
}

/* ---------- 输入 ---------- */
const keys = {};
addEventListener('keydown', e => {
  audioInit();
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
  keys[e.key.toLowerCase()] = true;
  if (state === 'play'){
    if (e.key === 'q' || e.key === 'Q') cycleWeapon(-1);
    if (e.key === 'e' || e.key === 'E') cycleWeapon(1);
    if (e.key >= '1' && e.key <= '9') selectWeapon(+e.key - 1);
    if (e.key === 'r' || e.key === 'R') requestUlt();
    if ((e.key === 'p' || e.key === 'P' || e.key === 'Escape') && !multiplayerActive()) setScreen('pause');
  } else if (state === 'pause' && (e.key === 'p' || e.key === 'P' || e.key === 'Escape')){
    setScreen('play');
  }
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
// 滚轮切换武器
addEventListener('wheel', e => {
  if (state !== 'play') return;
  e.preventDefault();
  cycleWeapon(e.deltaY > 0 ? 1 : -1);
}, { passive:false });
function weaponReady(i){
  return i >= 0 && i < WN && player.unlocked[i] &&
         (WEAPONS[i].infinite || player.ammo[i] > 0);
}
// 指定某把枪（数字键 / 点武器栏）：拿不到就说清楚为什么，别默默没反应
function selectWeapon(i){
  if (i < 0 || i >= WN || !player) return false;
  if (!player.unlocked[i]){
    banners.push({ text:WEAPONS[i].name, sub:'连击 ×' + WEAPONS[i].unlock + ' 解锁', life:1.1, small:true });
    return false;
  }
  if (!WEAPONS[i].infinite && player.ammo[i] <= 0){
    banners.push({ text:WEAPONS[i].name, sub:'没弹药了', life:1.1, small:true });
    return false;
  }
  if (player.weapon !== i){
    player.weapon = i;
    if (netMode === 'guest') localDesiredWeapon = i;
    sfx('click');
    refreshSwapBtn();
  }
  return true;
}
// 循环切枪：跳过空弹匣的枪，免得按了半天都切到打不响的武器
function cycleWeapon(d){
  let i = player.weapon;
  for (let n = 0; n < WN; n++){
    i = (i + d + WN) % WN;
    if (weaponReady(i)){
      player.weapon = i;
      if (netMode === 'guest') localDesiredWeapon = i;
      sfx('click');
      refreshSwapBtn();
      return;
    }
  }
}

/* ---------- 触屏控制 ---------- */
const touchUI = document.getElementById('touchUI');
const stickL = document.getElementById('stickL'), nubL = document.getElementById('nubL');
const stickR = document.getElementById('stickR'), nubR = document.getElementById('nubR');
const ghostL = document.getElementById('ghostL'), ghostR = document.getElementById('ghostR');
const swapBtn = document.getElementById('swapBtn'), swapName = document.getElementById('swapName');
const ultBtn = document.getElementById('ultBtn');
const pauseBtn = document.getElementById('pauseBtn');
const touchGuide = document.getElementById('touchGuide');
let tMove = { id:null, ox:0, oy:0, vx:0, vy:0 }, tFire = { id:null, ox:0, oy:0, vx:0, vy:0 };

// 触屏按钮按画布实际位置摆放：既压不到底部武器栏，也不会掉进刘海/圆角里
function layoutTouchUI(){
  if (!isTouch || !swapBtn) return;
  const r = cvs.getBoundingClientRect();
  if (!r.width) return;
  const s = r.width / VW;
  const barTop = r.bottom - 58 * s;              // 画布底部武器栏的上沿
  const size = 66, gap = 8;
  const col = Math.round(Math.max(4, r.right - 10 - size));
  const ultTop = Math.round(Math.max(4, barTop - gap - size));
  ultBtn.style.left  = col + 'px'; ultBtn.style.top  = ultTop + 'px';
  swapBtn.style.left = col + 'px'; swapBtn.style.top = Math.round(Math.max(4, ultTop - gap - size)) + 'px';
  pauseBtn.style.left = Math.round(r.left + 8) + 'px';
  pauseBtn.style.top  = Math.round(r.top + 6) + 'px';
  // 摇杆虚位：左下走位区、右侧射击区（避开右边那一列按钮）
  ghostL.style.left = Math.round(r.left + 82) + 'px';
  ghostL.style.top  = Math.round(barTop - 80) + 'px';
  ghostR.style.left = Math.round(col - 76) + 'px';
  ghostR.style.top  = Math.round(barTop - 80) + 'px';
}
function placeStick(el, x, y){ el.style.left = (x-60)+'px'; el.style.top = (y-60)+'px'; el.style.display='block'; }
function placeNub(nub, vx, vy){
  const m = Math.min(1, Math.hypot(vx,vy)/50);
  const a = Math.atan2(vy, vx);
  nub.style.left = (34 + Math.cos(a)*34*m) + 'px';
  nub.style.top  = (34 + Math.sin(a)*34*m) + 'px';
}
function resetSticks(){
  tMove = { id:null, ox:0, oy:0, vx:0, vy:0 };
  tFire = { id:null, ox:0, oy:0, vx:0, vy:0 };
  stickL.style.display = 'none'; stickR.style.display = 'none';
  ghostL.classList.remove('fade'); ghostR.classList.remove('fade');
}
// 落在按钮/浮层上的手指不算摇杆——否则点「换枪」会顺手朝右上角打一梭子
function onUiElement(t){
  const el = t.target;
  return !!(el && el.closest && el.closest('button, .screen, #netHud, #rotate'));
}
function clientToCanvas(clientX, clientY){
  const r = cvs.getBoundingClientRect();
  if (!r.width || !r.height) return { x:-1, y:-1 };
  return { x:(clientX - r.left) / r.width * VW, y:(clientY - r.top) / r.height * VH };
}
// 底部武器栏的几何，画和点都用它，保证点到哪一格就是看到的那一格
function weaponBar(){
  const slotW = Math.floor((VW - 12) / WN);
  return { slotW, x0:(VW - slotW*WN) / 2, y0:VH - 50, h:42 };
}
function weaponSlotAt(px, py){
  const bar = weaponBar();
  if (py < bar.y0 - 8 || py > bar.y0 + bar.h + 8) return -1;
  const i = Math.floor((px - bar.x0) / bar.slotW);
  return (i >= 0 && i < WN) ? i : -1;
}
addEventListener('touchstart', e => {
  hideTouchGuide();
  if (state !== 'play') return;
  audioInit();
  for (const t of e.changedTouches){
    if (onUiElement(t)) continue;
    // 直接点底部武器栏换枪：比循环切一圈快，也是最好找的入口。
    // 换成功才吃掉这根手指；没换成（锁着 / 没弹药）就照常当摇杆用，别让人动不了
    const p = clientToCanvas(t.clientX, t.clientY);
    const slot = weaponSlotAt(p.x, p.y);
    if (slot >= 0 && selectWeapon(slot)) continue;
    if (t.clientX < innerWidth/2 && tMove.id === null){
      tMove = { id:t.identifier, ox:t.clientX, oy:t.clientY, vx:0, vy:0 };
      placeStick(stickL, t.clientX, t.clientY); placeNub(nubL,0,0);
      ghostL.classList.add('fade');
    } else if (t.clientX >= innerWidth/2 && tFire.id === null){
      tFire = { id:t.identifier, ox:t.clientX, oy:t.clientY, vx:0, vy:0 };
      placeStick(stickR, t.clientX, t.clientY); placeNub(nubR,0,0);
      ghostR.classList.add('fade');
    }
  }
}, { passive:true });
addEventListener('touchmove', e => {
  for (const t of e.changedTouches){
    if (t.identifier === tMove.id){
      tMove.vx = t.clientX - tMove.ox; tMove.vy = t.clientY - tMove.oy; placeNub(nubL, tMove.vx, tMove.vy);
    } else if (t.identifier === tFire.id){
      tFire.vx = t.clientX - tFire.ox; tFire.vy = t.clientY - tFire.oy; placeNub(nubR, tFire.vx, tFire.vy);
    }
  }
}, { passive:true });
function releaseTouches(e){
  for (const t of e.changedTouches){
    if (t.identifier === tMove.id){
      tMove = { id:null, ox:0, oy:0, vx:0, vy:0 };
      stickL.style.display = 'none'; ghostL.classList.remove('fade');
    }
    if (t.identifier === tFire.id){
      tFire = { id:null, ox:0, oy:0, vx:0, vy:0 };
      stickR.style.display = 'none'; ghostR.classList.remove('fade');
    }
  }
}
addEventListener('touchend', releaseTouches, { passive:true });
// touchcancel 以前没接：系统手势/来电打断触摸时摇杆会卡在按下状态，人物一直往一个方向跑
addEventListener('touchcancel', releaseTouches, { passive:true });
swapBtn.addEventListener('click', () => { if (state==='play') cycleWeapon(1); });
ultBtn.addEventListener('click', () => { if (state==='play') requestUlt(); });
pauseBtn.addEventListener('click', () => {
  if (multiplayerActive()) return;
  if (state === 'play') setScreen('pause');
  else if (state === 'pause') setScreen('play');
});
// 触屏无双按钮：随充能状态切换文案与配色（PC 仍用 canvas 内圆形按钮）
// 每帧都会调到，所以文案没变就不碰 DOM——低端机上这点写入也是要还的
let ultLabel = '', swapLabel = '';
function updateUltBtn(){
  const label = player.ultT > 0 ? Math.ceil(player.ultT) + 's'
              : (player.ultCharge > 0 ? '无双' : player.ultKills + '/50');
  const s = player.ultT > 0 ? 'active' : (player.ultCharge > 0 ? 'ready' : 'charge');
  if (label !== ultLabel){ ultLabel = label; ultBtn.textContent = label; }
  if (s !== ultBtn.dataset.s) ultBtn.dataset.s = s;
}
function refreshSwapBtn(){
  if (!isTouch || !player) return;
  const name = WEAPONS[player.weapon].name;
  if (name !== swapLabel){ swapLabel = name; swapName.textContent = name; }
}
/* ---------- 首次上手引导：反馈里问得最多的就是「手游怎么射击/怎么换武器」 ---------- */
let guideTimer = null, guideGen = 0;
function showTouchGuide(){
  if (!isTouch) return;
  clearTimeout(guideTimer);
  guideGen++;
  touchGuide.classList.remove('hidden', 'out');
  guideTimer = setTimeout(hideTouchGuide, 7000);
}
function hideTouchGuide(){
  clearTimeout(guideTimer); guideTimer = null;
  if (touchGuide.classList.contains('hidden') || touchGuide.classList.contains('out')) return;
  const gen = ++guideGen;                       // 淡出途中又开新局，别让旧的收尾把新的关掉
  touchGuide.classList.add('out');
  setTimeout(() => { if (gen === guideGen) touchGuide.classList.add('hidden'); }, 420);
}

/* ---------- 鼠标控制（点击移动 + 长按持续跟随） ---------- */
const mouse = { sx: VW/2, sy: VH/2, has: false, down: false, rdown: false };
function toCanvas(e){ return clientToCanvas(e.clientX, e.clientY); }
function mouseWorldTarget(){
  return { x: Math.max(16, Math.min(WW-16, mouse.sx + cam.x)),
           y: Math.max(16, Math.min(WH-16, mouse.sy + cam.y)), age: 0 };
}
cvs.addEventListener('mousemove', e => {
  const p = toCanvas(e);
  mouse.sx = p.x; mouse.sy = p.y; mouse.has = true;
});
cvs.addEventListener('mousedown', e => {
  if (state !== 'play') return;
  audioInit();
  const p = toCanvas(e);
  // 点击右下角大招按钮：两种操作模式都生效
  if (e.button === 0 && Math.hypot(p.x - ULT_BTN.x, p.y - ULT_BTN.y) < ULT_BTN.r + 4){
    requestUlt(); return;
  }
  if (controlMode !== 'mouse') return;
  mouse.sx = p.x; mouse.sy = p.y; mouse.has = true;
  if (e.button === 0){
    mouse.down = true;                     // 左键：点击/按住攻击
  } else if (e.button === 2){
    mouse.rdown = true;                    // 右键：点击/按住移动
    player.target = mouseWorldTarget();
  }
});
addEventListener('mouseup', e => {
  if (e.button === 0) mouse.down = false;
  if (e.button === 2) mouse.rdown = false;
});
cvs.addEventListener('mouseleave', () => { mouse.down = false; mouse.rdown = false; });
cvs.addEventListener('contextmenu', e => e.preventDefault());

/* ---------- 碰撞（世界边界 + 石柱圆形体 + 油桶） ---------- */
function collide(o){
  o.x = Math.max(o.r, Math.min(WW - o.r, o.x));
  o.y = Math.max(o.r, Math.min(WH - o.r, o.y));
  for (const p of pillars){
    const dx = o.x - p.x, dy = o.y - p.y;
    const min = o.r + p.r, d2 = dx*dx + dy*dy;
    if (d2 < min*min && d2 > 0){
      const d = Math.sqrt(d2);
      o.x = p.x + dx/d*min; o.y = p.y + dy/d*min;
    }
  }
  for (const b of barrels){
    if (b.hp <= 0) continue;
    const dx = o.x - b.x, dy = o.y - b.y;
    const min = o.r + b.r, d2 = dx*dx + dy*dy;
    if (d2 < min*min && d2 > 0){
      const d = Math.sqrt(d2);
      o.x = b.x + dx/d*min; o.y = b.y + dy/d*min;
    }
  }
}
function hitPillar(x, y, r){
  if (x < 0 || y < 0 || x > WW || y > WH) return true;
  for (const p of pillars){
    const dx = x - p.x, dy = y - p.y;
    if (dx*dx + dy*dy < (p.r + (r||0)) * (p.r + (r||0))) return true;
  }
  return false;
}
function losBlocked(x0, y0, x1, y1){
  const steps = Math.ceil(Math.hypot(x1-x0, y1-y0) / 18);
  for (let i = 1; i < steps; i++){
    if (hitPillar(x0 + (x1-x0)*i/steps, y0 + (y1-y0)*i/steps, 0)) return true;
  }
  return false;
}

/* ---------- 敌人生成（从世界四周边缘进场） ---------- */
function edgeSpawn(){
  const side = (Math.random()*4)|0;
  const m = 26;
  if (side === 0) return { x: Math.random()*WW, y: m };
  if (side === 1) return { x: Math.random()*WW, y: WH-m };
  if (side === 2) return { x: m, y: Math.random()*WH };
  return { x: WW-m, y: Math.random()*WH };
}
// 僵尸/恶魔工厂：刷怪与 Boss 召唤共用一份字段，免得两处各写一半
// （stuck / side / chk 是绕障用的，漏了就退化成原来那种「顶着石柱推一辈子」）
function makeZombie(x, y, elite){
  const hp = Math.ceil((26 + wave*3) * (elite ? 1.25 : 1) * DIF().hp);
  return { x, y, r:12, hp, maxhp:hp,
    walk:0, spd:(46 + wave*1.5) * (0.85 + Math.random()*0.35) * (elite ? 1.3 : 1),
    atk:0, fx:0, fy:1, hit:0, wob:Math.random()*6.28,
    chk:.5 + Math.random()*.5, stuck:0, side:Math.random() < .5 ? 1 : -1 };
}
function makeDevil(x, y){
  const hp = Math.ceil((60 + wave*4) * DIF().hp);
  return { x, y, r:13, hp, maxhp:hp, walk:0, cool:1.5+Math.random(), fx:0, fy:1, hit:0 };
}
function spawnEnemy(){
  const s = edgeSpawn();
  if (devilQueue > 0 && Math.random() < 0.28){
    devilQueue--;
    devils.push(makeDevil(s.x, s.y));
  } else if (spawnQueue > 0){
    spawnQueue--;
    zombies.push(makeZombie(s.x, s.y, false));
    if (Math.random() < .3) sfx('groan');
  }
}

/* ---------- 粒子 / 射击 / 爆炸 ---------- */
function blood(x, y, n, big){
  if (isPhone()) n = Math.ceil(n * .5);          // 手机降低粒子量，缓解低端机卡顿
  for (let i = 0; i < n; i++){
    const a = Math.random()*6.28, s = 40 + Math.random()*(big?220:120);
    particles.push({ x, y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, life:.3+Math.random()*.35,
      max:.6, size:big?4:3, color:'#cf2318', decal:true });
  }
}
function sparks(x, y, n, color){
  if (isPhone()) n = Math.ceil(n * .5);          // 手机降低粒子量
  for (let i = 0; i < n; i++){
    const a = Math.random()*6.28, s = 60 + Math.random()*200;
    particles.push({ x, y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, life:.15+Math.random()*.25,
      max:.4, size:2, color:color||'#ffd23e' });
  }
}
function fireBullet(p, dmg, spread, speed, len, extra){
  const a = Math.atan2(p.fy, p.fx) + (Math.random()-0.5)*spread;
  bullets.push(Object.assign({ x:p.x+Math.cos(a)*18, y:p.y+Math.sin(a)*18-6,
    vx:Math.cos(a)*speed, vy:Math.sin(a)*speed, dmg, life:.9, len:len||14,
    ownerId:p.id }, extra||{}));
}
function shoot(p, now){
  const w = WEAPONS[p.weapon];
  const localFeedback = p === player;
  if (now - p.lastShot < w.rate) return;
  if (!w.infinite && p.ammo[p.weapon] <= 0){
    p.weapon = 0;
    if (localFeedback) sfx('click');
    return;
  }
  p.lastShot = now;
  if (!w.infinite) p.ammo[p.weapon]--;
  p.flash = .07;
  const fx = p.fx, fy = p.fy;
  switch (w.icon){
    case 'pistol':
      fireBullet(p, 14, .05, 720);
      if (localFeedback){ sfx('pistol'); shake = Math.max(shake,2.4); }
      break;
    case 'magnum':                                          // 高伤穿透
      fireBullet(p, 34, .02, 880, 20, { pierce: 2 });
      if (localFeedback){ sfx('pistol'); sfx('splat'); shake = Math.max(shake,4.2); }
      p.x -= fx*3; p.y -= fy*3; collide(p);
      break;
    case 'uzi':
      fireBullet(p, 8, .14, 780);
      if (localFeedback){ sfx('uzi'); shake = Math.max(shake,1.8); }
      break;
    case 'gatling':                                         // 超高射速弹幕
      fireBullet(p, 7, .17, 820);
      if (localFeedback && frameN % 2 === 0) sfx('uzi');
      if (localFeedback) shake = Math.max(shake,1.6);
      break;
    case 'shotgun':
      for (let i = 0; i < 7; i++) fireBullet(p, 9, .42, 640+Math.random()*120, 10);
      if (localFeedback){ sfx('shotgun'); shake = Math.max(shake,6); }
      p.x -= fx*5; p.y -= fy*5; collide(p);
      break;
    case 'flamer':                                          // 近距火舌
      fireBullet(p, 7, .3, 230+Math.random()*80, 6, { flame:true, life:.45, max:.45 });
      if (localFeedback && frameN % 5 === 0) sfx('fire');
      break;
    case 'grenade':
      grenades.push({ x:p.x, y:p.y, vx:fx*300, vy:fy*300, t:1.1, r:5, ownerId:p.id });
      if (localFeedback) sfx('fire'); break;
    case 'barrel': {
      const bx = p.x + fx*36, by = p.y + fy*36;
      if (!hitPillar(bx, by, 11)) barrels.push({ x:bx, y:by, r:11, hp:1, ownerId:p.id });
      else p.ammo[p.weapon]++;
      if (localFeedback) sfx('click'); break;
    }
    case 'rocket':
      rockets.push({ x:p.x+fx*16, y:p.y+fy*16, vx:fx*520, vy:fy*520, r:6, life:2.2,
        ownerId:p.id });
      if (localFeedback){ sfx('rocket'); shake = Math.max(shake,4.5); }
      p.x -= fx*7; p.y -= fy*7; collide(p);
      break;
  }
}
function explode(x, y, radius, dmg, ownerId){
  sfx('boom'); shake = Math.max(shake, 14);
  scorch(x, y, radius*.7);
  for (let i = 0, n = isPhone() ? 22 : 40; i < n; i++){
    const a = Math.random()*6.28, s = 60+Math.random()*340;
    particles.push({ x, y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, life:.25+Math.random()*.4, max:.6,
      size:3+Math.random()*5, color:['#ffd23e','#ff8c2e','#e03c31','#5a5650'][(Math.random()*4)|0] });
  }
  particles.push({ x, y, ring:true, life:.32, max:.32, size:radius });
  const hurtList = list => {
    for (const z of list){
      if (z.hp <= 0) continue;
      const d = Math.hypot(z.x-x, z.y-y);
      if (d < radius + z.r){
        z.hp -= dmg * (1 - d/(radius+z.r)*0.6);
        if (ownerId) z.lastHitBy = ownerId;
        z.hit = .15;
        const k = 220/(d+24);
        z.x += (z.x-x)*k*.18; z.y += (z.y-y)*k*.18;
      }
    }
  };
  hurtList(zombies); hurtList(devils); hurtList(bosses);
  for (const p of livingPlayers()){
    if (ownerId && p.id !== ownerId) continue;             // 合作模式关闭爆炸友伤
    const pd = Math.hypot(p.x-x, p.y-y);
    if (pd < radius && p.inv <= 0) damagePlayer(Math.round(dmg*.3*(1-pd/radius)), p);
  }
  for (const b of barrels){
    if (b.hp > 0 && b.fuse === undefined && Math.hypot(b.x-x, b.y-y) < radius + 16){
      if (!b.ownerId && ownerId) b.ownerId = ownerId;
      b.fuse = .18;
    }
  }
}

/* ---------- 受伤 / 连击 / 结算 ---------- */
function damagePlayer(d, target){
  const p = target || player;
  if (!p || d <= 0 || p.inv > 0 || p.alive === false || state !== 'play') return;
  d = Math.max(1, Math.round(d * DIF().dmg));      // 难度只在这一处收口，避免各处改漏
  p.hp -= d; p.inv = .7; sfx('hurt');
  if (p === player) shake = Math.max(shake, 9);
  streak = Math.floor(streak/2); updateMulti();
  blood(p.x, p.y, 8);
  if (p.hp <= 0){
    p.hp = 0; p.alive = false;
    p.target = null; p.moving = false;
    p.ultT = 0; p.slashT = 0; p.swing = 0;
    bloodSplat(p.x, p.y, 22);
    banners.push({ text:p.name + ' 倒下了', sub:'队友撑过本波即可复活', life:2.2, small:true });
    if (livingPlayers().length === 0) gameOver();
  }
}
function updateMulti(){
  multiplier = Math.min(99, 1 + Math.floor(streak/2));
  bestMulti = Math.max(bestMulti, multiplier);
  for (let i = 0; i < WN; i++){
    const newlyUnlocked = allPlayers().filter(p => !p.unlocked[i] && multiplier >= WEAPONS[i].unlock);
    if (newlyUnlocked.length){
      for (const p of newlyUnlocked){
        p.unlocked[i] = true;
        p.ammo[i] += WEAPONS[i].give;
        p.weapon = i;
      }
      banners.push({ text:'解锁新武器', sub:WEAPONS[i].name + '！', life:2.4 });
      sfx('unlock');
    }
  }
}
function killReward(x, y, baseScore, ownerId){
  kills++; streak++; comboTimer = 9; updateMulti();
  score += baseScore * multiplier;
  // 大招充能：用掉之后每击杀 50 个重新就绪
  const killer = players.get(ownerId);
  if (killer && killer.ultCharge <= 0){
    killer.ultKills++;
    if (killer.ultKills >= 50){
      killer.ultKills = 0; killer.ultCharge = 1;
      banners.push({ text:killer.name + ' 大招就绪', sub:'按 R 或点击右下角发动无双', life:2.2 });
      sfx('unlock');
    }
  }
  // 掉落：残血时更容易掉医疗箱，别在最需要血的时候连着爆一地弹药
  if (Math.random() < .15){
    const healOdds = killer && killer.hp < 55 ? .72 : .5;
    pickups.push({ x, y, type: Math.random() < healOdds ? 'heal' : 'ammo', life:12 });
  }
}
/* ---------- 无双大招：双刀乱舞 + 吸血 ---------- */
function requestUlt(){
  localUltSeq++;
  if (netMode !== 'guest') activateUlt(player);
}
function activateUlt(target){
  const p = target || player;
  if (!p || state !== 'play' || p.alive === false || p.ultCharge <= 0 || p.ultT > 0) return;
  p.ultCharge--;
  p.ultT = 15; p.swing = 0; p.slashT = 0;
  banners.push({ text:p.name + ' · 无双时刻！', sub:'双刀乱舞 · 击中吸血 · 持续 15 秒', life:2.4, big:true });
  sfx('unlock'); sfx('wave');
  if (p === player) shake = Math.max(shake, 8);
}
function gameOver(){
  if (state === 'dying' || state === 'over') return;
  sfx('boom');
  for (const p of allPlayers()){
    bloodSplat(p.x, p.y, 26);
    blood(p.x, p.y, 18, true);
  }
  document.getElementById('finalStats').innerHTML =
    '队伍人数<em>' + allPlayers().length + '</em>&nbsp;&nbsp;坚守波数<em>' + wave + '</em><br>' +
    '击杀数<em>' + kills + '</em>&nbsp;&nbsp;' +
    '最高连击<em>×' + bestMulti + '</em>&nbsp;&nbsp;最终得分<em>' + score.toLocaleString() + '</em>';
  const retry = document.getElementById('btnRetry');
  retry.disabled = netMode === 'guest';
  retry.textContent = netMode === 'host' ? '返回房间再战' :
    (netMode === 'guest' ? '等待房主重开' : '重新开始');
  state = 'dying';
  if (netMode === 'host'){
    lastSnapshotSent = performance.now();
    net.sendSnapshot({ tick:++snapshotTick, simTime:time, state:buildNetworkState() });
  }
  const modeAtDeath = netMode;
  gameOverTimer = setTimeout(() => {
    gameOverTimer = null;
    if (state === 'dying' && netMode === modeAtDeath) setScreen('over');
  }, 900);
}

function collectLocalInput(dt){
  if (!player || player.alive === false || player.hp <= 0){
    if (player) player.target = null;
    return {
      seq:++localInputSeq, mx:0, my:0,
      ax:player ? player.fx : 1, ay:player ? player.fy : 0,
      fire:false,
      weapon:localDesiredWeapon ?? (player ? player.weapon : 0),
      ultSeq:localUltSeq
    };
  }
  let mx = 0, my = 0;
  if (keys['w'] || keys['arrowup']) my -= 1;
  if (keys['s'] || keys['arrowdown']) my += 1;
  if (keys['a'] || keys['arrowleft']) mx -= 1;
  if (keys['d'] || keys['arrowright']) mx += 1;
  if (tMove.id !== null && Math.hypot(tMove.vx, tMove.vy) > 10){
    mx = tMove.vx; my = tMove.vy;
  }
  let ml = Math.hypot(mx, my);
  if (controlMode === 'mouse'){
    if (mouse.rdown && mouse.has && ml === 0) player.target = mouseWorldTarget();
    if (ml > 0) player.target = null;
    else if (player.target){
      player.target.age += dt;
      const dx = player.target.x - player.x, dy = player.target.y - player.y;
      const d = Math.hypot(dx, dy);
      if (d < 5) player.target = null;
      else { mx = dx; my = dy; ml = d; }
    }
  }
  if (ml > 0){ mx /= ml; my /= ml; }

  let ax = player.fx, ay = player.fy;
  if (controlMode !== 'mouse' && ml > 0){ ax = mx; ay = my; }
  if (controlMode === 'mouse' && mouse.has){
    const dx = (mouse.sx + cam.x) - player.x, dy = (mouse.sy + cam.y) - player.y;
    const d = Math.hypot(dx, dy);
    if (d > 4){ ax = dx/d; ay = dy/d; }
  }
  let firing = !!(keys[' '] || keys['j']);
  if (controlMode === 'mouse' && mouse.down) firing = true;
  // 触屏：按住右半边就开火（照当前朝向打），拖动才决定瞄准方向。
  // 以前必须先拖够 14px 才会射，轻点没反应——「手游怎么射击」问的就是这个。
  if (tFire.id !== null){
    const d = Math.hypot(tFire.vx, tFire.vy);
    if (d > 14){ ax = tFire.vx/d; ay = tFire.vy/d; }
    firing = true;
  }
  return { seq:++localInputSeq, mx, my, ax, ay, fire:firing,
    weapon:localDesiredWeapon ?? player.weapon, ultSeq:localUltSeq };
}

function updatePlayerFromInput(p, input, dt, now){
  if (!p) return;
  const data = input || {};
  if (Number.isSafeInteger(data.seq) && data.seq >= 0) p.inputAt = data.seq;
  const ultSeq = Number(data.ultSeq) || 0;
  const shouldActivateUlt = ultSeq > p.lastUltSeq;
  if (shouldActivateUlt) p.lastUltSeq = ultSeq;
  if (p.alive === false || p.hp <= 0) return;
  let mx = Number(data.mx) || 0, my = Number(data.my) || 0;
  const ml = Math.hypot(mx, my);
  if (ml > 1){ mx /= ml; my /= ml; }
  const al = Math.hypot(Number(data.ax)||0, Number(data.ay)||0);
  if (al > .01){
    p.fx = Number(data.ax)/al; p.fy = Number(data.ay)/al;
  }
  const requestedWeapon = Number(data.weapon);
  if (Number.isInteger(requestedWeapon) && requestedWeapon >= 0 &&
      requestedWeapon < WN && p.unlocked[requestedWeapon]) p.weapon = requestedWeapon;
  if (shouldActivateUlt) activateUlt(p);

  p.moving = Math.hypot(mx,my) > .01;
  const spd = p.ultT > 0 ? 232 : 190;
  if (p.moving){
    const ox = p.x, oy = p.y;
    p.x += mx * spd * dt; p.y += my * spd * dt;
    p.walk += dt * 11;
    collide(p);
    if (p === player && controlMode === 'mouse' && p.target &&
        Math.hypot(p.x-ox, p.y-oy) < spd*dt*.15 && p.target.age > .25) p.target = null;
  }

  if (p.ultT > 0){
    p.ultT -= dt;
    p.swing += dt * 18;
    p.slashT -= dt;
    if (p.slashT <= 0){
      p.slashT = .13;
      const R = 64;
      let hits = 0;
      const slashList = list => {
        for (const z of list){
          const d = Math.hypot(z.x-p.x, z.y-p.y);
          if (z.hp > 0 && d < R + z.r){
            z.hp -= 26; z.hit = .12; z.lastHitBy = p.id; hits++;
            let k = (R + z.r - d) * .25 + 6;
            if (z.boss) k *= .25;
            z.x += (z.x-p.x)/(d||1)*k;
            z.y += (z.y-p.y)/(d||1)*k;
            blood(z.x, z.y, 2);
          }
        }
      };
      slashList(zombies); slashList(devils); slashList(bosses);
      if (hits > 0){
        p.hp = Math.min(100, p.hp + hits*2);
        sfx('splat'); shake = Math.max(shake, 3);
        particles.push({ x:p.x, y:p.y, ring:true, life:.18, max:.18, size:R });
      }
    }
  } else if (data.fire){
    shoot(p, now);
  }
}

/* ========================================================
   主更新
   ======================================================== */
function update(dt, now){
  time += dt; frameN++;
  for (const p of allPlayers()){
    if (p.inv > 0) p.inv -= dt;
    if (p.flash > 0) p.flash -= dt;
  }
  if (shake > 0) shake = Math.max(0, shake - dt*30);

  if (comboTimer > 0) comboTimer -= dt;
  else if (streak > 0){                          // 基于时间衰减，不再随屏幕刷新率变化
    decayTimer += dt;
    if (decayTimer >= .5){ decayTimer = 0; streak--; multiplier = Math.min(99, 1+Math.floor(streak/2)); }
  }

  if (spawnQueue <= 0 && devilQueue <= 0 && zombies.length === 0 && devils.length === 0 && bosses.length === 0){
    waveRest -= dt;
    if (waveRest <= 0){ startWave(); waveRest = 3; }
  } else {
    spawnTimer -= dt;
    if (spawnTimer <= 0 && zombies.length + devils.length < 42){
      spawnEnemy();
      spawnTimer = Math.max(.12, .55 - wave*.02);
    }
  }

  // ----- 玩家 -----
  const localInput = collectLocalInput(dt);
  updatePlayerFromInput(player, localInput, dt, now);
  if (netMode === 'host'){
    for (const p of allPlayers()){
      if (p === player) continue;
      const input = netInputs.get(p.id);
      const safe = input && now - input.receivedAt <= 600
        ? input
        : { mx:0, my:0, ax:p.fx, ay:p.fy, fire:false, weapon:p.weapon, ultSeq:p.lastUltSeq };
      updatePlayerFromInput(p, safe, dt, now);
    }
  }

  // 镜头平滑跟随
  const focus = player.alive !== false ? player : (livingPlayers()[0] || player);
  const tx = focus.x - VW/2, ty = focus.y - VH/2;
  cam.x += (tx - cam.x) * Math.min(1, dt*7);
  cam.y += (ty - cam.y) * Math.min(1, dt*7);
  cam.x = Math.max(0, Math.min(WW-VW, cam.x));
  cam.y = Math.max(0, Math.min(WH-VH, cam.y));

  // ----- 子弹 -----
  for (let i = bullets.length-1; i >= 0; i--){
    const b = bullets[i];
    b.x += b.vx*dt; b.y += b.vy*dt; b.life -= dt;
    let dead = b.life <= 0;
    if (hitPillar(b.x, b.y, 0)){ dead = true; sparks(b.x, b.y, 4, '#d8d2c2'); }
    if (!dead){
      // 命中判定：僵尸/恶魔/Boss 三类共用一段逻辑（僵尸额外被击退，Boss 判定半径略大）
      const tryHit = (list, pad, knock) => {
        for (const z of list){
          if (z.hp > 0 && Math.hypot(z.x-b.x, z.y-b.y) < z.r+pad){
            z.hp -= b.dmg; z.hit = .12; z.lastHitBy = b.ownerId;
            blood(b.x, b.y, b.flame ? 1 : 3);
            if (!b.flame || frameN % 3 === 0) sfx('splat');
            if (knock){ z.x += b.vx*dt*1.6; z.y += b.vy*dt*1.6; }
            if (b.pierce && b.pierce > 1) b.pierce--;   // 马格南穿透：不消失，继续往后判定
            else dead = true;
            return;
          }
        }
      };
      tryHit(zombies, 4, true);
      if (!dead) tryHit(devils, 4, false);
      if (!dead) tryHit(bosses, 5, false);
      if (!dead) for (const bl of barrels){
        if (bl.hp > 0 && Math.hypot(bl.x-b.x, bl.y-b.y) < bl.r+5){
          if (!bl.ownerId && b.ownerId) bl.ownerId = b.ownerId;
          bl.fuse = bl.fuse ?? 0.01; dead = true; break;
        }
      }
    }
    if (dead) bullets.splice(i, 1);
  }

  // ----- 手雷 -----
  for (let i = grenades.length-1; i >= 0; i--){
    const g = grenades[i];
    g.x += g.vx*dt; g.y += g.vy*dt;
    g.vx *= (1 - 2.2*dt); g.vy *= (1 - 2.2*dt);
    collide(g);
    g.t -= dt;
    if (g.t <= 0){ explode(g.x, g.y, 88, 85, g.ownerId); grenades.splice(i, 1); }
  }

  // ----- 火箭弹 -----
  for (let i = rockets.length-1; i >= 0; i--){
    const r = rockets[i];
    r.x += r.vx*dt; r.y += r.vy*dt; r.life -= dt;
    particles.push({ x:r.x, y:r.y, vx:(Math.random()-.5)*30, vy:(Math.random()-.5)*30,
      life:.25, max:.25, size:3.5, color:'#9a948a' });
    let hit = r.life <= 0 || hitPillar(r.x, r.y, 4);
    if (!hit){
      for (const list of [zombies, devils, bosses]){     // 直接遍历三个列表，免去每帧 concat 新数组
        for (const z of list){
          if (z.hp > 0 && Math.hypot(z.x-r.x, z.y-r.y) < z.r+6){ hit = true; break; }
        }
        if (hit) break;
      }
    }
    if (hit){ explode(r.x, r.y, 110, 130, r.ownerId); rockets.splice(i, 1); }
  }

  // ----- 油桶引信 -----
  for (let i = barrels.length-1; i >= 0; i--){
    const b = barrels[i];
    if (b.fuse !== undefined){
      b.fuse -= dt;
      if (b.fuse <= 0){ barrels.splice(i,1); explode(b.x, b.y, 100, 110, b.ownerId); }
    }
  }

  // ----- 僵尸 -----
  for (let i = zombies.length-1; i >= 0; i--){
    const z = zombies[i];
    if (z.hit > 0) z.hit -= dt;
    if (z.hp <= 0){
      bloodSplat(z.x, z.y, 13 + Math.random()*8);
      drawCorpse(z.x, z.y);
      blood(z.x, z.y, 5, true);
      killReward(z.x, z.y, 10, z.lastHitBy);
      zombies.splice(i, 1); continue;
    }
    const targetInfo = nearestLivingPlayer(z);
    if (!targetInfo) continue;
    const target = targetInfo.player;
    const dx = target.x - z.x, dy = target.y - z.y, d = targetInfo.distance||1;
    z.wob += dt*3;
    // 卡住检测：每 0.5 秒看一次距离有没有真的拉近（比每帧射线便宜得多）
    z.chk -= dt;
    if (z.chk <= 0){
      z.chk = .5;
      if (z.lastD !== undefined && z.lastD - d < 8){
        z.stuck++;
        if (z.stuck >= 4){ z.side = -z.side; z.stuck = 1; }   // 绕反了就换个方向
      } else z.stuck = 0;
      z.lastD = d;
    }
    let sx = dx/d + Math.cos(z.wob)*.25;
    let sy = dy/d + Math.sin(z.wob)*.25;
    if (z.stuck > 0){
      // 被石柱/油桶/同伴卡住就切向绕行。原来只会直冲，站到柱子后面就能无限安全收割
      const k = Math.min(1.15, z.stuck * .45);
      sx += -dy/d * z.side * k; sy += dx/d * z.side * k;
      // 卡久了就砸挡路的油桶：围墙会自己炸开，堆桶挡门不再是永久解
      if (z.stuck >= 2){
        for (const bl of barrels){
          if (bl.hp > 0 && bl.fuse === undefined &&
              Math.hypot(bl.x - z.x, bl.y - z.y) < bl.r + z.r + 6){
            bl.fuse = .4; sfx('click'); break;
          }
        }
      }
    }
    const sl = Math.hypot(sx, sy)||1;
    z.x += sx/sl * z.spd * dt; z.y += sy/sl * z.spd * dt;
    z.fx = sx/sl; z.fy = sy/sl; z.walk += dt*8;
    collide(z);
    for (let j = i+1; j < zombies.length; j++){
      const o = zombies[j];
      const ddx = z.x-o.x, ddy = z.y-o.y, dd = Math.hypot(ddx,ddy);
      if (dd > 0 && dd < z.r+o.r){
        const push = (z.r+o.r-dd)/2;
        z.x += ddx/dd*push; z.y += ddy/dd*push;
        o.x -= ddx/dd*push; o.y -= ddy/dd*push;
      }
    }
    if (z.atk > 0) z.atk -= dt;
    if (d < z.r + target.r + 3 && z.atk <= 0){
      z.atk = .85; damagePlayer(7 + Math.floor(wave/4), target);
    }
  }

  // ----- 红恶魔 -----
  for (let i = devils.length-1; i >= 0; i--){
    const v = devils[i];
    if (v.hit > 0) v.hit -= dt;
    if (v.hp <= 0){
      scorch(v.x, v.y, 18);
      bloodSplat(v.x, v.y, 11);
      sparks(v.x, v.y, 16, '#ff5a3c'); sfx('groan');
      killReward(v.x, v.y, 40, v.lastHitBy);
      devils.splice(i, 1); continue;
    }
    const targetInfo = nearestLivingPlayer(v);
    if (!targetInfo) continue;
    const target = targetInfo.player;
    const dx = target.x - v.x, dy = target.y - v.y, d = targetInfo.distance||1;
    let sx = dx/d, sy = dy/d;
    if (d < 230){
      const t = Math.sin(time*1.3 + i)>0 ? 1 : -1;
      sx = -dy/d*t*.8 - dx/d*.2; sy = dx/d*t*.8 - dy/d*.2;
    }
    v.x += sx*54*dt; v.y += sy*54*dt;
    v.fx = dx/d; v.fy = dy/d; v.walk += dt*7;
    collide(v);
    v.cool -= dt;
    if (v.cool <= 0 && d < 440 && !losBlocked(v.x, v.y, target.x, target.y)){
      v.cool = 1.9 + Math.random()*.8;
      fireballs.push({ x:v.x+v.fx*14, y:v.y+v.fy*14, vx:dx/d*240, vy:dy/d*240,
        r:6, life:2.6, targetId:target.id });
      sfx('fire');
    }
  }

  // ----- Boss：五级技能体系 -----
  for (let i = bosses.length-1; i >= 0; i--){
    const b = bosses[i];
    const T = b.T, S = T.sk;
    const spdMul = b.rage ? 1.5 : 1, cdMul = b.rage ? .55 : 1;
    if (b.hit > 0) b.hit -= dt;
    if (b.atk > 0) b.atk -= dt;
    if (b.hp <= 0){
      bloodSplat(b.x, b.y, 16 + T.scale*6);
      drawCorpse(b.x, b.y, T.scale);
      blood(b.x, b.y, 10, true);
      scorch(b.x, b.y, 14 + T.scale*6);
      killReward(b.x, b.y, 120 + b.tier*80, b.lastHitBy);
      pickups.push({ x:b.x-18, y:b.y, type:'heal', life:14 });   // 必掉补给
      pickups.push({ x:b.x+18, y:b.y, type:'ammo', life:14 });
      if (T.doctor){
        pickups.push({ x:b.x, y:b.y-20, type:'heal', life:14 });
        pickups.push({ x:b.x, y:b.y+20, type:'ammo', life:14 });
      }
      banners.push({ text:T.name + ' 击破！', sub:'+' + (120+b.tier*80) + '×' + multiplier + ' 分', life:2 });
      sfx('roar'); shake = Math.max(shake, 12);
      bosses.splice(i, 1); continue;
    }
    // 狂暴：僵尸博士残血觉醒
    if (S.rage && !b.rage && b.hp < b.maxhp*.35){
      b.rage = true;
      banners.push({ text:'僵尸博士狂暴了！', sub:'移速暴增 · 技能冷却减半', life:2.4, big:true });
      sfx('roar'); shake = Math.max(shake, 14);
    }
    let target = players.get(b.targetId);
    if (b.mode === 'walk' || !target || target.alive === false){
      const info = nearestLivingPlayer(b);
      if (!info) continue;
      target = info.player; b.targetId = target.id;
    }
    const dx = target.x - b.x, dy = target.y - b.y, d = Math.hypot(dx, dy)||1;
    b.fx = dx/d; b.fy = dy/d;
    if (b.mode === 'walk'){
      b.x += dx/d * T.spd * spdMul * dt; b.y += dy/d * T.spd * spdMul * dt;
      b.walk += dt * 6 * spdMul;
      collide(b);
      b.cool1 -= dt; b.cool2 -= dt; b.cool3 -= dt; b.cool4 -= dt; b.cool5 -= dt;
      // 召唤增援（博士召唤精英）。带场上数量上限：不然留着 Boss 不打就是一台
      // 永动刷怪机，可以躲在角落无限刷连击和分数。
      if (S.summon && b.cool1 <= 0 && zombies.length < 26){
        b.cool1 = (8 + Math.random()*3) * cdMul;
        const n = Math.min(3 + b.tier + (b.rage ? 2 : 0), 26 - zombies.length);
        for (let k = 0; k < n; k++){
          const a = k/n * 6.283;
          zombies.push(makeZombie(b.x + Math.cos(a)*46, b.y + Math.sin(a)*46, !!T.doctor));
        }
        if (b.tier >= 3 && devils.length < 12){
          const s2 = edgeSpawn();
          devils.push(makeDevil(s2.x, s2.y));
        }
        banners.push({ text:T.name + ' 召唤增援', sub:'', life:1.2, small:true });
        sfx('wave');
      }
      // 蓄力冲锋（猎尸/博士为连环冲锋）
      else if (S.charge && b.cool2 <= 0 && d > 110 && d < 480 && !losBlocked(b.x, b.y, target.x, target.y)){
        b.mode = 'tele'; b.t = .5; b.dashN = T.chain;
      }
      // 震地波
      else if (S.slam && b.cool3 <= 0 && d < 95 + T.scale*14){
        b.mode = 'slam'; b.t = .5;
      }
      // 毒吐：朝玩家三连毒弹
      else if (S.spit && b.cool4 <= 0 && d < 430 && !losBlocked(b.x, b.y, target.x, target.y)){
        b.cool4 = (4 + Math.random()*2) * cdMul;
        for (const off of [-.22, 0, .22]){
          const a = Math.atan2(dy, dx) + off;
          fireballs.push({ x:b.x+Math.cos(a)*20, y:b.y+Math.sin(a)*20,
            vx:Math.cos(a)*250, vy:Math.sin(a)*250, r:6, life:2.4, green:true,
            targetId:target.id });
        }
        sfx('fire');
      }
      // 全向弹幕（巨像 8 向 / 博士 12 向毒弹）
      else if (S.barrage && b.cool4 <= 0){
        b.cool4 = (7 + Math.random()*2) * cdMul;
        const n = T.doctor ? 12 : 8;
        for (let k = 0; k < n; k++){
          const a = k/n * 6.283 + time;
          fireballs.push({ x:b.x+Math.cos(a)*22, y:b.y+Math.sin(a)*22,
            vx:Math.cos(a)*210, vy:Math.sin(a)*210, r:6, life:2.8, green:T.doctor });
        }
        sfx('fire'); shake = Math.max(shake, 4);
      }
      // 毒池：在玩家脚下标记酸液区
      else if (S.pools && b.cool5 <= 0 && d < 420){
        b.cool5 = 9 * cdMul;
        hazards.push({ x:target.x, y:target.y, r:50, warn:.75, life:6, tick:0,
          targetId:target.id });
        if (b.rage) hazards.push({ x:target.x+(Math.random()-.5)*120,
          y:target.y+(Math.random()-.5)*120, r:46, warn:.85, life:6, tick:0,
          targetId:target.id });
        sfx('fire');
        banners.push({ text:'毒池标记！', sub:'快离开绿圈', life:1, small:true });
      }
    } else if (b.mode === 'tele'){               // 冲锋前摇：原地颤抖锁定
      b.t -= dt;
      b.x += (Math.random()-.5)*2; b.y += (Math.random()-.5)*2;
      if (b.t <= 0){
        b.mode = 'dash'; b.t = .7;
        b.dashx = dx/d; b.dashy = dy/d;
        sfx('fire'); shake = Math.max(shake, 5);
      }
    } else if (b.mode === 'dash'){               // 高速冲锋（可连环）
      b.t -= dt;
      b.x += b.dashx * 440 * dt; b.y += b.dashy * 440 * dt;
      b.walk += dt*16;
      collide(b);
      particles.push({ x:b.x, y:b.y+8, vx:(Math.random()-.5)*40, vy:(Math.random()-.5)*40,
        life:.25, max:.25, size:4, color:'#9a948a' });
      for (const p of livingPlayers()){
        if (Math.hypot(p.x-b.x,p.y-b.y) < b.r + p.r + 4 && p.inv <= 0){
          damagePlayer(T.melee + 4 + Math.floor(wave/3), p);
          p.x += b.dashx*26; p.y += b.dashy*26; collide(p);
          b.t = 0; break;
        }
      }
      if (b.t <= 0){
        b.dashN--;
        if (b.dashN > 0){ b.mode = 'tele'; b.t = .26; }
        else { b.mode = 'walk'; b.cool2 = (5 + Math.random()*2) * cdMul; }
      }
    } else if (b.mode === 'slam'){               // 震地前摇 → AOE
      b.t -= dt;
      if (b.t <= 0){
        b.mode = 'walk'; b.cool3 = 7 * cdMul;
        const R = 110 + T.scale*20;
        sfx('boom'); shake = Math.max(shake, 12);
        scorch(b.x, b.y, R*.3);
        particles.push({ x:b.x, y:b.y, ring:true, life:.35, max:.35, size:R });
        for (const p of livingPlayers()){
          if (Math.hypot(p.x-b.x, p.y-b.y) < R){
            damagePlayer(10 + b.tier*3 + Math.floor(wave/3), p);
            const ka = Math.atan2(p.y-b.y, p.x-b.x);
            p.x += Math.cos(ka)*44; p.y += Math.sin(ka)*44; collide(p);
          }
        }
      }
    }
    // 贴身普通攻击
    if (b.mode === 'walk' && d < b.r + target.r + 5 && b.atk <= 0){
      b.atk = 1;
      damagePlayer(T.melee + Math.floor(wave/3), target);
    }
  }

  // ----- 毒池（僵尸博士） -----
  for (let i = hazards.length-1; i >= 0; i--){
    const h = hazards[i];
    if (h.warn > 0){ h.warn -= dt; continue; }
    h.life -= dt; h.tick -= dt;
    if (h.life <= 0){ hazards.splice(i, 1); continue; }
    if (h.tick <= 0){
      h.tick = .45;
      for (const p of livingPlayers()){
        if (Math.hypot(p.x-h.x, p.y-h.y) < h.r && p.inv <= 0) damagePlayer(4, p);
      }
    }
  }

  // ----- 火球 -----
  for (let i = fireballs.length-1; i >= 0; i--){
    const f = fireballs[i];
    f.x += f.vx*dt; f.y += f.vy*dt; f.life -= dt;
    particles.push({ x:f.x, y:f.y, vx:0, vy:0, life:.18, max:.18, size:4,
      color: Math.random()<.5 ? '#ff8c2e' : '#e03c31' });
    let dead = f.life <= 0 || hitPillar(f.x, f.y, 3);
    if (!dead){
      for (const p of livingPlayers()){
        if (Math.hypot(f.x-p.x, f.y-p.y) < p.r+f.r){
          damagePlayer(12, p); dead = true; break;
        }
      }
    }
    if (dead){ sparks(f.x, f.y, 6, '#ff8c2e'); fireballs.splice(i, 1); }
  }

  // ----- 拾取物 -----
  for (let i = pickups.length-1; i >= 0; i--){
    const p = pickups[i];
    p.life -= dt;
    if (p.life <= 0){ pickups.splice(i, 1); continue; }
    const candidates = livingPlayers()
      .map(target => ({ target, distance:Math.hypot(p.x-target.x, p.y-target.y) }))
      .filter(item => item.distance < item.target.r+13);
    let receiver = null;
    let ammoWeapon = -1;
    if (p.type === 'heal'){
      receiver = candidates
        .filter(item => item.target.hp < 100)
        .sort((a,b) => (a.target.hp-b.target.hp) || (a.distance-b.distance))[0]?.target || null;
    } else {
      const bestAmmo = candidates.flatMap(item => item.target.ammo.flatMap((amount,w) =>
        item.target.unlocked[w] && !WEAPONS[w].infinite
          ? [{ target:item.target, weapon:w,
               need:amount / Math.max(1, WEAPONS[w].give), distance:item.distance }]
          : []
      )).sort((a,b) => (a.need-b.need) || (a.distance-b.distance))[0];
      if (bestAmmo){
        receiver = bestAmmo.target;
        ammoWeapon = bestAmmo.weapon;
      }
    }
    if (receiver){
      if (p.type === 'heal'){
        receiver.hp = Math.min(100, receiver.hp + 25);
        banners.push({ text:receiver.name + ' +25 生命', sub:'', life:1, small:true });
      } else {
        if (ammoWeapon < 0) continue;
        receiver.ammo[ammoWeapon] += Math.ceil(WEAPONS[ammoWeapon].give*.5);
        banners.push({ text:receiver.name + ' · 弹药补给',
          sub:WEAPONS[ammoWeapon].name, life:1, small:true });
      }
      sfx('pickup'); pickups.splice(i, 1);
    }
  }

  // ----- 粒子 -----
  const pcap = isPhone() ? 400 : 800;                                       // 软上限，防连环爆炸粒子暴涨卡顿（手机更低）
  if (particles.length > pcap) particles.splice(0, particles.length - pcap);
  for (let i = particles.length-1; i >= 0; i--){
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0){
      if (p.decal){
        pushDecal({ dot:true, x:p.x, y:p.y, r:1.3+Math.random()*1.3, born:time });
      }
      particles.splice(i, 1); continue;
    }
    if (!p.ring){
      p.x += p.vx*dt; p.y += p.vy*dt;
      p.vx *= (1-3*dt); p.vy *= (1-3*dt);
    }
  }

  for (let i = banners.length-1; i >= 0; i--){
    banners[i].life -= dt;
    if (banners[i].life <= 0) banners.splice(i, 1);
  }

  if (netMode === 'host' && now - lastSnapshotSent >= 50){
    lastSnapshotSent = now;
    net.sendSnapshot({ tick:++snapshotTick, simTime:time, state:buildNetworkState() });
  }
}

function copyScalars(entity){
  const out = {};
  for (const [key, value] of Object.entries(entity)){
    if (key === 'T' || key === 'target' || key === 'cv') continue;
    if (value === null || ['number','string','boolean'].includes(typeof value)) out[key] = value;
  }
  return out;
}

function networkPlayerState(p){
  const out = copyScalars(p);
  out.ammo = p.ammo.map(value => Number.isFinite(value) ? value : -1);
  out.unlocked = p.unlocked.slice();
  return out;
}

function buildNetworkState(){
  return {
    phase:state === 'over' ? 'dying' : state,
    mapIndex,
    wave, spawnQueue, devilQueue, spawnTimer, waveRest,
    score, kills, streak, multiplier, bestMulti, comboTimer, decayTimer,
    players:allPlayers().map(networkPlayerState),
    zombies:zombies.map(copyScalars),
    devils:devils.map(copyScalars),
    bosses:bosses.map(copyScalars),
    bullets:bullets.map(copyScalars),
    grenades:grenades.map(copyScalars),
    rockets:rockets.map(copyScalars),
    barrels:barrels.map(copyScalars),
    fireballs:fireballs.map(copyScalars),
    pickups:pickups.map(copyScalars),
    hazards:hazards.map(copyScalars),
    banners:banners.map(copyScalars)
  };
}

function networkNumber(value, fallback, min, max){
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function safeSnapshotEntity(value){
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)){
    if (typeof item === 'number'){
      if (Number.isFinite(item)){
        out[key] = ['r','size','rx','ry','width','height'].includes(key)
          ? Math.max(0, Math.min(1000, item))
          : Math.max(-1e12, Math.min(1e12, item));
      }
    } else if (typeof item === 'string'){
      out[key] = item.slice(0, 160);
    } else if (typeof item === 'boolean' || item === null){
      out[key] = item;
    }
  }
  return out;
}

function applyNetworkState(snapshot){
  if (!snapshot || !Array.isArray(snapshot.players)) return;
  if (Number.isInteger(snapshot.mapIndex) && snapshot.mapIndex !== mapIndex){
    mapIndex = Math.max(0, Math.min(MAPS.length-1, snapshot.mapIndex));
    buildGround(); refreshMapSel();
  }
  const previousLocal = player && player.id === net.selfId ? player : null;
  const bannerKey = banner => [
    banner && banner.text,
    banner && banner.sub,
    !!(banner && banner.big),
    !!(banner && banner.small)
  ].join('|');
  const previousBannerKeys = new Set((banners || []).map(bannerKey));
  const localTarget = previousLocal && previousLocal.alive !== false && previousLocal.hp > 0
    ? previousLocal.target
    : null;
  const rosterIds = new Set((net.room && Array.isArray(net.room.players) ? net.room.players : [])
    .map(member => member && member.id)
    .filter(id => typeof id === 'string'));
  const nextPlayers = new Map();
  for (const raw of snapshot.players.slice(0, 4)){
    if (!raw || typeof raw.id !== 'string' || raw.id.length > 80) continue;
    if (rosterIds.size && !rosterIds.has(raw.id)) continue;
    const safe = safeSnapshotEntity(raw);
    if (!safe) continue;
    const slot = Math.max(0, Math.min(3, Number.isInteger(raw.slot) ? raw.slot : 0));
    const member = { id:raw.id, name:typeof raw.name === 'string' ? raw.name.slice(0,12) : '幸存者' };
    const p = Object.assign(makePlayer(member, slot), safe);
    p.id = member.id; p.name = member.name; p.slot = slot;
    p.x = networkNumber(raw.x, p.x, -500, WW+500);
    p.y = networkNumber(raw.y, p.y, -500, WH+500);
    p.hp = networkNumber(raw.hp, p.hp, 0, 100);
    p.alive = raw.alive !== false && p.hp > 0;
    p.ammo = WEAPONS.map((weapon,w) => {
      const amount = Array.isArray(raw.ammo) ? raw.ammo[w] : undefined;
      if (weapon.infinite) return Infinity;
      return networkNumber(amount, 0, 0, 1000000);
    });
    p.unlocked = WEAPONS.map((weapon,w) =>
      w === 0 || !!(Array.isArray(raw.unlocked) && raw.unlocked[w]));
    const weapon = Number.isInteger(raw.weapon) ? raw.weapon : 0;
    p.weapon = weapon >= 0 && weapon < WN && p.unlocked[weapon] ? weapon : 0;
    nextPlayers.set(p.id, p);
  }
  if (!nextPlayers.has(net.selfId)) return;
  players = nextPlayers;
  player = players.get(net.selfId) || players.values().next().value || player;
  if (player){
    if (previousLocal && previousLocal.alive !== false && previousLocal.hp > 0 &&
        player.alive !== false && player.hp > 0){
      const correction = Math.hypot(previousLocal.x-player.x, previousLocal.y-player.y);
      if (correction < 140){
        player.x = player.x*.35 + previousLocal.x*.65;
        player.y = player.y*.35 + previousLocal.y*.65;
      }
      if (localTarget) player.target = localTarget;
    } else {
      player.target = null;
    }
    if (previousLocal && previousLocal.alive !== false && player.alive !== false){
      if (player.hp < previousLocal.hp){
        sfx('hurt');
        shake = Math.max(shake, 9);
      }
      if (player.lastShot > previousLocal.lastShot){
        const shotSound = {
          pistol:'pistol', magnum:'pistol', uzi:'uzi', gatling:'uzi',
          shotgun:'shotgun', flamer:'fire', grenade:'fire', barrel:'click', rocket:'rocket'
        }[WEAPONS[player.weapon].icon] || 'fire';
        sfx(shotSound);
      }
    }
    localUltSeq = Math.max(localUltSeq, Number(player.lastUltSeq)||0);
    if (localDesiredWeapon !== null){
      if (player.weapon === localDesiredWeapon ||
          !player.unlocked[localDesiredWeapon] ||
          (!WEAPONS[localDesiredWeapon].infinite && player.ammo[localDesiredWeapon] <= 0)){
        localDesiredWeapon = null;
      } else {
        player.weapon = localDesiredWeapon;
      }
    }
  }
  const array = (name, limit) => Array.isArray(snapshot[name])
    ? snapshot[name].slice(0, limit).map(safeSnapshotEntity).filter(Boolean)
    : [];
  zombies = array('zombies', 400); devils = array('devils', 200);
  bosses = array('bosses', 8).map(b => {
    b.tier = Math.max(0, Math.min(BOSS_TYPES.length-1, Number.isInteger(b.tier) ? b.tier : 0));
    b.T = BOSS_TYPES[b.tier];
    return b;
  });
  bullets = array('bullets', 800); grenades = array('grenades', 80); rockets = array('rockets', 80);
  barrels = array('barrels', 100); fireballs = array('fireballs', 500); pickups = array('pickups', 120);
  hazards = array('hazards', 300).map(h => {
    h.r = networkNumber(h.r, 0, 0, 500);
    h.warn = networkNumber(h.warn, 0, 0, .85);
    h.life = networkNumber(h.life, 0, 0, 1000);
    return h;
  });
  banners = array('banners', 40);
  if (player && banners.some(banner =>
    !previousBannerKeys.has(bannerKey(banner)) &&
    typeof banner.text === 'string' &&
    banner.text.includes(player.name) &&
    (banner.text.includes('生命') || banner.text.includes('弹药补给'))
  )) sfx('pickup');
  wave = networkNumber(snapshot.wave, 0, 0, 10000);
  spawnQueue = networkNumber(snapshot.spawnQueue, 0, 0, 100000);
  devilQueue = networkNumber(snapshot.devilQueue, 0, 0, 100000);
  spawnTimer = networkNumber(snapshot.spawnTimer, 0, -10, 100000);
  waveRest = networkNumber(snapshot.waveRest, 0, -10, 100000);
  score = networkNumber(snapshot.score, 0, 0, 1e12);
  kills = networkNumber(snapshot.kills, 0, 0, 1e9);
  streak = networkNumber(snapshot.streak, 0, 0, 1e9);
  multiplier = networkNumber(snapshot.multiplier, 1, 1, 99);
  bestMulti = networkNumber(snapshot.bestMulti, 1, 1, 99);
  comboTimer = networkNumber(snapshot.comboTimer, 0, 0, 100000);
  decayTimer = networkNumber(snapshot.decayTimer, 0, 0, 100000);
  if (snapshot.phase === 'dying' && state === 'play'){
    document.getElementById('finalStats').innerHTML =
      '队伍人数<em>' + allPlayers().length + '</em>&nbsp;&nbsp;坚守波数<em>' + wave + '</em><br>' +
      '击杀数<em>' + kills + '</em>&nbsp;&nbsp;最高连击<em>×' + bestMulti +
      '</em>&nbsp;&nbsp;最终得分<em>' + score.toLocaleString() + '</em>';
    state = 'dying';
    clearTimeout(gameOverTimer);
    gameOverTimer = setTimeout(() => {
      gameOverTimer = null;
      if (state === 'dying' && netMode === 'guest') setScreen('over');
    }, 900);
  }
}

function updateGuest(dt, now){
  time += dt; frameN++;
  if (!player) return;
  const input = collectLocalInput(dt);
  // 只做本机移动预测；伤害、射击、拾取等必须等待房主快照。
  if (player.alive !== false){
    const al = Math.hypot(input.ax,input.ay);
    if (al > .01){ player.fx = input.ax/al; player.fy = input.ay/al; }
    let mx = input.mx, my = input.my;
    const ml = Math.hypot(mx,my);
    if (ml > 1){ mx /= ml; my /= ml; }
    if (ml > .01){
      const spd = player.ultT > 0 ? 232 : 190;
      player.x += mx*spd*dt; player.y += my*spd*dt; player.walk += dt*11;
      player.moving = true; collide(player);
    } else player.moving = false;
  }
  if (now - lastInputSent >= 33){
    lastInputSent = now;
    net.sendInput(input);
  }
  // 根据速度外推高速弹体，下一份权威快照会纠正误差。
  for (const b of bullets){ b.x += b.vx*dt; b.y += b.vy*dt; }
  for (const g of grenades){ g.x += g.vx*dt; g.y += g.vy*dt; }
  for (const r of rockets){ r.x += r.vx*dt; r.y += r.vy*dt; }
  for (const f of fireballs){ f.x += f.vx*dt; f.y += f.vy*dt; }
  const focus = player.alive !== false ? player : (livingPlayers()[0] || player);
  const tx = focus.x - VW/2, ty = focus.y - VH/2;
  cam.x += (tx-cam.x)*Math.min(1,dt*7);
  cam.y += (ty-cam.y)*Math.min(1,dt*7);
  cam.x = Math.max(0,Math.min(WW-VW,cam.x));
  cam.y = Math.max(0,Math.min(WH-VH,cam.y));
}

/* ========================================================
   渲染：描边卡通风（仿截图手绘感）
   ======================================================== */
const OUT = '#23211d';          // 全局描边色
function outRect(c, x, y, w, h, fill){
  c.fillStyle = fill; c.fillRect(x, y, w, h);
  c.strokeStyle = OUT; c.lineWidth = 1.6; c.strokeRect(x, y, w, h);
}
function shadow(c, x, y, w){
  c.fillStyle = 'rgba(40,32,20,.22)';
  c.beginPath(); c.ellipse(x, y+9, w, w*.45, 0, 0, 7); c.fill();
}

/* ---- 玩家：戴帽红发独眼悍匪（仿参考图2） ---- */
function drawPlayer(c, p){
  c.save(); c.translate(p.x|0, p.y|0);
  if (multiplayerActive() && p === player){
    c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = 2;
    c.beginPath(); c.ellipse(0, 8, 18, 9, 0, 0, 7); c.stroke();
  }
  if (p.ultT > 0){                                      // 无双金色光环
    const pul = 1 + Math.sin(time*9)*.12;
    c.strokeStyle = 'rgba(255,179,62,.85)';
    c.lineWidth = 3;
    c.beginPath(); c.ellipse(0, 7, 19*pul, 9*pul, 0, 0, 7); c.stroke();
    c.strokeStyle = 'rgba(255,226,62,.5)';
    c.lineWidth = 1.6;
    c.beginPath(); c.ellipse(0, 7, 24*pul, 11.5*pul, 0, 0, 7); c.stroke();
  }
  shadow(c, 0, 6, 13);
  const leg = p.moving ? Math.sin(p.walk)*4 : 0;
  // 深色军靴
  outRect(c, -7, 6 + leg*.6, 5.5, 8, '#23262c');
  outRect(c, 1.5, 6 - leg*.6, 5.5, 8, '#23262c');
  // 身体：黑色无袖背心 + 露出的肤色肩臂 + 灰色短裤
  outRect(c, -9, -5, 18, 13, '#1e2126');               // 背心
  c.fillStyle = p.color || '#f2efe4'; c.fillRect(-8, 1.5, 16, 2.2); // 联机玩家识别色
  c.fillStyle = '#e8b482';                              // 肩头肤色
  c.fillRect(-9, -5, 3, 4.5); c.fillRect(6, -5, 3, 4.5);
  c.fillStyle = '#8b8c8a'; c.fillRect(-9, 4, 18, 4);    // 灰色短裤
  c.strokeStyle = OUT; c.lineWidth = 1.6; c.strokeRect(-9, 4, 18, 4);
  // 持枪手臂 / 无双双刀（朝向）
  const ang = Math.atan2(p.fy, p.fx);
  c.save(); c.rotate(ang);
  if (p.ultT > 0){
    // —— 双刀形态：两臂各持一刃，随挥砍角摆动 ——
    const sw = Math.sin(p.swing) * .8;
    for (const s of [-1, 1]){
      c.save(); c.rotate(s*.4 + sw*s*.55);
      outRect(c, 3, s*4.5-2.2, 11, 4.4, '#e8b482');     // 手臂
      c.fillStyle = '#8a5a30';                           // 刀柄
      c.fillRect(12.5, s*4.5-2.6, 4, 5.2);
      c.fillStyle = '#e8ecf0';                           // 刀刃
      c.strokeStyle = OUT; c.lineWidth = 1.4;
      c.beginPath();
      c.moveTo(16.5, s*4.5-3);
      c.lineTo(33, s*4.5-1.2);
      c.lineTo(16.5, s*4.5+3);
      c.closePath(); c.fill(); c.stroke();
      c.fillStyle = 'rgba(255,255,255,.7)';              // 刃口高光
      c.fillRect(17, s*4.5-1.6, 13, 1.2);
      c.restore();
    }
  } else {
    outRect(c, 3, -6.5, 12, 4.5, '#e8b482');             // 前臂
    const icon = WEAPONS[p.weapon].icon;
    switch (icon){                                        // —— 按武器画不同外观 ——
      case 'pistol':
        outRect(c, 12, -7.5, 12, 5.5, '#2e3138');
        outRect(c, 21, -6, 6, 3, '#4a4e55');
        break;
      case 'magnum':
        outRect(c, 12, -8, 13, 6, '#3a3f46');            // 加重机匣
        outRect(c, 23, -6.8, 10, 3.6, '#565c64');        // 加长枪管
        c.fillStyle = '#23262c';                          // 弹巢
        c.beginPath(); c.arc(17.5, -5, 3, 0, 7); c.fill();
        c.strokeStyle = OUT; c.lineWidth = 1.2; c.stroke();
        break;
      case 'uzi':
        outRect(c, 12, -8, 11, 6.5, '#23262c');          // 方匣机身
        outRect(c, 15, -2, 4, 7, '#2e3138');             // 下垂弹匣
        outRect(c, 22, -6.2, 5, 3, '#4a4e55');
        break;
      case 'shotgun':
        outRect(c, 10, -7, 7, 5, '#6b4a2a');             // 木质枪托
        outRect(c, 16, -7.5, 18, 4, '#2e3138');          // 长枪管
        outRect(c, 18, -3.8, 7, 3, '#6b4a2a');           // 泵动护木
        break;
      case 'gatling':
        outRect(c, 12, -9.5, 12, 9.5, '#3a3f46');        // 机匣
        c.fillStyle = '#565c64';                          // 三联装管
        c.fillRect(23, -9, 12, 2.4);
        c.fillRect(23, -5.8, 12, 2.4);
        c.fillRect(23, -2.6, 12, 2.4);
        c.strokeStyle = OUT; c.lineWidth = 1.4;
        c.strokeRect(23, -9, 12, 8.8);
        outRect(c, 14, .5, 6.5, 5, '#23262c');           // 弹箱
        break;
      case 'grenade':
        c.fillStyle = '#4e7a38';                          // 绿色手雷
        c.strokeStyle = OUT; c.lineWidth = 1.5;
        c.beginPath(); c.arc(17.5, -4.5, 4.6, 0, 7); c.fill(); c.stroke();
        c.fillStyle = '#8a8a88'; c.fillRect(16, -11, 3.2, 3.5);  // 引信头
        break;
      case 'barrel':
        outRect(c, 13, -10, 9.5, 11, '#9d9a94');         // 抱着小油桶
        c.fillStyle = '#e06a1e'; c.fillRect(13, -6, 9.5, 3.2);
        break;
      case 'flamer':
        outRect(c, 12, -8.5, 10, 7, '#b34718');          // 燃料罐
        outRect(c, 22, -6.4, 8, 2.8, '#4a4e55');         // 喷管
        c.fillStyle = '#ff8c2e';                          // 常燃火苗
        c.fillRect(30, -6.8, 2.6, 3.6);
        break;
      case 'rocket':
        outRect(c, 9, -10, 22, 7, '#5d6246');            // 军绿发射筒
        c.fillStyle = '#e03c31'; c.fillRect(27.5, -9.4, 3.5, 5.8); // 弹头
        c.fillStyle = '#23262c'; c.fillRect(9, -9.4, 2.6, 5.8);    // 尾口
        break;
    }
    const FLASH_X = { pistol:29, magnum:35, uzi:29, shotgun:36, gatling:37, flamer:34, rocket:34 };
    const fxp = FLASH_X[icon];
    if (p.flash > 0 && fxp){                              // 黄色星形枪口火光
      c.fillStyle = '#ffe23e';
      c.beginPath();
      for (let i = 0; i < 8; i++){
        const a = i/8*Math.PI*2 + Math.random()*.3;
        const rr = i%2 ? 4 : 9 + Math.random()*4;
        c.lineTo(fxp + Math.cos(a)*rr, -4.5 + Math.sin(a)*rr);
      }
      c.closePath(); c.fill();
      c.fillStyle = '#fff8d0';
      c.beginPath(); c.arc(fxp, -4.5, 3.5, 0, 7); c.fill();
    }
  }
  c.restore();
  // 头：肤色脸
  outRect(c, -9.5, -21, 19, 17, '#e8b482');
  // 帽下露出的暗红头发
  c.fillStyle = '#7e2418';
  c.fillRect(-9.5, -16.5, 19, 3);
  c.fillRect(-9.5, -16.5, 3, 7); c.fillRect(6.5, -16.5, 3, 7); // 鬓角
  // 深色鸭舌帽（带帽檐）
  c.fillStyle = p.color || '#23262e';
  c.fillRect(-10.5, -22.5, 21, 3);                     // 帽顶外沿
  c.fillRect(-9.5, -21, 19, 4.5);                      // 帽体
  c.strokeStyle = OUT; c.strokeRect(-9.5, -21.8, 19, 5.3);
  // 下巴胡茬
  c.fillStyle = 'rgba(96,58,30,.4)';
  c.fillRect(-7, -8.5, 14, 4);
  // 眼睛：左眼黑色眼罩 + 右眼（随朝向）
  const ex = Math.max(-2.5, Math.min(2.5, p.fx*3)), ey = Math.max(-1.5, Math.min(1.5, p.fy*2));
  c.fillStyle = '#17161a';
  c.fillRect(-5.5 + ex, -12.5 + ey, 4.4, 4.6);         // 眼罩
  c.fillRect(2 + ex, -11.5 + ey, 2.6, 3.2);            // 右眼
  c.restore();
}

/* ---- 僵尸：高大纯黑方块头 + 白衣（仿参考图1） ---- */
function drawZombie(c, z){
  c.save(); c.translate(z.x|0, z.y|0);
  shadow(c, 0, 6, 12);
  const ang = Math.atan2(z.fy, z.fx);
  const leg = Math.sin(z.walk)*4;
  const flash = z.hit > 0;
  // 深灰方块脚
  outRect(c, -7, 6 + leg*.6, 5.5, 8, flash ? '#fff' : '#34322f');
  outRect(c, 1.5, 6 - leg*.6, 5.5, 8, flash ? '#fff' : '#34322f');
  // 僵直前伸的白色双臂 + 灰蓝手
  const armSwing = Math.sin(z.walk*.8)*2;
  c.save(); c.rotate(ang);
  outRect(c, 4, -9 + armSwing*.4, 15, 5, flash ? '#fff' : '#e9e7e1');
  outRect(c, 16, -9.5 + armSwing*.4, 4.5, 6, flash ? '#fff' : '#b3bac3');
  outRect(c, 4, 4 - armSwing*.4, 15, 5, flash ? '#fff' : '#e9e7e1');
  outRect(c, 16, 3.5 - armSwing*.4, 4.5, 6, flash ? '#fff' : '#b3bac3');
  c.restore();
  // 躯干：白衣 + 灰蓝 V 领 + 浅灰下摆
  outRect(c, -8.5, -6, 17, 14, flash ? '#fff' : '#efede7');
  if (!flash){
    c.fillStyle = '#aab6c2';                            // 灰蓝 V 形领口
    c.beginPath();
    c.moveTo(-5, -6); c.lineTo(5, -6); c.lineTo(0, 2);
    c.closePath(); c.fill();
    c.fillStyle = '#d4d6d1'; c.fillRect(-8.5, 4, 17, 4); // 下摆浅灰
  }
  // 头：高出一截的纯黑方块（无面孔）
  outRect(c, -8, -27, 16, 21, flash ? '#fff' : '#17161a');
  if (!flash){
    c.fillStyle = 'rgba(255,255,255,.10)';              // 顶部反光
    c.fillRect(-8, -27, 16, 3);
    c.fillStyle = 'rgba(255,255,255,.05)';              // 侧面微光
    c.fillRect(-8, -27, 3, 21);
  }
  c.restore();
}

/* ---- 红恶魔：红身黑刺发 ---- */
function drawDevil(c, v){
  c.save(); c.translate(v.x|0, v.y|0);
  shadow(c, 0, 6, 13);
  const flash = v.hit > 0;
  const leg = Math.sin(v.walk)*4;
  outRect(c, -7, 6 + leg*.6, 5.5, 8, '#5e1410');
  outRect(c, 1.5, 6 - leg*.6, 5.5, 8, '#5e1410');
  const ang = Math.atan2(v.fy, v.fx);
  const armSwing = Math.sin(v.walk*.8)*2;
  c.save(); c.rotate(ang);
  outRect(c, 4, -9 + armSwing*.4, 14, 5, flash ? '#fff' : '#c43028');
  outRect(c, 4, 4 - armSwing*.4, 14, 5, flash ? '#fff' : '#c43028');
  c.restore();
  outRect(c, -8.5, -5, 17, 13, flash ? '#fff' : '#d23a2e');
  c.fillStyle = flash ? '#fff' : '#a02218'; c.fillRect(-8.5, 2, 17, 6);
  outRect(c, -9, -21, 18, 17, flash ? '#fff' : '#d23a2e');
  if (!flash){
    // 黑色刺状头发
    c.fillStyle = '#16130f';
    c.beginPath();
    c.moveTo(-9, -16);
    for (let i = 0; i <= 6; i++){
      c.lineTo(-9 + i*3, -21 - (i%2 ? 8 : 3) - (i===3?3:0));
      c.lineTo(-9 + i*3 + 1.5, -16.5);
    }
    c.lineTo(9, -16); c.closePath(); c.fill();
    c.fillRect(-9, -21, 18, 5);
    // 黄眼
    const ex = Math.max(-2.5, Math.min(2.5, v.fx*3));
    c.fillStyle = '#ffd23e';
    c.fillRect(-4.5 + ex, -12, 3, 3.4);
    c.fillRect(1.8 + ex, -12, 3, 3.4);
  }
  c.restore();
}

/* ---- 尸体贴片（侧躺黑头白衣僵尸，随血迹一起淡出） ---- */
function drawCorpse(x, y, scale){
  const sc = scale || 1;
  const S = 34 * sc;
  const [cv, c] = decalCanvas(S);
  c.translate(S, S);
  c.rotate(Math.random()*Math.PI*2);
  c.scale(sc, sc);
  c.globalAlpha = .95;
  outRect(c, -9, -7, 18, 13, '#e6e4de');    // 白色躯干
  c.fillStyle = '#c9ccc7'; c.fillRect(-9, 0, 18, 6);
  outRect(c, 9, -8, 15, 5, '#e9e7e1');      // 伸出的手臂
  outRect(c, 9, 3, 15, 5, '#e9e7e1');
  outRect(c, -26, -7, 17, 13, '#17161a');   // 黑色方块头
  pushDecal({ cv, x, y, born: time });
}

/* ---- Boss：五级造型（体型/配色随类型，博士为白褂绿镜疯狂科学家） ---- */
function drawBoss(c, b){
  const T = b.T, sc = T.scale;
  c.save(); c.translate(b.x|0, b.y|0);
  shadow(c, 0, 8*sc, 13*sc);
  const warn = (b.mode === 'tele' || b.mode === 'slam') && Math.floor(time*12)%2;
  if (b.mode === 'tele' || b.mode === 'slam'){          // 脚下红色警示圈
    c.strokeStyle = 'rgba(224,60,49,.8)';
    c.lineWidth = 3;
    const rr = b.mode === 'slam' ? 110 + sc*20 : 18*sc;
    c.beginPath(); c.ellipse(0, 8, rr, rr*.5, 0, 0, 7); c.stroke();
  }
  if (b.rage){                                          // 狂暴绿色怒气环
    const pul = 1 + Math.sin(time*10)*.15;
    c.strokeStyle = 'rgba(57,255,136,.7)';
    c.lineWidth = 3;
    c.beginPath(); c.ellipse(0, 8, 22*sc*pul, 10*sc*pul, 0, 0, 7); c.stroke();
  }
  c.save(); c.scale(sc, sc);
  const flash = b.hit > 0;
  const tint = flash ? '#fff' : (warn ? '#e8b0aa' : null);
  const ang = Math.atan2(b.fy, b.fx);
  const leg = Math.sin(b.walk)*4;
  outRect(c, -7, 6 + leg*.6, 5.5, 8, tint || '#2a2825');
  outRect(c, 1.5, 6 - leg*.6, 5.5, 8, tint || '#2a2825');
  const armSwing = Math.sin(b.walk*.8)*2;
  c.save(); c.rotate(ang);
  const armCol = tint || (T.doctor ? '#f0efe9' : '#ddd9d2');   // 博士白褂袖
  outRect(c, 4, -9 + armSwing*.4, 15, 5, armCol);
  outRect(c, 16, -9.5 + armSwing*.4, 4.5, 6, tint || '#a3aab3');
  outRect(c, 4, 4 - armSwing*.4, 15, 5, armCol);
  outRect(c, 16, 3.5 - armSwing*.4, 4.5, 6, tint || '#a3aab3');
  if (T.doctor && !flash){                              // 博士手中巨型针筒
    c.fillStyle = '#d8e4ea';
    c.fillRect(17, -1.4, 12, 3);
    c.strokeStyle = OUT; c.lineWidth = 1.2; c.strokeRect(17, -1.4, 12, 3);
    c.fillStyle = '#39ff88';                            // 绿色血清
    c.fillRect(18, -.8, 7 + Math.sin(time*6)*2, 1.8);
    c.fillStyle = '#8a8f95';                            // 针头
    c.fillRect(29, -.4, 6, 1.1);
  }
  c.restore();
  // 躯干
  if (T.doctor){
    outRect(c, -9.5, -8, 19, 17, tint || '#f0efe9');     // 白色实验袍（更高大）
    if (!flash){
      c.fillStyle = '#d2d4cf';                           // 衣襟开缝
      c.fillRect(-1, -8, 2, 17);
      c.fillStyle = '#2f6a4a';                           // 内衬暗绿
      c.beginPath(); c.moveTo(-5,-8); c.lineTo(5,-8); c.lineTo(0,0); c.closePath(); c.fill();
      c.fillStyle = 'rgba(63,174,78,.65)';               // 飞溅的血清污渍
      c.fillRect(-7.5, 2, 4, 3); c.fillRect(4, -3, 3, 4); c.fillRect(-3, 6, 3, 2.5);
      c.fillStyle = '#8e3a34';                           // 暗红血渍
      c.fillRect(2, 4.5, 3.5, 2.5);
    }
  } else {
    outRect(c, -8.5, -6, 17, 14, tint || '#e2dfd8');
    if (!flash){
      c.fillStyle = warn ? '#e03c31' : T.vcol;           // 各型专属 V 领
      c.beginPath();
      c.moveTo(-5, -6); c.lineTo(5, -6); c.lineTo(0, 2);
      c.closePath(); c.fill();
      c.fillStyle = '#c4c6c1'; c.fillRect(-8.5, 4, 17, 4);
    }
  }
  // 头：更高大的纯黑方块 + 发光双目
  const hh = T.doctor ? 28 : 24;                         // 博士头更高
  outRect(c, -8.5, -6 - hh, 17, hh, tint || (T.doctor ? '#0d0c11' : '#121116'));
  if (!flash){
    c.fillStyle = 'rgba(255,255,255,.08)';
    c.fillRect(-8.5, -6 - hh, 17, 3);
    const ex = Math.max(-2.5, Math.min(2.5, b.fx*3));
    if (T.doctor){
      // 绿色护目镜：横带 + 两块发光镜片 + 裂纹
      c.fillStyle = '#3a3f46';
      c.fillRect(-8.5, -6 - hh*.62, 17, 5.5);
      const glow = b.rage ? (Math.floor(time*10)%2 ? '#b6ffd2' : '#39ff88') : '#39ff88';
      c.fillStyle = glow;
      c.fillRect(-6 + ex, -6 - hh*.6, 4.6, 4);
      c.fillRect(1.6 + ex, -6 - hh*.6, 4.6, 4);
      c.strokeStyle = '#0d0c11'; c.lineWidth = .8;
      c.beginPath();                                     // 右镜片裂纹
      c.moveTo(3 + ex, -6 - hh*.6);
      c.lineTo(4.5 + ex, -6 - hh*.6 + 2.2);
      c.lineTo(6 + ex, -6 - hh*.6 + 1);
      c.stroke();
      // 缝合狞笑
      c.strokeStyle = '#39ff88'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(-4 + ex, -9.5); c.lineTo(4 + ex, -9.5); c.stroke();
      for (let k = -3; k <= 3; k += 2){
        c.beginPath(); c.moveTo(k + ex, -11); c.lineTo(k + ex, -8); c.stroke();
      }
    } else {
      c.fillStyle = warn ? '#ffe23e' : T.eye;            // 各型专属发光眼
      c.fillRect(-5 + ex, -6 - hh*.55, 3.4, 2.6);
      c.fillRect(1.8 + ex, -6 - hh*.55, 3.4, 2.6);
    }
  }
  c.restore();
  // 头顶血条
  const bw = 46 + sc*12, bh = 7;
  const ty = -(6 + (T.doctor ? 28 : 24)) * sc - 14;
  c.fillStyle = '#23211d';
  c.fillRect(-bw/2-1.5, ty-1.5, bw+3, bh+3);
  c.fillStyle = '#3c3128';
  c.fillRect(-bw/2, ty, bw, bh);
  c.fillStyle = b.rage ? '#39ff88' : '#e03c31';
  c.fillRect(-bw/2, ty, bw*Math.max(0, b.hp/b.maxhp), bh);
  c.restore();
}

/* ---- 油桶：灰色 + 橙条 + 3D 顶面 ---- */
function drawBarrel(c, b){
  const x = b.x|0, y = b.y|0;
  const lit = b.fuse !== undefined && Math.floor(time*16)%2;
  shadow(c, x, y+6, 13);
  c.strokeStyle = OUT; c.lineWidth = 1.6;
  // 桶身
  c.fillStyle = lit ? '#ffe23e' : '#9d9a94';
  c.beginPath();
  c.moveTo(x-11, y-12); c.lineTo(x-11, y+8);
  c.arc(x, y+8, 11, Math.PI, 0, true);
  c.lineTo(x+11, y-12);
  c.closePath(); c.fill(); c.stroke();
  // 橙色条带
  c.fillStyle = lit ? '#ffb33e' : '#e06a1e';
  c.fillRect(x-11, y-4, 22, 6);
  c.strokeRect(x-11, y-4, 22, 6);
  // 顶面椭圆（亮灰）
  c.fillStyle = lit ? '#fff3b0' : '#c9c6c0';
  c.beginPath(); c.ellipse(x, y-12, 11, 5, 0, 0, 7); c.fill(); c.stroke();
  c.fillStyle = 'rgba(255,255,255,.35)';
  c.beginPath(); c.ellipse(x-3, y-13, 5, 2, -.4, 0, 7); c.fill();
}

/* ---- 六棱石柱 ---- */
function drawPillar(c, p){
  const x = p.x|0, y = p.y|0, r = p.r, h = p.h;
  const PC = MAPS[mapIndex].pil;
  const hex = (cx, cy, rr) => {
    c.beginPath();
    for (let i = 0; i < 6; i++){
      const a = Math.PI/6 + i*Math.PI/3;
      const px = cx + Math.cos(a)*rr, py = cy + Math.sin(a)*rr*.62;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.closePath();
  };
  c.strokeStyle = OUT; c.lineWidth = 2;
  // 柱身（左右两个侧面色阶）
  c.fillStyle = PC[0];
  c.beginPath();
  c.moveTo(x - r*Math.cos(Math.PI/6), y - h + r*.62*Math.sin(Math.PI/6));
  c.lineTo(x - r*Math.cos(Math.PI/6), y + r*.62*Math.sin(Math.PI/6));
  c.lineTo(x, y + r*.62);
  c.lineTo(x, y - h + r*.62);
  c.closePath(); c.fill(); c.stroke();
  c.fillStyle = PC[1];
  c.beginPath();
  c.moveTo(x + r*Math.cos(Math.PI/6), y - h + r*.62*Math.sin(Math.PI/6));
  c.lineTo(x + r*Math.cos(Math.PI/6), y + r*.62*Math.sin(Math.PI/6));
  c.lineTo(x, y + r*.62);
  c.lineTo(x, y - h + r*.62);
  c.closePath(); c.fill(); c.stroke();
  // 顶面（亮色）
  c.fillStyle = PC[2];
  hex(x, y - h, r); c.fill(); c.stroke();
  c.fillStyle = 'rgba(255,255,255,.4)';
  hex(x - r*.18, y - h - 2, r*.55); c.fill();
}

/* ---- 拾取物：橙色立方箱 / 白色医疗箱 ---- */
function drawPickup(c, p){
  const bob = Math.sin(time*4 + p.x)*2.5;
  if (p.life < 3 && Math.floor(time*6)%2) return;
  const x = p.x|0, y = (p.y + bob)|0, s = 11;
  shadow(c, x, p.y+8, 11);
  c.strokeStyle = OUT; c.lineWidth = 1.6;
  if (p.type === 'ammo'){
    // 橙色 3D 立方体
    c.fillStyle = '#d8521e';                      // 正面
    c.fillRect(x-s, y-s*.3, s*2, s*1.3); c.strokeRect(x-s, y-s*.3, s*2, s*1.3);
    c.fillStyle = '#f07830';                      // 顶面
    c.beginPath();
    c.moveTo(x-s, y-s*.3); c.lineTo(x-s*.55, y-s*1.1);
    c.lineTo(x+s*1.45, y-s*1.1); c.lineTo(x+s, y-s*.3);
    c.closePath(); c.fill(); c.stroke();
  } else {
    c.fillStyle = '#f2efe7';
    c.fillRect(x-s, y-s*.3, s*2, s*1.3); c.strokeRect(x-s, y-s*.3, s*2, s*1.3);
    c.fillStyle = '#fbfaf6';
    c.beginPath();
    c.moveTo(x-s, y-s*.3); c.lineTo(x-s*.55, y-s*1.1);
    c.lineTo(x+s*1.45, y-s*1.1); c.lineTo(x+s, y-s*.3);
    c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#d8231a';                      // 红十字
    c.fillRect(x-2.5, y-s*.15, 5, s);
    c.fillRect(x-s*.6, y+s*.22, s*1.2, 5);
  }
}

/* ========================================================
   主渲染：镜头 + 深度排序
   ======================================================== */
function drawHUD(){
  ctx.textAlign = 'center';
  // 顶部信息条（轻量化）。触屏单人局左上角压着暂停键，文字整体右移让位
  const hudL = (isTouch && !multiplayerActive())
    ? Math.min(120, Math.ceil(52 / Math.max(.2, viewScale))) : 0;
  ctx.fillStyle = 'rgba(28,24,18,.62)';
  ctx.fillRect(0, 0, VW, 38);
  ctx.fillStyle = '#f2efe4'; ctx.font = 'bold 15px sans-serif';
  ctx.fillText('第 ' + wave + ' 波', hudL + 70, 25);
  ctx.fillText('得分 ' + score.toLocaleString(), hudL + 220, 25);
  // 连击倍数
  ctx.textAlign = 'right';
  ctx.font = '900 26px sans-serif';
  ctx.fillStyle = multiplier >= 8 ? '#ffb33e' : '#e8e4d8';
  ctx.fillText('连击 ×' + multiplier, VW-18, 27);
  if (comboTimer > 0){
    ctx.fillStyle = '#ffb33e';
    ctx.fillRect(VW-128, 31, 110 * Math.min(1, comboTimer/9), 3);
  }
  // 右上角：击杀数
  ctx.font = 'bold 17px sans-serif';
  ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.strokeStyle = '#23211d';
  ctx.strokeText('击杀 ' + kills, VW-18, 60);
  ctx.fillStyle = '#f7f4ea';
  ctx.fillText('击杀 ' + kills, VW-18, 60);
  if (multiplayerActive()){
    ctx.textAlign = 'left';
    let py = 56;
    for (const p of allPlayers()){
      ctx.fillStyle = 'rgba(20,22,24,.78)';
      ctx.fillRect(12, py-13, 142, 18);
      ctx.fillStyle = p.color || '#fff';
      ctx.font = 'bold 11px sans-serif';
      const hpText = p.alive === false ? '倒地' : Math.ceil(p.hp) + ' HP';
      ctx.fillText((p === player ? '▸ ' : '') + p.name + '  ' + hpText, 18, py);
      py += 21;
    }
  }
  // 右下角：无双大招按钮（PC 画在 canvas 内、可鼠标点；触屏改用 HTML #ultBtn）
  if (isTouch){
    updateUltBtn();
    refreshSwapBtn();
  } else {
    const ux = ULT_BTN.x, uy = ULT_BTN.y;
    ctx.beginPath(); ctx.arc(ux, uy, 26, 0, 7);
    if (player.ultT > 0) ctx.fillStyle = 'rgba(255,179,62,.95)';
    else if (player.ultCharge > 0)
      ctx.fillStyle = Math.floor(time*4)%2 ? 'rgba(224,60,49,.95)' : 'rgba(216,82,30,.95)';
    else ctx.fillStyle = 'rgba(28,24,18,.78)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = (player.ultCharge > 0 || player.ultT > 0) ? '#ffe23e' : '#57503f';
    ctx.stroke();
    ctx.lineWidth = 4;
    if (player.ultT > 0){                       // 持续时间倒计时圈
      ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(ux, uy, 20, -Math.PI/2, -Math.PI/2 + 6.283*player.ultT/15); ctx.stroke();
    } else if (player.ultCharge <= 0){          // 充能进度圈
      ctx.strokeStyle = '#ffb33e';
      ctx.beginPath(); ctx.arc(ux, uy, 20, -Math.PI/2, -Math.PI/2 + 6.283*player.ultKills/50); ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = player.ultCharge > 0 || player.ultT > 0 ? '#fff' : '#9c947f';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(player.ultT > 0 ? Math.ceil(player.ultT) + 's'
               : (player.ultCharge > 0 ? '无双' : player.ultKills + '/50'), ux, uy);
    ctx.font = '10px sans-serif';
    ctx.fillText(player.ultT > 0 ? '乱舞中' : 'R / 点击', ux, uy + 14);
  }
  // 顶部中央：Boss 血条
  if (bosses.length > 0){
    const b = bosses[0];
    const bw = 340, bx = (VW-bw)/2, by2 = 48;
    ctx.textAlign = 'center';
    ctx.font = 'bold 13px sans-serif';
    ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.strokeStyle = '#23211d';
    const bname = 'BOSS · ' + b.T.name + (b.rage ? '【狂暴】' : '');
    ctx.strokeText(bname, VW/2, by2);
    ctx.fillStyle = b.rage ? '#7dffb0' : '#ff6a5e';
    ctx.fillText(bname, VW/2, by2);
    ctx.fillStyle = '#23211d';
    ctx.fillRect(bx-2, by2+5, bw+4, 12);
    ctx.fillStyle = '#3c3128';
    ctx.fillRect(bx, by2+7, bw, 8);
    ctx.fillStyle = b.rage ? '#39ff88' : '#e03c31';
    ctx.fillRect(bx, by2+7, bw*Math.max(0, b.hp/b.maxhp), 8);
  }
  // 底部武器栏（自适应武器数量）。触屏可以直接点某一格换枪，几何跟 weaponSlotAt 共用
  const bar = weaponBar(), slotW = bar.slotW, x0 = bar.x0, y0 = bar.y0;
  const narrow = slotW < 72;
  ctx.textAlign = 'center';
  for (let i = 0; i < WN; i++){
    const x = x0 + i*slotW;
    const sel = player.weapon === i, un = player.unlocked[i];
    const empty = un && !WEAPONS[i].infinite && player.ammo[i] <= 0;
    ctx.fillStyle = sel ? 'rgba(216,82,30,.92)' : 'rgba(28,24,18,.72)';
    ctx.fillRect(x+2, y0, slotW-4, bar.h);
    ctx.strokeStyle = sel ? '#ffe23e' : 'rgba(0,0,0,.5)';
    ctx.lineWidth = sel ? 2 : 1;
    ctx.strokeRect(x+2, y0, slotW-4, bar.h);
    ctx.fillStyle = un ? (empty ? '#9c947f' : '#f7f4ea') : '#6b665a';
    ctx.font = 'bold ' + (narrow ? 11 : 12) + 'px sans-serif';
    ctx.fillText((i+1) + ' ' + WEAPONS[i].name, x+slotW/2, y0+17);
    ctx.font = (narrow ? 10 : 11) + 'px sans-serif';
    if (!un) ctx.fillText('×' + WEAPONS[i].unlock + ' 解锁', x+slotW/2, y0+33);
    else ctx.fillText(WEAPONS[i].infinite ? '∞' : ('弹药 ' + player.ammo[i]), x+slotW/2, y0+33);
  }
  // 中央横幅
  let by = VH*0.30;
  for (const b of banners){
    const a = Math.min(1, b.life / .5);
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#23211d'; ctx.lineJoin = 'round';
    if (b.big){
      ctx.font = '900 56px sans-serif'; ctx.lineWidth = 8;
      ctx.strokeText(b.text, VW/2, by);
      ctx.fillStyle = '#e03c31'; ctx.fillText(b.text, VW/2, by);
      ctx.font = 'bold 20px sans-serif'; ctx.lineWidth = 5;
      ctx.strokeText(b.sub, VW/2, by+34);
      ctx.fillStyle = '#f7f4ea'; ctx.fillText(b.sub, VW/2, by+34);
      by += 100;
    } else if (b.small){
      ctx.font = 'bold 17px sans-serif'; ctx.lineWidth = 4;
      const s = b.text + (b.sub ? '：' + b.sub : '');
      ctx.strokeText(s, VW/2, VH*0.62);
      ctx.fillStyle = '#ffe23e'; ctx.fillText(s, VW/2, VH*0.62);
    } else {
      ctx.font = '900 34px sans-serif'; ctx.lineWidth = 6;
      const s = b.text + '：' + b.sub;
      ctx.strokeText(s, VW/2, by);
      ctx.fillStyle = '#ffb33e'; ctx.fillText(s, VW/2, by);
      by += 56;
    }
    ctx.globalAlpha = 1;
  }
  if (spawnQueue<=0 && devilQueue<=0 && zombies.length===0 && devils.length===0 && bosses.length===0 && wave>0){
    ctx.font = 'bold 18px sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = '#23211d';
    ctx.strokeText('下一波 ' + Math.ceil(waveRest) + ' 秒…', VW/2, 70);
    ctx.fillStyle = '#f7f4ea';
    ctx.fillText('下一波 ' + Math.ceil(waveRest) + ' 秒…', VW/2, 70);
  }
}

function render(){
  const sx = (Math.random()-.5)*shake, sy = (Math.random()-.5)*shake;
  const cx = cam.x + sx, cy = cam.y + sy;
  ctx.save();
  ctx.translate(-cx|0, -cy|0);
  // 地面 + 血迹（只画可视区域）
  ctx.drawImage(ground, cx|0, cy|0, VW, VH, cx|0, cy|0, VW, VH);
  // 血迹/焦痕/尸体贴片：15 秒寿命，最后 3 秒淡出
  for (let i = decals.length-1; i >= 0; i--){
    const d = decals[i];
    const age = time - d.born;
    if (age > DECAL_LIFE){ decals.splice(i, 1); continue; }
    if (d.x < cx-90 || d.x > cx+VW+90 || d.y < cy-90 || d.y > cy+VH+90) continue;
    const a = age > DECAL_LIFE-3 ? (DECAL_LIFE - age)/3 : 1;
    ctx.globalAlpha = a;
    if (d.dot){
      ctx.fillStyle = '#b51f15';
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 7); ctx.fill();
    } else {
      ctx.drawImage(d.cv, d.x - d.cv.width/2, d.y - d.cv.height/2);
    }
  }
  ctx.globalAlpha = 1;

  // 平面层：拾取物
  for (const p of pickups) drawPickup(ctx, p);
  // 手雷 / 火箭 / 火球
  for (const g of grenades){
    ctx.fillStyle = Math.floor(time*10)%2 ? '#3a5e2a' : '#4e7a38';
    ctx.strokeStyle = OUT; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(g.x, g.y, 5, 0, 7); ctx.fill(); ctx.stroke();
  }
  for (const r of rockets){
    ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(Math.atan2(r.vy, r.vx));
    outRect(ctx, -8, -3, 14, 6, '#d8d2c2');
    ctx.fillStyle = '#e03c31'; ctx.fillRect(6, -3, 4, 6);
    ctx.restore();
  }
  for (const f of fireballs){
    if (f.green){
      ctx.fillStyle = '#3fae4e';
      ctx.beginPath(); ctx.arc(f.x, f.y, 7, 0, 7); ctx.fill();
      ctx.fillStyle = '#a8ff6e';
      ctx.beginPath(); ctx.arc(f.x, f.y, 4, 0, 7); ctx.fill();
    } else {
      ctx.fillStyle = '#ff8c2e';
      ctx.beginPath(); ctx.arc(f.x, f.y, 7, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffe23e';
      ctx.beginPath(); ctx.arc(f.x, f.y, 4, 0, 7); ctx.fill();
    }
  }
  // 毒池：预警绿圈 → 冒泡酸液
  for (const h of hazards){
    if (h.warn > 0){
      const pul = (time*4) % 1;
      ctx.strokeStyle = 'rgba(86,224,101,.9)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r*(0.4+0.6*(1-h.warn/.85)), h.r*.55*(0.4+0.6*(1-h.warn/.85)), 0, 0, 7); ctx.stroke();
      ctx.strokeStyle = 'rgba(86,224,101,' + (.4+pul*.4) + ')';
      ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r, h.r*.55, 0, 0, 7); ctx.stroke();
    } else {
      const fade = Math.min(1, h.life/1.2);
      ctx.globalAlpha = .55 * fade;
      ctx.fillStyle = '#3fae4e';
      ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r, h.r*.55, 0, 0, 7); ctx.fill();
      ctx.globalAlpha = .5 * fade;
      ctx.fillStyle = '#6fd862';
      ctx.beginPath(); ctx.ellipse(h.x-h.r*.2, h.y-h.r*.1, h.r*.55, h.r*.3, 0, 0, 7); ctx.fill();
      // 冒泡
      ctx.fillStyle = '#c9ff9e';
      for (let k = 0; k < 4; k++){
        const bx = h.x + Math.sin(time*3 + k*2.1)*h.r*.6;
        const by = h.y + Math.cos(time*2.3 + k*1.7)*h.r*.3;
        ctx.beginPath(); ctx.arc(bx, by, 2 + (Math.sin(time*5+k)+1)*1.2, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  // 深度排序层：油桶、僵尸、恶魔、玩家、石柱
  // 用类型标记代替每实体的箭头函数闭包，减少每帧的垃圾回收压力
  const list = [];
  for (const b of barrels) if (b.hp > 0) list.push({ y:b.y, t:0, o:b });
  for (const z of zombies) list.push({ y:z.y, t:1, o:z });
  for (const v of devils)  list.push({ y:v.y, t:2, o:v });
  for (const b of bosses)  list.push({ y:b.y, t:3, o:b });
  if (state !== 'dying'){
    for (const p of allPlayers()){
      if (p.alive === false || p.inv <= 0 || Math.floor(time*14)%2 === 0)
        list.push({ y:p.y, t:4, o:p });
    }
  }
  for (const p of pillars) list.push({ y:p.y + p.r*.62, t:5, o:p });
  list.sort((a, b) => a.y - b.y);
  for (const it of list){
    switch (it.t){
      case 0: drawBarrel(ctx, it.o); break;
      case 1: drawZombie(ctx, it.o); break;
      case 2: drawDevil(ctx, it.o); break;
      case 3: drawBoss(ctx, it.o); break;
      case 4:
        if (it.o.alive === false) ctx.globalAlpha = .28;
        drawPlayer(ctx, it.o);
        ctx.globalAlpha = 1;
        break;
      case 5: drawPillar(ctx, it.o); break;
    }
  }

  // 子弹：火舌画橙色火团，其余画曳光
  for (const b of bullets){
    if (b.flame){
      const t = Math.max(0, b.life / (b.max || .45));
      ctx.globalAlpha = .25 + .7*t;
      ctx.fillStyle = t > .55 ? '#ffd23e' : '#ff8c2e';
      ctx.beginPath(); ctx.arc(b.x, b.y, 4 + (1-t)*7, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = '#ffe9a3'; ctx.lineWidth = 2.4;
      const l = Math.hypot(b.vx, b.vy);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - b.vx/l*b.len, b.y - b.vy/l*b.len);
      ctx.stroke();
    }
  }
  // 粒子
  for (const p of particles){
    const a = Math.max(0, p.life/p.max);
    if (p.ring){
      ctx.strokeStyle = 'rgba(255,226,62,' + a + ')';
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size*(1-a)+8, 0, 7); ctx.stroke();
    } else {
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x-p.size/2, p.y-p.size/2, p.size, p.size);
      ctx.globalAlpha = 1;
    }
  }

  // 鼠标模式：目标点标记 + 指针准星
  if (controlMode === 'mouse' && state === 'play'){
    if (player.target){
      const t = player.target;
      const pul = (time*3) % 1;
      ctx.strokeStyle = 'rgba(53,212,53,.9)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(t.x, t.y, 6 + (1-pul)*10, 0, 7); ctx.stroke();
      ctx.strokeStyle = '#35d435';
      ctx.beginPath();
      ctx.moveTo(t.x-5, t.y); ctx.lineTo(t.x+5, t.y);
      ctx.moveTo(t.x, t.y-5); ctx.lineTo(t.x, t.y+5);
      ctx.stroke();
    }
    if (mouse.has){
      const wx = mouse.sx + cx, wy = mouse.sy + cy;
      ctx.strokeStyle = 'rgba(35,33,29,.85)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(wx, wy, 9, 0, 7); ctx.stroke();
      ctx.strokeStyle = '#f7f4ea';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(wx-13, wy); ctx.lineTo(wx-5, wy);
      ctx.moveTo(wx+5, wy);  ctx.lineTo(wx+13, wy);
      ctx.moveTo(wx, wy-13); ctx.lineTo(wx, wy-5);
      ctx.moveTo(wx, wy+5);  ctx.lineTo(wx, wy+13);
      ctx.stroke();
    }
  }

  // 玩家头顶：昵称、武器名与生命值
  if (state !== 'dying'){
    for (const p of allPlayers()){
      const px = p.x|0, py = (p.y - 34)|0;
      const wname = p.alive === false ? '倒地' : (p.ultT > 0 ? '无双双刀' : WEAPONS[p.weapon].name);
      const label = multiplayerActive() ? p.name + ' · ' + wname : wname;
      ctx.textAlign = 'center';
      ctx.font = 'bold 14px sans-serif';
      ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.strokeStyle = '#23211d';
      ctx.strokeText(label, px, py);
      ctx.fillStyle = p.alive === false ? '#888' : (p.ultT > 0 ? '#ffe23e' : (p.color || '#fff'));
      ctx.fillText(label, px, py);
      const bw = 46, bh = 9;
      ctx.fillStyle = '#23211d';
      ctx.fillRect(px-bw/2-1.5, py+5-1.5, bw+3, bh+3);
      ctx.fillStyle = '#3c3128';
      ctx.fillRect(px-bw/2, py+5, bw, bh);
      ctx.fillStyle = p.hp > 30 ? '#35d435' : '#e03c31';
      ctx.fillRect(px-bw/2, py+5, bw*Math.max(0,p.hp)/100, bh);
    }
  }
  ctx.restore();

  // 低血量红晕
  if (player.hp <= 30 && state === 'play'){
    const a = (.18 + Math.sin(time*6)*.08) * (1 - player.hp/30);
    const grd = ctx.createRadialGradient(VW/2, VH/2, VH*.3, VW/2, VH/2, VH*.72);
    grd.addColorStop(0, 'rgba(224,60,49,0)');
    grd.addColorStop(1, 'rgba(224,60,49,' + Math.max(0,a) + ')');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, VW, VH);
  }
  drawHUD();
}

/* ---------- 界面切换 ---------- */
const screens = { menu:document.getElementById('menu'), help:document.getElementById('help'),
                  pause:document.getElementById('pause'), over:document.getElementById('over'),
                  mapsel:document.getElementById('mapsel'), online:document.getElementById('online') };
function setScreen(s){
  state = s;
  if (s === 'pause') shake = 0;        // 暂停时立即停止画面抖动
  for (const k in screens) screens[k].classList.add('hidden');
  if (screens[s]) screens[s].classList.remove('hidden');
  const playing = (s === 'play');
  const touchPlay = playing && isTouch;
  touchUI.style.display = touchPlay ? 'block' : 'none';
  swapBtn.style.display = touchPlay ? 'block' : 'none';
  ultBtn.style.display  = touchPlay ? 'block' : 'none';
  pauseBtn.style.display = (touchPlay && !multiplayerActive()) ? 'block' : 'none';
  ghostL.classList.toggle('on', touchPlay);
  ghostR.classList.toggle('on', touchPlay);
  document.getElementById('netHud').classList.toggle('hidden', !(playing && multiplayerActive()));
  if (!playing){ resetSticks(); hideTouchGuide(); }   // 离开战斗时清掉摇杆，防止手指状态卡住
  if (touchPlay){ refreshSwapBtn(); layoutTouchUI(); }
  cvs.style.cursor = (playing && controlMode === 'mouse') ? 'none' : 'default';
}
const modeBtns = [document.getElementById('btnMode'), document.getElementById('btnMode2')];
function refreshModeBtns(){
  const label = '操作模式：' + (controlMode === 'classic' ? '键盘经典' : '鼠标射击');
  for (const b of modeBtns) b.textContent = label;
}
function toggleMode(){
  controlMode = controlMode === 'classic' ? 'mouse' : 'classic';
  if (player) player.target = null;
  refreshModeBtns();
  sfx('click');
  cvs.style.cursor = (state === 'play' && controlMode === 'mouse') ? 'none' : 'default';
}
modeBtns.forEach(b => b.onclick = toggleMode);
refreshModeBtns();
/* ---------- 难度选择（记在本地，下次进来还是这一档） ---------- */
const btnDiff = document.getElementById('btnDiff');
const savedDiff = DIFFS.findIndex(d => d.key === localStoreGet(DIFF_KEY));
if (savedDiff >= 0) diffIndex = savedDiff;
function refreshDiffBtn(){ btnDiff.textContent = '难度：' + DIF().name; }
btnDiff.onclick = () => {
  diffIndex = (diffIndex + 1) % DIFFS.length;
  localStoreSet(DIFF_KEY, DIF().key);
  refreshDiffBtn();
  sfx('click');
};
refreshDiffBtn();
/* ---------- 地图选择页：五张缩略图卡片 ---------- */
const btnMap = document.getElementById('btnMap');
const mapGrid = document.getElementById('mapgrid');
const mapCards = [];
function makeThumb(mi){
  // 临时构建该地图地面以截取缩略图
  const old = mapIndex;
  mapIndex = mi; buildGround();
  const cv = document.createElement('canvas');
  cv.width = 224; cv.height = 126;
  const c = cv.getContext('2d');
  const srcH = WW * 126 / 224;
  c.drawImage(ground, 0, 0, WW, srcH, 0, 0, 224, 126);
  // 叠一个示意石柱
  c.fillStyle = MAPS[mi].pil[2];
  c.strokeStyle = '#23211d'; c.lineWidth = 1.5;
  c.beginPath(); c.ellipse(58, 32, 14, 8, 0, 0, 7); c.fill(); c.stroke();
  c.fillStyle = MAPS[mi].pil[0];
  c.fillRect(44, 32, 28, 18); c.strokeRect(44, 32, 28, 18);
  mapIndex = old;
  return cv;
}
function refreshMapSel(){
  mapCards.forEach((c, i) => c.classList.toggle('sel', i === mapIndex));
  btnMap.textContent = '选择地图：' + MAPS[mapIndex].name;
}
MAPS.forEach((m, i) => {
  const card = document.createElement('div');
  card.className = 'mapcard';
  card.appendChild(makeThumb(i));
  const nm = document.createElement('div');
  nm.className = 'nm'; nm.textContent = m.name;
  card.appendChild(nm);
  card.onclick = () => {
    mapIndex = i; buildGround();
    if (net.room && net.room.phase === 'lobby' && net.isHost) net.configureRoom(i);
    refreshMapSel(); sfx('click');
  };
  mapGrid.appendChild(card);
  mapCards.push(card);
});
buildGround();          // 恢复当前选中地图的地面
refreshMapSel();
let mapReturnScreen = 'menu';
btnMap.onclick = () => { mapReturnScreen = 'menu'; setScreen('mapsel'); sfx('click'); };
document.getElementById('btnMapBack').onclick = () => { setScreen(mapReturnScreen); sfx('click'); };

/* ---------- 多人联机大厅 ---------- */
const onlineName = document.getElementById('onlineName');
const onlineServer = document.getElementById('onlineServer');
const onlineConsent = document.getElementById('onlineConsent');
const roomCodeInput = document.getElementById('roomCodeInput');
const btnCreateRoom = document.getElementById('btnCreateRoom');
const btnJoinRoom = document.getElementById('btnJoinRoom');
const onlineJoin = document.getElementById('onlineJoin');
const roomPanel = document.getElementById('roomPanel');
const roomPlayers = document.getElementById('roomPlayers');
const roomCodeLabel = document.getElementById('roomCode');
const roomMeta = document.getElementById('roomMeta');
const onlineStatus = document.getElementById('onlineStatus');
const btnReady = document.getElementById('btnReady');
const btnRoomStart = document.getElementById('btnRoomStart');
const btnRoomMap = document.getElementById('btnRoomMap');
const netHud = document.getElementById('netHud');
const netRole = document.getElementById('netRole');
const netRoom = document.getElementById('netRoom');
const netCount = document.getElementById('netCount');
const netPing = document.getElementById('netPing');
const retryBtn = document.getElementById('btnRetry');
let roomRequestBusy = false;

onlineName.value = localStoreGet('zombie-world-player-name') ||
  ('幸存者' + Math.floor(10 + Math.random()*90));
onlineServer.value = net.url;
roomCodeInput.addEventListener('input', () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
});

function setOnlineStatus(text, kind){
  onlineStatus.textContent = text;
  onlineStatus.dataset.kind = kind || '';
}
function setRoomRequestBusy(busy){
  roomRequestBusy = !!busy;
  btnCreateRoom.disabled = roomRequestBusy;
  btnJoinRoom.disabled = roomRequestBusy;
}
const ONLINE_ERROR_TEXT = {
  INVALID_NAME:'昵称需为 1–12 个字符。',
  INVALID_ROOM_CODE:'房间码格式不正确。',
  ROOM_NOT_FOUND:'没有找到该房间，可能已关闭。',
  ROOM_FULL:'房间已满，最多 4 人。',
  INVALID_PHASE:'当前房间状态不能执行此操作。',
  MIN_PLAYERS:'至少需要 2 名玩家。',
  PLAYER_DISCONNECTED:'有玩家正在重连，请稍候。',
  NOT_READY:'所有玩家准备后才能开始。',
  HOST_UNAVAILABLE:'房主正在重连，请稍候。',
  RESUME_FAILED:'重连凭证已失效，请重新加入。',
  RATE_LIMITED:'操作过于频繁，连接已被保护性关闭。',
  FORBIDDEN:'只有房主可以执行此操作。'
};
function currentName(){
  const name = onlineName.value.trim().slice(0,12) || '幸存者';
  onlineName.value = name;
  localStoreSet('zombie-world-player-name', name);
  return name;
}
function onlineConsentGranted(){
  if (onlineConsent.checked) return true;
  setOnlineStatus('请先确认联机数据说明，再创建或加入房间。', 'error');
  return false;
}
function renderRoom(){
  const room = net.room;
  onlineJoin.classList.toggle('hidden', !!room);
  roomPanel.classList.toggle('hidden', !room);
  if (!room) return;
  const capacity = room.capacity || 4;
  roomCodeLabel.textContent = room.code;
  roomMeta.textContent = (net.isHost ? '你是房主 · ' : '') +
    '地图：' + MAPS[room.mapIndex || 0].name + ' · ' +
    room.players.length + '/' + capacity + ' 人';
  roomPlayers.innerHTML = '';
  const bySlot = new Map(room.players.map(p => [p.slot,p]));
  for (let slot = 0; slot < capacity; slot++){
    const member = bySlot.get(slot);
    const row = document.createElement('div');
    row.className = 'room-player' + (!member ? ' empty' :
      (member.ready ? ' ready' : '') + (member.connected === false ? ' offline' : ''));
    if (!member){
      row.innerHTML = '<span class="slot">' + (slot+1) + '</span><span class="name">等待玩家…</span>';
    } else {
      const tag = member.id === room.hostId ? '房主' : (member.ready ? '已准备' : '未准备');
      row.innerHTML = '<span class="slot">' + (slot+1) + '</span><span class="name"></span><span class="tag"></span>';
      row.querySelector('.name').textContent = member.name + (member.id === net.selfId ? '（你）' : '');
      row.querySelector('.tag').textContent = member.connected === false ? '重连中' : tag;
    }
    roomPlayers.appendChild(row);
  }
  const self = room.players.find(p => p.id === net.selfId);
  btnReady.textContent = self && self.ready ? '取消准备' : '准备';
  btnReady.disabled = room.phase !== 'lobby';
  btnRoomMap.disabled = !net.isHost || room.phase !== 'lobby';
  btnRoomStart.classList.toggle('hidden', !net.isHost);
  const allReady = room.players.length >= 2 && room.players.every(p => p.ready && p.connected !== false);
  btnRoomStart.disabled = room.phase !== 'lobby' || !allReady;
  setOnlineStatus(room.phase === 'lobby'
    ? (allReady ? '全员已准备，房主可以开始。' : '至少 2 人，所有人准备后由房主开始。')
    : '战局进行中', allReady ? 'ok' : '');
}

function refreshNetHud(statusText){
  if (!net.room) return;
  netRole.textContent = statusText || (netMode === 'host' ? '房主' : '队员');
  netRoom.textContent = net.room.code;
  netCount.textContent = net.room.players.length + '/' + (net.room.capacity || 4);
  netPing.textContent = net.latency === null ? '-- ms' : net.latency + ' ms';
}

function beginOnlineMatch(message){
  const roster = Array.isArray(message.players) ? message.players :
    (net.room ? net.room.players : []);
  if (!roster.length) return;
  if (net.room){
    net.room.phase = 'playing';
    net.room.mapIndex = Number.isInteger(message.mapIndex) ? message.mapIndex : net.room.mapIndex;
    net.room.players = roster;
  }
  netMode = net.isHost ? 'host' : 'guest';
  mapIndex = Number.isInteger(message.mapIndex) ? message.mapIndex : (net.room.mapIndex || 0);
  buildGround(); refreshMapSel();
  reset(roster);
  retryBtn.disabled = netMode === 'guest';
  retryBtn.textContent = netMode === 'host' ? '返回房间再战' : '等待房主重开';
  audioInit();
  setScreen('play');
  showTouchGuide();
  refreshNetHud();
  if (netMode === 'host'){
    lastSnapshotSent = 0;
    net.sendSnapshot({ tick:++snapshotTick, simTime:time, state:buildNetworkState() });
  }
}

function leaveMultiplayer(showOnline, reason){
  if (net.room) net.leaveRoom();
  else net.disconnect(true);
  setRoomRequestBusy(false);
  netMode = 'solo';
  reset();
  if (showOnline){
    setScreen('online');
    setOnlineStatus(reason || '已离开房间。');
  } else {
    setScreen('menu');
  }
  renderRoom();
}

document.getElementById('btnOnline').onclick = () => {
  onlineServer.value = net.url;
  setScreen('online');
  renderRoom();
  sfx('click');
};
btnCreateRoom.onclick = async () => {
  if (roomRequestBusy) return;
  if (!onlineConsentGranted()) return;
  audioInit();
  setRoomRequestBusy(true);
  setOnlineStatus('正在连接服务器…');
  try {
    net.setServerUrl(onlineServer.value);
    onlineServer.value = net.url;
    await net.createRoom(currentName(), 4);
  } catch (error){
    setRoomRequestBusy(false);
    setOnlineStatus(error.message || '连接失败', 'error');
  }
};
btnJoinRoom.onclick = async () => {
  if (roomRequestBusy) return;
  if (!onlineConsentGranted()) return;
  const code = roomCodeInput.value.trim();
  if (code.length < 4){ setOnlineStatus('请输入有效房间码。', 'error'); return; }
  audioInit();
  setRoomRequestBusy(true);
  setOnlineStatus('正在加入房间…');
  try {
    net.setServerUrl(onlineServer.value);
    onlineServer.value = net.url;
    await net.joinRoom(code, currentName());
  } catch (error){
    setRoomRequestBusy(false);
    setOnlineStatus(error.message || '连接失败', 'error');
  }
};
btnReady.onclick = () => {
  audioInit();
  const self = net.room && net.room.players.find(p => p.id === net.selfId);
  if (self) net.setReady(!self.ready);
};
btnRoomStart.onclick = () => { audioInit(); net.startMatch(); };
btnRoomMap.onclick = () => { mapReturnScreen = 'online'; setScreen('mapsel'); sfx('click'); };
document.getElementById('btnCopyCode').onclick = async () => {
  if (!net.room) return;
  try {
    await navigator.clipboard.writeText(net.room.code);
    setOnlineStatus('房间码已复制。', 'ok');
  } catch (_) {
    setOnlineStatus('房间码：' + net.room.code, 'ok');
  }
};
document.getElementById('btnLeaveRoom').onclick = () => leaveMultiplayer(true);
document.getElementById('btnOnlineBack').onclick = () => {
  if (net.room) net.leaveRoom();
  else net.disconnect(true);
  setRoomRequestBusy(false);
  netMode = 'solo'; reset(); setScreen('menu'); renderRoom();
};
document.getElementById('netLeaveBtn').onclick = () => leaveMultiplayer(false);

net.addEventListener('room.state', event => {
  setRoomRequestBusy(false);
  const message = event.detail;
  if (net.room) net.room.capacity = Number(message.capacity)||4;
  renderRoom(); refreshNetHud();
  if (net.room && net.room.phase === 'lobby') restoringSavedSession = false;
  if (net.room && net.room.phase === 'playing' && netMode === 'solo' && restoringSavedSession){
    restoringSavedSession = false;
    if (net.isHost){
      // 页面刷新会丢失房主内存中的权威世界；安全退回大厅，避免继续广播错误战局。
      setScreen('online');
      setOnlineStatus('房主页面已刷新，本局已安全结束，请全员重新准备。', 'error');
      net.send('match.finish');
    } else {
      beginOnlineMatch({ players:net.room.players, mapIndex:net.room.mapIndex });
      setOnlineStatus('已恢复联机战局。', 'ok');
    }
  }
  if (net.room && net.room.phase === 'lobby' && netMode !== 'solo'){
    netMode = 'solo';
    reset();
    setScreen('online');
    renderRoom();
  }
  if (netMode === 'host' && net.room){
    const ids = new Set(net.room.players.map(p => p.id));
    for (const id of players.keys()){
      if (!ids.has(id)){
        players.delete(id);
        netInputs.delete(id);
      }
    }
    if (state === 'play' && livingPlayers().length === 0) gameOver();
    if (net.room.phase === 'playing'){
      lastSnapshotSent = performance.now();
      net.sendSnapshot({ tick:++snapshotTick, simTime:time, state:buildNetworkState() });
    }
  }
});
net.addEventListener('match.start', event => {
  restoringSavedSession = false;
  beginOnlineMatch(event.detail);
});
net.addEventListener('input', event => {
  if (netMode !== 'host') return;
  const input = Object.assign({}, event.detail, { receivedAt:performance.now() });
  netInputs.set(input.playerId, input);
});
net.addEventListener('snapshot', event => {
  if (netMode !== 'guest') return;
  lastGuestSnapshotAt = performance.now();
  if (Number.isFinite(event.detail.simTime)) time = event.detail.simTime;
  applyNetworkState(event.detail.state);
});
net.addEventListener('error', event => {
  setRoomRequestBusy(false);
  const text = ONLINE_ERROR_TEXT[event.detail.code] || event.detail.message || '联机请求失败。';
  if (event.detail.requestType === 'room.resume'){
    restoringSavedSession = false;
    leaveMultiplayer(true, text);
    return;
  }
  setOnlineStatus(text, 'error');
});
net.addEventListener('room.closed', event => {
  if (multiplayerActive()) leaveMultiplayer(true, '房间已关闭：' + (event.detail.reason || '连接结束'));
  else { renderRoom(); setOnlineStatus('房间已关闭。', 'error'); }
});
net.addEventListener('status', event => {
  const status = event.detail.state;
  if (status === 'reconnecting'){
    setOnlineStatus('网络中断，正在尝试重连…', 'error');
    refreshNetHud('重连中');
  } else if (status === 'connected'){
    setOnlineStatus(net.room ? '已重新连接。' : '服务器已连接。', 'ok');
    refreshNetHud();
  } else if (status === 'disconnected' || status === 'error'){
    setOnlineStatus('联机服务器连接中断。', 'error');
    refreshNetHud('断线');
  }
});
document.addEventListener('visibilitychange', () => {
  if (netMode !== 'host' || !net.room || net.room.phase !== 'playing') return;
  banners.push({
    text:document.hidden ? '房主切到后台' : '房主已返回',
    sub:document.hidden ? '浏览器可能暂停权威战局，请保持房主页面在前台' : '战局继续同步',
    life:3,
    small:true
  });
  lastSnapshotSent = performance.now();
  net.sendSnapshot({ tick:++snapshotTick, simTime:time, state:buildNetworkState() });
});
if (net.hasSavedSession()){
  restoringSavedSession = true;
  onlineConsent.checked = true;
  setScreen('online');
  setOnlineStatus('正在恢复上一次联机会话…');
  net.resumeSavedSession().catch(error => {
    setOnlineStatus(error.message || '会话恢复失败，请重新加入房间。', 'error');
  });
}

document.getElementById('btnStart').onclick = () => {
  if (net.room) net.leaveRoom();
  else net.disconnect(true);
  netMode = 'solo'; audioInit(); reset(); retryBtn.disabled = false;
  retryBtn.textContent = '重新开始'; setScreen('play');
  showTouchGuide();
};
document.getElementById('btnHelp').onclick  = () => setScreen('help');
document.getElementById('btnBack').onclick  = () => setScreen('menu');
document.getElementById('btnResume').onclick= () => setScreen('play');
document.getElementById('btnQuit').onclick  = () => setScreen('menu');
document.getElementById('btnRetry').onclick = () => {
  if (netMode === 'host') net.send('match.finish');
  else if (netMode === 'guest') return;
  else { reset(); setScreen('play'); showTouchGuide(); }
};
document.getElementById('btnMenu').onclick  = () => {
  if (multiplayerActive()) leaveMultiplayer(false);
  else setScreen('menu');
};

/* ---------- 主循环 ---------- */
let last = performance.now();
function loop(now){
  const dt = Math.min(.033, (now - last)/1000);
  last = now;
  if (state === 'play'){
    if (netMode === 'guest') updateGuest(dt, now);
    else update(dt, now);
  }
  if (multiplayerActive() && frameN % 30 === 0){
    refreshNetHud(netMode === 'guest' && now-lastGuestSnapshotAt > 2500 ? '等待同步' : '');
  }
  if (state === 'dying'){
    time += dt;
    for (let i = particles.length-1; i >= 0; i--){
      const p = particles[i]; p.life -= dt;
      if (p.life <= 0) particles.splice(i,1);
      else if (!p.ring){ p.x += p.vx*dt; p.y += p.vy*dt; }
    }
    if (shake > 0) shake = Math.max(0, shake - dt*30);
  }
  if (state === 'play' || state === 'dying' || state === 'pause') render();
  requestAnimationFrame(loop);
}
reset();
onViewportChange();      // 放在最后：此时画布、触屏按钮、镜头都已就位
requestAnimationFrame(loop);
