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
let viewScale = 1;                 // 一个虚拟像素占几个 CSS 像素
let renderScale = 1;               // 一个虚拟像素占几个物理像素 = viewScale × dpr，受画质档限制
let groundScale = 1;               // 地面预渲染倍率，步进 1 / 1.5 / 2
const ULT_BTN = { x: VW-52, y: VH-104, r: 28 };   // PC 端画在画布里的无双圆钮

/* ---------- 画质 ----------
   画面糊的根因：画布后备缓冲区一直是 VW×VH 个像素，却被 CSS 拉伸到整块屏幕。
   2K 屏上等于把 960 宽的位图放大 2.25 倍，再叠上 devicePixelRatio，越大屏越糊。
   解法是让后备缓冲区按「CSS 尺寸 × dpr」出真实物理像素，绘制坐标仍用虚拟坐标系
   （ctx 基准变换负责换算），游戏逻辑一行都不用改。 */
const QUALITIES = [
  { key:'auto', name:'自动', tip:'跟随屏幕分辨率' },
  { key:'low',  name:'流畅', tip:'低分辨率，最省性能' },
  { key:'high', name:'极清', tip:'榨干屏幕，老机器慎选' },
];
const QUALITY_KEY = 'zombie-world-quality';
let qualityIndex = 0;
function qualityCap(){
  const key = QUALITIES[qualityIndex].key;
  if (key === 'low') return 1;
  if (key === 'high') return 3;
  return isPhone() ? 2 : 2.5;      // 自动：手机压一点，别把低端机烧了
}

// 多设备环境判断（参照 Toy 多设备自适应指南：组合 pointer/hover/visualViewport，不只看 UA）
const coarsePointer = matchMedia('(pointer: coarse)').matches;
const isTouch = coarsePointer || ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
/* 容器（B站 App）报回来的状态。声明提到这儿，是因为下面的 isPhone 要读它，
   而 const 有暂时性死区——留在本节原地的话，将来谁在这上面加一句顶层调用就是开局白屏。
   怎么填、怎么用见下面「容器状态」一节。 */
const container = {
  ok: false,                 // 三个 API 齐了才算这条路通
  deviceType: '',            // phone / tablet / desktop / unknown
  orientation: '',           // portrait / landscape
  immersive: false,
  safeArea: { top:0, right:0, bottom:0, left:0 },
  pending: '',               // 正在飞的那个请求，防止同一个请求叠着发
  unsub: null,
};

// 手机判定：容器说了算，说不上来才退回按尺寸猜（540 这条线在开小窗的 PC 上会误伤）
function isPhone(){
  if (container.deviceType === 'phone') return true;
  if (container.deviceType === 'tablet' || container.deviceType === 'desktop') return false;
  return Math.min(innerWidth, innerHeight) <= 540;
}

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
  ULT_BTN.x = VW - 52; ULT_BTN.y = VH - 104;
  if (cam){                                   // 视口变了，镜头范围要重新夹紧
    cam.x = Math.max(0, Math.min(WW-VW, cam.x));
    cam.y = Math.max(0, Math.min(WH-VH, cam.y));
  }
}

// 后备缓冲区按物理像素出图；绘制坐标仍是虚拟坐标，靠 ctx 基准变换换算
function applyRenderScale(){
  const dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
  const want = Math.max(1, Math.min(qualityCap(), viewScale * dpr));
  const w = Math.max(1, Math.round(VW * want));
  const h = Math.max(1, Math.round(VH * want));
  if (cvs.width === w && cvs.height === h) return;
  cvs.width = w; cvs.height = h;                 // 改尺寸会清空画布并重置 ctx 状态
  renderScale = want;
  // 用实际像素数算比例，避免上面取整后累积出半像素偏移
  ctx.setTransform(w / VW, 0, 0, h / VH, 0, 0);
  syncGroundScale();
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
  applyRenderScale();
  layoutTouchUI();
  refreshQualityBtn();          // 窗口变了实际倍率也会变，按钮上的数字跟着走
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
  refreshRotateCta();          // App 内能一键转屏，那这条提示就该是个按钮，而不是一句话
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
   容器状态（Toy JS SDK · 2026-08-27 新上线的一组能力）
   在这之前，「App 到底把我们塞进了多大一块地方」只能靠 innerWidth/innerHeight 猜，
   猜错的代价是实打实的两处：
     · B 站 App 内嵌 WebView 里 env(safe-area-inset-*) 读出来是 0，
       顶部栏照样压着画面，左上角的暂停键就藏在它下面；
     · WebView 常锁竖屏，「横过来视野更宽」这句话对转不过来的人等于废话
       （见上面 applyViewport 的注释——竖屏版式就是为这批人做的）。
   现在容器自己会说：设备类型、可用尺寸、横竖屏、沉浸态、安全区，也能反过来请求它切。

   三条铁律，都是这套 API 的形状逼出来的：
   1. 每一个能力都可能不在——站外浏览器直接抛 unsupported，老版本 App 回 103，
      刚支持 Toy 的鸿蒙版能力集也未必铺全。而 index.html 顶上那层错误浮层
      会把未捕获的 rejection 糊在所有人屏幕上，所以这一节每一次调用都得自己接住：
      不支持是降级，不是报错。
   2. onContainerChange 在不支持的环境里是「同步抛」，不是返回一个 rejected promise，
      只挂 .catch() 接不住它。
   3. 切没切成，以 onContainerChange 回调里的实际状态为准，不能看 setContainerMode
      有没有 resolve——平台的接入提示专门强调了这条，这里照做。
   ======================================================== */
const SA_SIDES = ['top', 'right', 'bottom', 'left'];
let containerWaiters = [];
const rotateGo = document.getElementById('rotateGo');
const rotateText = rotateTip ? rotateTip.querySelector('.rot-text') : null;
const screenBtns = [document.getElementById('btnScreen'), document.getElementById('btnScreen2')];

// 安全区交给 CSS 去合并：所有内边距都写成 max(env(...), var(--sa-*))，谁大听谁的。
// 站外靠 env()，App 内靠容器给的数，两条路共用一套样式。
function applyContainerSafeArea(sa){
  for (const side of SA_SIDES){
    const v = Math.max(0, Math.round(Number(sa && sa[side]) || 0));
    container.safeArea[side] = v;
    document.documentElement.style.setProperty('--sa-' + side, v + 'px');
  }
}

// 唯一的事实源：容器报回来什么就是什么，自己想要什么不算数
function applyContainerState(st){
  if (!st || typeof st !== 'object') return;
  if (st.deviceType) container.deviceType = st.deviceType;
  if (st.orientation) container.orientation = st.orientation;
  if (typeof st.immersive === 'boolean') container.immersive = st.immersive;
  if (st.safeArea) applyContainerSafeArea(st.safeArea);
  onViewportChange();        // 安全区、可用尺寸、横竖屏，改哪一样都要重排一次
  refreshScreenBtns();
  const waiters = containerWaiters;
  containerWaiters = [];
  for (const w of waiters) w();
}

function containerMatches(req){
  return (req.orientation === undefined || container.orientation === req.orientation)
      && (req.immersive   === undefined || container.immersive   === req.immersive);
}

/* 「切没切成」的判据在这儿：容器回调里的实际状态。
   三种收场，且一定有一种会到：回调追上了（true）、请求当场被拒（false）、
   等够 ms 再主动读一次容器下结论。不留「永远没结论」这一档——
   否则一发石沉大海就能把转屏按钮永久钉在 disabled 上。 */
function watchContainerMode(req, ms){
  let settle;
  const promise = new Promise(resolve => { settle = resolve; });
  const probe = () => { if (containerMatches(req)) finish(true); };
  const timer = setTimeout(() => {
    const t = toySdk();
    if (!t || typeof t.getContainerState !== 'function'){ finish(false); return; }
    t.getContainerState().then(
      st => { applyContainerState(st); finish(containerMatches(req)); },
      () => finish(false));
  }, ms);
  function finish(ok){
    clearTimeout(timer);
    containerWaiters = containerWaiters.filter(w => w !== probe);
    settle(ok);                    // Promise 自带一次性，重复 finish 不会有第二个结论
  }
  containerWaiters.push(probe);
  return { promise, giveUp: () => finish(false) };
}

function requestContainerMode(req){
  if (!container.ok) return Promise.resolve(false);
  if (containerMatches(req)) return Promise.resolve(true);
  const t = toySdk();
  if (!t) return Promise.resolve(false);
  const key = JSON.stringify(req);
  if (container.pending === key) return Promise.resolve(false);   // 同一个请求别叠着发
  container.pending = key;
  // 先架好「等状态变过来」这一路，再下发请求：setContainerMode 只负责把请求送出去，
  // 它 resolve 了也不代表切成了（平台的接入提示专门强调这一条），所以不看它的返回值，
  // 只在它明确抛错时提前收摊——那种情况下状态肯定不会变了，没必要再等满。
  const watch = watchContainerMode(req, 1500);
  Promise.resolve().then(() => t.setContainerMode(req)).catch(() => watch.giveUp());
  return watch.promise.then(ok => {
    if (container.pending === key) container.pending = '';
    return ok;
  });
}

/* 沉浸模式在两种情况下开：真开打时（同样一块屏能多看见一截战场），
   以及玩家自己选了横屏时（平台的接入示例专门标着「横屏切换（手机请同时开启沉浸）」——
   App 那圈界面是竖版的，横过来不收掉就是纯占地方）。
   除此之外一律还回去：暂停 / 结算 / 回菜单时，B 站那圈界面就是玩家的退路，
   不能把人留在一个既看不见退出口、又不知道怎么出去的全屏里。
   横屏时的退路则是暂停页那颗「屏幕方向」——它切回竖屏的同时把界面还回来。 */
function syncContainerImmersive(){
  if (!container.ok) return;
  const playing = (state === 'play' || state === 'dying');
  requestContainerMode({ immersive: playing || container.orientation === 'landscape' });
}

/* 转屏做成按钮，不自动转：竖屏是这游戏正经支持的另一种版式，横还是竖该由玩家定。
   桌面端不给这个按钮——那儿没有「转屏」这回事。 */
function containerCanRotate(){
  return container.ok && container.deviceType !== 'desktop';
}
function refreshRotateCta(){
  if (!rotateGo || !rotateText) return;
  const can = containerCanRotate() && container.orientation === 'portrait';
  rotateGo.classList.toggle('hidden', !can);
  rotateText.textContent = can ? '横过来视野更宽 —— 点一下就转' : '竖屏也能玩 · 横过来视野更宽';
}
function refreshScreenBtns(){
  for (const b of screenBtns){
    if (!b) continue;
    b.classList.toggle('hidden', !containerCanRotate());
    b.textContent = '屏幕方向：' + (container.orientation === 'landscape' ? '横屏' : '竖屏');
  }
  refreshRotateCta();
}
// 方向和沉浸一次传齐：文档要求「需同时变更时请一次传齐」，分两发会让页面闪两下
function screenModeReq(orientation){
  return { orientation, immersive: orientation === 'landscape' };
}
function toggleScreenOrientation(btn){
  const want = container.orientation === 'landscape' ? 'portrait' : 'landscape';
  if (btn) btn.disabled = true;
  sfx('click');
  requestContainerMode(screenModeReq(want)).then(ok => {
    if (btn) btn.disabled = false;
    if (ok) hideRotateTip();            // 转成了，这条提示就没必要再占着屏幕
    else if (rotateText) rotateText.textContent = '这台设备转不过来 · 竖屏照样打得了';
  });
}
if (rotateGo) rotateGo.onclick = () => toggleScreenOrientation(rotateGo);
for (const b of screenBtns) if (b) b.onclick = () => toggleScreenOrientation(b);

/* 能力探测走 isSupport（问的是当前容器的能力集，不是 SDK 版本）：
   三个都在才打开这条路，缺一个就整条不走——半开的状态最难查。 */
function initContainer(){
  const t = toySdk();
  if (!t || typeof t.isSupport !== 'function') return;
  Promise.all([
    t.isSupport('onContainerChange'),
    t.isSupport('getContainerState'),
    t.isSupport('setContainerMode'),
  ]).then(all => {
    if (!all.every(Boolean)) throw new Error('container api unavailable');
    container.unsub = t.onContainerChange(applyContainerState);   // 这一行是同步抛的
    container.ok = true;
    return t.getContainerState();
  }).then(applyContainerState)
    .catch(() => {            // 任何一环不成立，就当没有这套 API，游戏本体一点不受影响
      container.ok = false;
      if (typeof container.unsub === 'function'){ try { container.unsub(); } catch (_){} }
      container.unsub = null;
    });
}

/* ========================================================
   音效 v2 —— 全部 Web Audio 实时合成，强调打击感
   ======================================================== */
let AC = null, master = null, comp = null;
let audioDead = false;
/* 这个函数在 touchstart 里被调用，所以它绝不能抛。
   iOS 对 AudioContext 最严（WebView 里可能直接构造失败），而一旦它抛出去，
   touchstart 后面的摇杆赋值和 preventDefault 全都不执行——表现就是
   「走不动、开不了枪、长按还弹出复制菜单」，且手机上看不到那行报错。
   没声音是可以接受的降级，输入断了不是。 */
function audioInit(){
  if (audioDead) return;
  try {
    if (AC){
      if (AC.state === 'suspended') AC.resume().catch(() => {});
      return;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor){ audioDead = true; return; }
    AC = new Ctor();
    comp = AC.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = .002; comp.release.value = .12;
    master = AC.createGain(); master.gain.value = 0.6;
    master.connect(comp); comp.connect(AC.destination);
  } catch (err){
    AC = null; audioDead = true;      // 别反复重试，静音继续玩
    noteTouchError(err);
  }
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
    case 'coin':                                   // 捡钱：两声短促的高频叮，别盖过枪声
      sweep('triangle', 1180, 1180, .05, .16);
      sweep('triangle', 1760, 1760, .07, .13, .04);
      break;
    case 'buy':                                    // 成交：低一档的两声，跟捡钱区分开
      sweep('triangle', 780, 780, .06, .2);
      sweep('triangle', 1170, 1170, .1, .16, .05);
      noiseHit(.05, 'bandpass', 3000, 4, .18);
      break;
    case 'nope':                                   // 钱不够 / 买不了
      sweep('square', 210, 150, .12, .2);
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

// 地面是一整张世界大图，跟着渲染倍率升清但要封顶：2 倍时已是 3840×2560（约 39MB），
// 再往上手机会吃不住。步进取 1 / 1.5 / 2，跨档才重建，拖窗口不会反复重画。
function syncGroundScale(){
  const cap = isPhone() ? 1.5 : 2;
  const s = Math.min(cap, Math.max(1, renderScale));
  const step = s >= 2 ? 2 : (s >= 1.5 ? 1.5 : 1);
  if (step === groundScale) return;
  groundScale = step;
  buildGround();
}
function buildGround(){
  const m = MAPS[mapIndex];
  const w = Math.round(WW * groundScale), h = Math.round(WH * groundScale);
  if (ground.width !== w || ground.height !== h){ ground.width = w; ground.height = h; }
  gctx.setTransform(w / WW, 0, 0, h / WH, 0, 0);   // 底下所有绘制照旧用世界坐标
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
// aim = 这把枪的自动锁敌半径，按弹速 × 存活时间算的实际射程取整，
// 免得锁上一个根本打不到的目标白烧子弹（喷火器只有一百多，火箭筒能锁满屏）。
const WEAPONS = [
  { name:'手枪',   icon:'pistol',  rate:270, auto:false, unlock:1,  infinite:true,  give:0,   aim:560 },
  { name:'马格南', icon:'magnum',  rate:430, auto:false, unlock:3,  infinite:false, give:60,  aim:640 },
  { name:'乌兹',   icon:'uzi',     rate:85,  auto:true,  unlock:5,  infinite:false, give:150, aim:600 },
  { name:'霰弹枪', icon:'shotgun', rate:620, auto:false, unlock:8,  infinite:false, give:40,  aim:420 },
  { name:'加特林', icon:'gatling', rate:55,  auto:true,  unlock:11, infinite:false, give:260, aim:620 },
  { name:'手雷',   icon:'grenade', rate:520, auto:false, unlock:13, infinite:false, give:12,  aim:330 },
  { name:'油桶',   icon:'barrel',  rate:420, auto:false, unlock:15, infinite:false, give:6,   aim:260 },
  { name:'喷火器', icon:'flamer',  rate:50,  auto:true,  unlock:17, infinite:false, give:300, aim:150 },
  { name:'火箭筒', icon:'rocket',  rate:750, auto:false, unlock:20, infinite:false, give:10,  aim:700 },
];
const WN = WEAPONS.length;

/* ---------- 自动瞄准 ----------
   玩家反馈：「瞄准的辐射范围有点窄，僵尸跟随后只能拉长距离后对冲射击」。
   根因是键盘经典模式里朝向 = 移动方向（见 collectLocalInput），跟在屁股后面的僵尸
   物理上打不到，只能跑开、转身、再迎着它们冲——一局下来全是这个来回。
   解法分两档，都只改「朝哪儿打」，不改伤害和射速：
     · 硬锁定：没有明确瞄准输入时（键盘经典 / 手机按住右半边不拖），
       朝范围内最近的威胁开火。于是可以边后退边打，对冲循环消失。
     · 软吸附：自己在瞄时（鼠标 / 拖动右摇杆），只在一个锥角内做修正，
       瞄准权还在玩家手里，但「差一点点擦过去」不再空枪——这就是那句「辐射范围窄」。 */
const AIM_KEY = 'zombie-world-aimassist';
let aimAssist = localStoreGet(AIM_KEY) !== 'off';   // 默认开
const AIM_CONE_MOUSE = .30;   // 鼠标吸附半角 ≈ 17°
const AIM_CONE_TOUCH = .45;   // 手指没鼠标准，给宽一点 ≈ 26°
const AIM_STICKY = 1.22;      // 已锁目标的加权优势，防止围殴时朝向乱跳
// 软吸附时油桶的加权优势。油桶的价值恰恰在于「旁边站着僵尸」，
// 要是准星压在油桶上还被旁边那只僵尸吸走，这一枪的大爆炸就白瞄了。
const AIM_BARREL_PREF = .72;
// 背后目标的距离加权上限。0.12 = 正后方的要比正前方的近 11% 才抢得过，
// 只用来在「几个一样近」时给个稳定偏好；贴脸的那只不管在哪个方向都优先——
// 会咬到你的就是它，为了「面朝前」放过它才是错的。
const AIM_BACK_BIAS = .12;
// 换靶之后的冷静期，以及冷静期里加倍的粘性。
// 「方向一换就乱打」有一半是连环换靶：A 被 B 顶掉、B 又被 C 顶掉，一秒里枪口甩三回。
const AIM_HOLD = .35;
const AIM_STICKY_HOLD = 2.2;
// 枪口转向的角速度上限（弧度/秒）。换靶不再是瞬移：中途打出去的子弹是「扫过去」的一串，
// 而不是这一发朝左下一发朝右——后者看起来就是纯粹的乱打。
const AIM_TURN = 13;

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
    particles, pickups, banners, hazards, coins, cam;
let wave, spawnQueue, devilQueue, spawnTimer, waveRest, score, kills,
    streak, multiplier, bestMulti, comboTimer, decayTimer, shake, time, frameN;
let gameOverTimer = null;

/* ---------- 多人战局：房主权威，客端只发输入/收快照 ---------- */
// 联机 = 局域网直连（p2p.js）：两台设备连同一个 WiFi，走 WebRTC DataChannel 点对点。
// 游戏数据全程 P2P；4 位房间号背后那个信令服务只负责接头，递完码就退场。
// 之前这里关着，是因为当时的联机要一台公网 WSS 服务器，而 Toy 只托管静态包、不跑 Node，
// 那个按钮点进去必然是「连接中断」。换成 P2P 之后不再依赖任何服务器，入口才重新打开。
// WSS 那套整个保留在 multiplayer.js / server/ / test/，哪天真有服务器了还能用。
const ONLINE_ENABLED = true;
const net = window.zombieNetwork;
const PLAYER_COLORS = ['#3f4652','#79d7ff','#ffcb55','#79e39f'];
let players = new Map();
let netMode = 'solo';          // solo | host | guest
let netInputs = new Map();
let localInputSeq = 0, localUltSeq = 0, localDesiredWeapon = null, lastInputSent = 0;
let localBuySeq = 0, localBuyId = '';        // 客机的购买请求：房主权威结账
let snapshotTick = 0, lastSnapshotSent = 0;
let netIdSeq = 0;              // 房主给实体发的稳定编号，客端靠它把前后两份快照里的同一只怪对上
// 客端本机预测历史：每帧记下「发出第 seq 条输入后自己在哪」，快照回来按房主处理到的 inputAt 对账
let localPosHistory = [], localCorrX = 0, localCorrY = 0;
let lastGuestSnapshotAt = 0;
let restoringSavedSession = false;

function makePlayer(member, slot){
  const spawns = [[-42,-42],[42,-42],[-42,42],[42,42]];
  const off = spawns[slot] || [0,0];
  return { id:member.id, name:member.name || ('玩家' + (slot+1)), slot,
             color:PLAYER_COLORS[slot % PLAYER_COLORS.length],
             x:WW/2+off[0], y:WH/2+off[1], r:13, hp:100, alive:true, fx:1, fy:0,
             walk: 0, moving: false, lastShot: 0, weapon: 0,
             target: null, aimLock: null, aimHold: 0,
             ammo: WEAPONS.map((w,i) => i ? 0 : Infinity),
             unlocked: WEAPONS.map((w,i) => i === 0), inv: 0, flash: 0,
             ultCharge:1, ultT:0, ultKills:0, swing:0, slashT:0,
             cash:0, lastBuySeq:0,
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

/* 自动瞄准的选靶。cone 传 null = 硬锁定（全向 360°，只对背后轻微降权）；
   传弧度 = 软吸附（超出这个半角的一律不碰，瞄准权留给玩家）。
   除了武器射程，还额外要求目标在屏幕内——锁一个自己都看不见的东西很惊悚。
   barrelMode 决定油桶进不进池：
     'off'    硬锁定的默认值——油桶不能把枪口从要咬你的僵尸身上抢走
     'prefer' 软吸附的默认值——你把准星压上去了就是明确意图，优先于附近的敌人
     'only'   按住 Shift 的油桶模式——只瞄油桶，敌人一概不看 */
function pickAimTarget(p, ax, ay, range, cone, barrelMode, sticky){
  const aimA = Math.atan2(ay, ax);
  // 用镜头矩形判可见，不用「以玩家为中心」——贴着地图边缘时镜头会被夹住，玩家并不在正中
  const M = 16;
  const vx0 = (cam ? cam.x : p.x - VW/2) + M, vy0 = (cam ? cam.y : p.y - VH/2) + M;
  const vx1 = vx0 + VW - M*2, vy1 = vy0 + VH - M*2;
  const stick = sticky || AIM_STICKY;
  const pool = [];
  const scan = (list, weight) => {
    for (const z of list){
      if (!z || z.hp <= 0) continue;
      if (z.fuse !== undefined) continue;        // 已经点着的油桶，再打一枪是浪费
      const zr = z.r || 0;
      if (z.x + zr < vx0 || z.x - zr > vx1 || z.y + zr < vy0 || z.y - zr > vy1) continue;
      const dx = z.x - p.x, dy = z.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > range + zr) continue;
      const rel = Math.atan2(dy, dx) - aimA;
      const off = Math.abs(Math.atan2(Math.sin(rel), Math.cos(rel)));   // 归一化到 ±π
      if (cone !== null && off > cone) continue;
      // 硬锁定按距离排，偏角只做轻微加权；软吸附反过来，谁更贴准星谁优先
      let score = cone === null
        ? d * (1 + AIM_BACK_BIAS * (off / Math.PI))
        : (off / cone) * 260 + d * .35;
      score *= weight;
      if (z === p.aimLock) score /= stick;
      pool.push({ z, score });
    }
  };
  if (barrelMode !== 'only'){ scan(zombies, 1); scan(devils, 1); scan(bosses, 1); }
  if (barrelMode === 'only') scan(barrels, 1);
  else if (barrelMode === 'prefer') scan(barrels, AIM_BARREL_PREF);
  if (!pool.length) return null;
  pool.sort((a, b) => a.score - b.score);
  // 石柱后面的不锁。子弹碰到柱子就没了，枪口却一直黏着一个根本打不到的目标——
  // 一边被咬一边对着石头开枪，这是「乱打」里最气人的一种。
  // 而且僵尸最爱堵在柱子后头，两个 bug 正好互相喂。
  // 用 blockingPillar（对圆是解析解，每个目标只 O(柱子数)）而不是 losBlocked 的采样射线：
  // 便宜到可以把整个候选池都验一遍，就不会出现「前几名全被挡、后面明明有能打的」。
  // 半径传 0：子弹本来就是按点算的（见 bullets 那里的 hitPillar(b.x, b.y, 0)）。
  for (let i = 0; i < pool.length; i++){
    if (!blockingPillar(p.x, p.y, pool[i].z.x, pool[i].z.y, 0)) return pool[i].z;
  }
  return null;      // 一个都打不到：朝向还给玩家，别对着石头开枪
}

/* 把朝向交给自动瞄准处理，返回 [ax, ay]。同时把锁到的目标挂在 p.aimLock 上给渲染用。 */
function applyAimAssist(p, ax, ay, dt){
  if (!aimAssist || !p || p.alive === false || p.hp <= 0){
    if (p){ p.aimLock = null; p.aimHold = 0; }
    return [ax, ay];
  }
  const step = AIM_TURN * (dt || 0);
  let cone = null;                                   // 默认硬锁定
  if (controlMode === 'mouse' && mouse.has) cone = AIM_CONE_MOUSE;
  if (tFire.id !== null && Math.hypot(tFire.vx, tFire.vy) > 14) cone = AIM_CONE_TOUCH;
  // 按住 Shift = 手动瞄油桶。键盘经典模式本来一点瞄准自由度都没有（朝向就是移动方向），
  // 这一颗键把枪口交回玩家手上：想引爆哪个油桶，按住就甩过去。
  const wantBarrel = !!keys['shift'];
  const barrelMode = wantBarrel ? 'only' : (cone === null ? 'off' : 'prefer');
  // 硬锁定的打分基准改用「当前枪口朝向」，不再用「这一帧的移动方向」。
  // 原来用移动方向：一按反方向键，所有目标的偏角权重整个翻面，锁着的那只被顶掉，
  // 枪口跳到另一只身上——玩家看到的就是那句「方向一换就乱打了」。
  // 用枪口朝向做基准，等于让「我正打着谁」自己占一票，走位怎么变都不再洗牌。
  // 软吸附不动：那时候 ax/ay 是玩家真的在瞄的方向，本来就该听他的。
  const rx = cone === null ? p.fx : ax, ry = cone === null ? p.fy : ay;
  p.aimHold = Math.max(0, (p.aimHold || 0) - (dt || 0));
  const t = pickAimTarget(p, rx, ry, WEAPONS[p.weapon].aim || 560, cone, barrelMode,
                          p.aimHold > 0 ? AIM_STICKY_HOLD : AIM_STICKY);
  if (t !== p.aimLock) p.aimHold = AIM_HOLD;         // 刚换过靶就进冷静期，别连着跳
  p.aimLock = t;
  if (!t) return [ax, ay];
  const dx = t.x - p.x, dy = t.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d <= .01) return [ax, ay];
  const want = Math.atan2(dy, dx);
  if (step <= 0) return [dx/d, dy/d];
  const cur = Math.atan2(p.fy, p.fx);
  let diff = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
  if (Math.abs(diff) > step) diff = (diff < 0 ? -step : step);
  const a = cur + diff;
  return [Math.cos(a), Math.sin(a)];
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
  localPosHistory = []; localCorrX = 0; localCorrY = 0;
  localBuySeq = 0; localBuyId = '';
  cam = { x: WW/2 - VW/2, y: WH/2 - VH/2 };
  zombies = []; devils = []; bosses = []; bullets = []; grenades = []; rockets = [];
  fireballs = []; particles = []; pickups = []; banners = []; hazards = []; coins = [];
  floaters.length = 0; shopWave = 0; closeShop();
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
    cool5: 8,                       // 毒池
    summonLeft: 5 + tier,           // 召唤次数上限，见下方召唤处
    navT:0 });                      // 寻路刷新计时，见 bossSteer
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
function weaponUsable(p, i){
  return !!p && i >= 0 && i < WN && p.unlocked[i] &&
         (WEAPONS[i].infinite || p.ammo[i] > 0);
}
function weaponReady(i){ return weaponUsable(player, i); }
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
// slot / t0 是给「点一下武器栏换枪」用的：左半边的手指先当摇杆，抬手时才结算是不是一次轻点
let tMove = { id:null, ox:0, oy:0, vx:0, vy:0, slot:-1, t0:0 };
let tFire = { id:null, ox:0, oy:0, vx:0, vy:0, slot:-1, t0:0 };
// 触屏诊断：iOS / WebView 上的触摸问题在本机复现不出来，只能让人在真机上打开这一层看
let touchDebug = false;
const touchDiag = { start:0, move:0, end:0, cancel:0, claimed:0, pd:0, live:0, err:'' };

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
/* 触摸链路上的第一条错误。手机没有控制台，这是唯一能带回来的线索。 */
function noteTouchError(err){
  if (touchDiag.err) return;
  try { touchDiag.err = String((err && err.message) || err).slice(0, 90); }
  catch (_) { touchDiag.err = 'unknown'; }
}
function releaseMove(){
  tMove = { id:null, ox:0, oy:0, vx:0, vy:0, slot:-1, t0:0 };
  stickL.style.display = 'none'; ghostL.classList.remove('fade');
}
function releaseFire(){
  tFire = { id:null, ox:0, oy:0, vx:0, vy:0, slot:-1, t0:0 };
  stickR.style.display = 'none'; ghostR.classList.remove('fade');
}
function resetSticks(){ releaseMove(); releaseFire(); }
/* 触点对账 —— 「iOS 端无法移动」的正解。
   每收到一个触摸事件，就拿 e.touches（此刻还按在屏幕上的全部手指）核一遍自己追踪的那两根
   还在不在，不在就当场放掉。为什么不能只靠 touchend / touchcancel：
   WKWebView（B 站 App 内嵌的就是它）里，宿主的滚动手势可以把一整串触摸整个收走，
   结束事件一个都不发。那样 tMove.id 就永远停在某个已经不存在的手指上，
   而后所有左半边的按下都被 `tMove.id === null` 这道门挡在外面——
   右半边照常开火（走的是另一个槽），左半边彻底没反应，症状正是「能打不能走」。
   对账让它在下一次触摸时自己恢复，不用重开页面。 */
function syncTouches(e){
  const live = e.touches;
  touchDiag.live = live.length;
  let hasMove = tMove.id === null, hasFire = tFire.id === null;
  for (let i = 0; i < live.length; i++){
    const id = live[i].identifier;
    if (id === tMove.id) hasMove = true;
    if (id === tFire.id) hasFire = true;
  }
  if (!hasMove) releaseMove();
  if (!hasFire) releaseFire();
}
// 落在按钮/浮层上的手指不算摇杆——否则点「换枪」会顺手朝右上角打一梭子
function onUiElement(t){
  const el = t.target;
  return !!(el && el.closest && el.closest('button, .screen, #netHud, #rotate, #shop'));
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
/* 三条铁律，全是为手机 / WebView 写的：
   1. 用下标遍历 TouchList，不用 for...of —— 迭代器在部分 WebKit 上没有，
      真抛起来是整个触屏输入一起没，而手机上根本看不到那行报错。
   2. 每个入口先 syncTouches(e) 对账，卡死的触点自己会恢复。
   3. 属于游戏的触摸一律 preventDefault（所以监听器必须 passive:false）：
      光靠 CSS 的 touch-action:none 在 WKWebView 里不保险，宿主的滚动视图照样能
      把手势抢走，一抢走就是 touchcancel，摇杆当场断。 */
addEventListener('touchstart', e => {
  touchDiag.start++;
  /* preventDefault 必须在最前面决定并执行。
     上一版把它放在末尾、还挂在 claimed 上，于是中间任何一处抛异常，
     这一下触摸就完全没被接管：iOS 立刻拿去做自己的手势（长按弹「拷贝」、
     滚动抢走后续 touchmove），摇杆当场废掉。
     现在的顺序是：先判断该不该吃 → 立刻吃掉 → 剩下的逻辑无论怎么炸都不影响它。 */
  let mine = false;
  try {
    if (state === 'play'){
      const pre = e.changedTouches;
      for (let i = 0; i < pre.length; i++){
        if (!onUiElement(pre[i])){ mine = true; break; }
      }
    }
  } catch (err){ noteTouchError(err); mine = (state === 'play'); }
  if (mine){
    touchDiag.claimed++;
    if (e.cancelable){ e.preventDefault(); touchDiag.pd++; }
  }
  try { touchStartBody(e); } catch (err){ noteTouchError(err); }
}, { passive:false });

function touchStartBody(e){
  hideTouchGuide();
  syncTouches(e);
  if (state !== 'play') return;
  audioInit();
  const list = e.changedTouches;
  for (let i = 0; i < list.length; i++){
    const t = list[i];
    if (onUiElement(t)) continue;
    const p = clientToCanvas(t.clientX, t.clientY);
    const slot = weaponSlotAt(p.x, p.y);
    const left = t.clientX < innerWidth/2;
    // 右半边（射击区）点武器栏立刻换枪，跟以前一样：那边的手指本来就不管走位。
    // 左半边不能这么干——手机竖屏时拇指自然落在屏幕下沿，那正好压着武器栏，
    // 于是每次按下都变成「换枪」，人一步都走不了。左边改成先当摇杆，抬手时再结算轻点
    if (slot >= 0 && !left && selectWeapon(slot)) continue;
    if (left && tMove.id === null){
      tMove = { id:t.identifier, ox:t.clientX, oy:t.clientY, vx:0, vy:0,
                slot, t0:performance.now() };
      placeStick(stickL, t.clientX, t.clientY); placeNub(nubL,0,0);
      ghostL.classList.add('fade');
    } else if (!left && tFire.id === null){
      tFire = { id:t.identifier, ox:t.clientX, oy:t.clientY, vx:0, vy:0,
                slot:-1, t0:performance.now() };
      placeStick(stickR, t.clientX, t.clientY); placeNub(nubR,0,0);
      ghostR.classList.add('fade');
    }
  }
}
addEventListener('touchmove', e => {
  touchDiag.move++;
  // 同样先吃后算：拖动一旦被 iOS 的滚动接管，后面就再也收不到 touchmove 了
  if ((tMove.id !== null || tFire.id !== null) && e.cancelable) e.preventDefault();
  try { touchMoveBody(e); } catch (err){ noteTouchError(err); }
}, { passive:false });

function touchMoveBody(e){
  syncTouches(e);
  const list = e.changedTouches;
  for (let i = 0; i < list.length; i++){
    const t = list[i];
    if (t.identifier === tMove.id){
      tMove.vx = t.clientX - tMove.ox; tMove.vy = t.clientY - tMove.oy;
      placeNub(nubL, tMove.vx, tMove.vy);
    } else if (t.identifier === tFire.id){
      tFire.vx = t.clientX - tFire.ox; tFire.vy = t.clientY - tFire.oy;
      placeNub(nubR, tFire.vx, tFire.vy);
    }
  }
}
// 左半边那根手指抬起来时结算：没拖动过、按得也短，才算「点了一下武器栏」
const TAP_SLOP = 14, TAP_MS = 400;
function releaseTouches(e){
  const list = e.changedTouches;
  for (let i = 0; i < list.length; i++){
    const t = list[i];
    if (t.identifier === tMove.id){
      if (e.type === 'touchend' && tMove.slot >= 0 && state === 'play' &&
          Math.hypot(tMove.vx, tMove.vy) < TAP_SLOP &&
          performance.now() - tMove.t0 < TAP_MS) selectWeapon(tMove.slot);
      releaseMove();
    }
    if (t.identifier === tFire.id) releaseFire();
  }
  syncTouches(e);      // 兜一遍：万一 changedTouches 漏了谁，对账还能把它捡回来
}
addEventListener('touchend', e => {
  touchDiag.end++;
  try { releaseTouches(e); } catch (err){ noteTouchError(err); resetSticks(); }
}, { passive:true });
// touchcancel 以前没接：系统手势/来电打断触摸时摇杆会卡在按下状态，人物一直往一个方向跑
addEventListener('touchcancel', e => {
  touchDiag.cancel++;
  // 被抢走时无论如何都要松开，否则人物会一直朝一个方向跑
  try { releaseTouches(e); } catch (err){ noteTouchError(err); }
  resetSticks();
}, { passive:true });
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
// 长按/右键菜单全局禁掉：手机上长按是开火，桌面鼠标模式下右键是移动指令，
// 两种情况都不该弹菜单。输入框放行，联机大厅要能右键粘贴。
addEventListener('contextmenu', e => {
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea')) return;
  e.preventDefault();
});

/* ---------- 碰撞（世界边界 + 石柱圆形体 + 油桶） ---------- */
// 两轮松弛：单轮是「推出 A 的同时被推进 B」，在成对石柱之间的窄缝里会左右弹一辈子，
// 看着就是卡在墙里出不来。第二轮把第一轮制造出来的新重叠再收一次。
function collide(o){
  for (let pass = 0; pass < 2; pass++){
    o.x = Math.max(o.r, Math.min(WW - o.r, o.x));
    o.y = Math.max(o.r, Math.min(WH - o.r, o.y));
    let moved = false;
    for (const p of pillars){
      const dx = o.x - p.x, dy = o.y - p.y;
      const min = o.r + p.r, d2 = dx*dx + dy*dy;
      if (d2 < min*min && d2 > 0){
        const d = Math.sqrt(d2);
        o.x = p.x + dx/d*min; o.y = p.y + dy/d*min;
        moved = true;
      }
    }
    for (const b of barrels){
      if (b.hp <= 0) continue;
      const dx = o.x - b.x, dy = o.y - b.y;
      const min = o.r + b.r, d2 = dx*dx + dy*dy;
      if (d2 < min*min && d2 > 0){
        const d = Math.sqrt(d2);
        o.x = b.x + dx/d*min; o.y = b.y + dy/d*min;
        moved = true;
      }
    }
    if (!moved) break;
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
// Boss 寻路。Boss 体型大、柱缝窄，只靠「卡住就切向绕」会钻进三根柱子围成的凹口出不来，
// 或者被玩家引到柱子背后顶一辈子。这里按体型把世界切成 20px 格子，标出圆能站下的格，
// 从目标附近的可站格做 BFS 得到距离场，Boss 沿距离递减走，并尽量直奔看得见的最远格子。
// 目标躲在 Boss 根本挤不进去的缝里时，种子会向外扩，Boss 就停在能到的最近处。
const NAV_CELL = 20, NAV_W = Math.ceil(WW/NAV_CELL), NAV_H = Math.ceil(WH/NAV_CELL);
const navWalkCache = new Map();
function navWalkable(r){
  const key = Math.ceil(r);
  let grid = navWalkCache.get(key);
  if (grid) return grid;
  grid = new Uint8Array(NAV_W*NAV_H);
  for (let j = 0; j < NAV_H; j++) for (let i = 0; i < NAV_W; i++){
    const x = (i+.5)*NAV_CELL, y = (j+.5)*NAV_CELL;
    grid[j*NAV_W+i] = x >= key && y >= key && x <= WW-key && y <= WH-key &&
      !hitPillar(x, y, key+2) ? 1 : 0;
  }
  navWalkCache.set(key, grid);
  return grid;
}
function navCellOf(x, y){
  const i = Math.max(0, Math.min(NAV_W-1, (x/NAV_CELL)|0));
  const j = Math.max(0, Math.min(NAV_H-1, (y/NAV_CELL)|0));
  return j*NAV_W + i;
}
function navBuild(o, tx, ty){
  const walk = navWalkable(o.r), N = NAV_W*NAV_H;
  const dist = o.navDist || (o.navDist = new Int16Array(N));
  const q = o.navQ || (o.navQ = new Int32Array(N));
  dist.fill(-1);
  let head = 0, tail = 0;
  for (let rad = o.r + 40; tail === 0 && rad <= 600; rad += 60){
    const i0 = Math.max(0, ((tx-rad)/NAV_CELL)|0), i1 = Math.min(NAV_W-1, ((tx+rad)/NAV_CELL)|0);
    const j0 = Math.max(0, ((ty-rad)/NAV_CELL)|0), j1 = Math.min(NAV_H-1, ((ty+rad)/NAV_CELL)|0);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++){
      const c = j*NAV_W + i;
      if (!walk[c] || dist[c] >= 0) continue;
      if (Math.hypot((i+.5)*NAV_CELL - tx, (j+.5)*NAV_CELL - ty) > rad) continue;
      dist[c] = 0; q[tail++] = c;
    }
  }
  while (head < tail){
    const c = q[head++], i = c % NAV_W, j = (c / NAV_W)|0, nd = dist[c] + 1;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++){
      if (!di && !dj) continue;
      const ni = i+di, nj = j+dj;
      if (ni < 0 || nj < 0 || ni >= NAV_W || nj >= NAV_H) continue;
      const n = nj*NAV_W + ni;
      if (!walk[n] || dist[n] >= 0) continue;
      if (di && dj && (!walk[j*NAV_W+ni] || !walk[nj*NAV_W+i])) continue;   // 不切柱角
      dist[n] = nd; q[tail++] = n;
    }
  }
}
// 返回朝向下一个路点的单位向量
function bossSteer(o, tx, ty, dt){
  const ddx = tx-o.x, ddy = ty-o.y, dd = Math.hypot(ddx, ddy) || 1;
  if (!blockingPillar(o.x, o.y, tx, ty, o.r)) return [ddx/dd, ddy/dd];
  o.navT = (o.navT || 0) - dt;
  if (o.navT <= 0 || !o.navDist){ o.navT = .4; navBuild(o, tx, ty); }
  const dist = o.navDist;
  // 自己所在格可能因为贴着柱子不算可站，就从周围 5×5 里挑距离最小的起步
  const c0 = navCellOf(o.x, o.y), i0 = c0 % NAV_W, j0 = (c0 / NAV_W)|0;
  let c = -1;
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++){
    const ni = i0+di, nj = j0+dj;
    if (ni < 0 || nj < 0 || ni >= NAV_W || nj >= NAV_H) continue;
    const n = nj*NAV_W + ni;
    if (dist[n] >= 0 && (c < 0 || dist[n] < dist[c])) c = n;
  }
  // 已经到了目标跟前（玩家贴着柱子时整条直线扫不过去），最后一步直接顶上去，交给碰撞滑开
  if (c < 0 || dist[c] === 0) return [ddx/dd, ddy/dd];
  let wx = (c % NAV_W + .5)*NAV_CELL, wy = (((c / NAV_W)|0) + .5)*NAV_CELL;
  for (let step = 0; step < 10 && dist[c] > 0; step++){
    const i = c % NAV_W, j = (c / NAV_W)|0;
    let next = -1;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++){
      const ni = i+di, nj = j+dj;
      if ((!di && !dj) || ni < 0 || nj < 0 || ni >= NAV_W || nj >= NAV_H) continue;
      const n = nj*NAV_W + ni;
      if (dist[n] >= 0 && dist[n] < dist[c] && (next < 0 || dist[n] < dist[next])) next = n;
    }
    if (next < 0) break;
    c = next;
    const cx = (c % NAV_W + .5)*NAV_CELL, cy = (((c / NAV_W)|0) + .5)*NAV_CELL;
    if (blockingPillar(o.x, o.y, cx, cy, o.r - 2)) break;
    wx = cx; wy = cy;
  }
  const wl = Math.hypot(wx-o.x, wy-o.y);
  return wl > 2 ? [(wx-o.x)/wl, (wy-o.y)/wl] : [ddx/dd, ddy/dd];
}
function losBlocked(x0, y0, x1, y1){
  const steps = Math.ceil(Math.hypot(x1-x0, y1-y0) / 18);
  for (let i = 1; i < steps; i++){
    if (hitPillar(x0 + (x1-x0)*i/steps, y0 + (y1-y0)*i/steps, 0)) return true;
  }
  return false;
}
/* 挡在 (x0,y0)→(x1,y1) 这条线段上、离起点最近的那根石柱；没有就返回 null。
   半径按「柱子 + 自己 + 一点余量」算：贴着柱面擦过去在观感上就是卡住，
   留出余量算出来的切线才真的走得开。绕障和「路通了没有」都用这一个判断，
   免得走的时候按 A 标准、判断的时候按 B 标准。 */
function blockingPillar(x0, y0, x1, y1, r){
  const vx = x1-x0, vy = y1-y0;
  const len2 = vx*vx + vy*vy;
  let best = null, bestT = Infinity;
  for (const p of pillars){
    const R = p.r + r;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x-x0)*vx + (p.y-y0)*vy) / len2)) : 0;
    const cx = x0 + vx*t - p.x, cy = y0 + vy*t - p.y;
    if (cx*cx + cy*cy >= R*R) continue;
    if (t < bestT){ bestT = t; best = p; }
  }
  return best;
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
    chk:.5 + Math.random()*.5, stuck:0,
    side:0,                                    // 当前绕行方向：0 = 没被挡，路是通的
    pref:Math.random() < .5 ? 1 : -1 };        // 正对柱心时往哪边绕，各人有各人的偏好
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
    // 打空了总得换一把，但不能一声不吭地变成手枪——那跟「枪自己乱切」是同一种体验
    p.weapon = 0;
    if (localFeedback){
      sfx('click');
      banners.push({ text:w.name + ' 弹药耗尽', sub:'已自动换回手枪', life:1.3, small:true });
    }
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
        /* 解锁不再无条件 p.weapon = i。原来那样写，正打着加特林的人会在某次击杀之后
           突然变成拿手雷——没按任何键，横幅也不一定看得见，感受就是「偶尔自动切枪」。
           只在手上这把已经用不了（空弹匣）或还是开局那把手枪时，才自动装上新枪。 */
        if (p.weapon === 0 || !weaponUsable(p, p.weapon)) p.weapon = i;
      }
      banners.push({ text:'解锁新武器',
        sub:WEAPONS[i].name + (player && player.weapon === i ? '！已装备' : '！点武器栏切换'),
        life:2.4 });
      sfx('unlock');
    }
  }
}
/* ---------- 局内货币 ----------
   只在这一局有效，死了归零；不进存档、不进排行榜。
   为什么是「局内」而不是跨局养成：跨局货币会当场把排行榜变成「谁刷得久」，
   而这个榜只收标准难度、比的正是同一套初始条件。详见 docs/currency-design-note.md。
   钱只买消耗品——枪的所有权归连击，钱买不到，否则「连击解锁武器」这条核心成长线当场作废。 */
const COIN_MAGNET = 100;     // 进这个半径就自己飞过来。手机上让人为了捡钱走进僵尸堆是坏设计
const COIN_MERGE = 26;       // 这么近的新币并进旧的：一发火箭炸死十只不该掉一地
const COIN_LIFE = 16;
function coinCap(){ return isPhone() ? 70 : 150; }
// 钱直接由击杀基础分折算，**不乘连击倍数**：倍数已经在管武器解锁了，
// 再让它管钱，后期会同时出现「枪全解锁」和「钱多到没处花」，两条线一起失重
function coinValue(baseScore){ return Math.max(1, Math.round(baseScore / 5)); }

function dropCoin(x, y, value, ownerId){
  for (const c of coins){
    if (c.age < .5 && Math.hypot(c.x-x, c.y-y) < COIN_MERGE){ c.v += value; c.pop = .18; return; }
  }
  if (coins.length >= coinCap()){
    // 屏幕上已经够多了就直接记账。钱一分不少，只是少了捡的那一下——
    // 低端机上宁可少一个实体，也不能让爆炸连锁把帧数打下去
    const owner = players.get(ownerId) || player;
    if (owner) owner.cash += value;
    return;
  }
  const a = Math.random()*6.28, sp = 40 + Math.random()*70;
  coins.push({ x, y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp, v:value, life:COIN_LIFE, age:0, pop:.18 });
}

/* 捡钱时在世界坐标上飘一个「+N」。纯本地，不进快照——
   它是反馈不是状态，让房主替客机算这个纯属浪费带宽。 */
const floaters = [];
function cashFloat(x, y, v){
  for (const f of floaters){
    if (f.life > .55 && Math.hypot(f.x-x, f.y-y) < 44){ f.v += v; f.pop = .16; return; }
  }
  if (floaters.length > 24) floaters.shift();
  floaters.push({ x, y, v, life:.85, pop:.16 });
}


/* ---------- 波间商店 ----------
   开在两波之间那 3 秒空白上：那段时间本来什么都没有，正好放一个决策点。
   只卖消耗品。单人时它会一直等你（点「开打」才继续），
   联机时不卡住对方——波间延长到 9 秒，两个人各买各的，时间到就开打。 */
const SHOP_HEAL = 35, SHOP_HEAL_COST = 40;
const SHOP_ULT_COST = 120, SHOP_ULT_MAX = 2;
const SHOP_REST_SOLO = 3, SHOP_REST_NET = 9;
// 弹药包的量跟地上捡的补给一致（give 的一半），价钱按解锁门槛走：
// 越靠后解锁的枪越贵。一条规则算完九把，调参时只有两个数要动
function ammoPackAmount(i){ return Math.ceil(WEAPONS[i].give * .5); }
function ammoPackCost(i){ return 20 + WEAPONS[i].unlock * 2; }

/* 货架。ok 这一位是唯一的成交判据——UI 置灰、结账、联机校验都读它，
   免得三处各判一遍条件，判漏一处就是「钱扣了东西没到」。 */
function shopCatalog(p){
  if (!p) return [];
  const list = [];
  for (let i = 0; i < WN; i++){
    if (!p.unlocked[i] || WEAPONS[i].infinite) continue;
    list.push({ id:'ammo' + i, kind:'ammo', weapon:i, name:WEAPONS[i].name,
                sub:'弹药 +' + ammoPackAmount(i), cost:ammoPackCost(i),
                have:'现有 ' + p.ammo[i], full:false });
  }
  list.push({ id:'heal', kind:'heal', weapon:-1, name:'医疗包',
              sub:'生命 +' + SHOP_HEAL, cost:SHOP_HEAL_COST,
              have:'现有 ' + Math.ceil(p.hp) + ' HP', full:p.hp >= 100 });
  list.push({ id:'ult', kind:'ult', weapon:-1, name:'无双充能',
              sub:'立刻攒满一次', cost:SHOP_ULT_COST,
              have:'现有 ' + p.ultCharge + ' 次', full:p.ultCharge >= SHOP_ULT_MAX });
  for (const it of list) it.ok = !it.full && p.cash >= it.cost;
  return list;
}

/* 结账。返回 true 才算真的买成了 */
function buyItem(p, id){
  if (!p || typeof id !== 'string') return false;
  const it = shopCatalog(p).find(x => x.id === id);
  if (!it || !it.ok) return false;
  p.cash -= it.cost;
  if (it.kind === 'heal') p.hp = Math.min(100, p.hp + SHOP_HEAL);
  else if (it.kind === 'ult') p.ultCharge = Math.min(SHOP_ULT_MAX, p.ultCharge + 1);
  else p.ammo[it.weapon] += ammoPackAmount(it.weapon);
  return true;
}

let shopOpen = false, shopWave = 0, shopCountLabel = '', shopCashShown = -1;
const shopEl = document.getElementById('shop');
const shopGrid = document.getElementById('shopGrid');
const shopCashEl = document.getElementById('shopCash');
const shopFootEl = document.getElementById('shopFoot');
const btnShopGo = document.getElementById('btnShopGo');

function syncShopDom(){
  // state 不参与：商店是浮在 play 之上的一层，不是一个「界面」。
  // 这样联机时它不会把战局暂停掉，单人时也不用为了开商店切状态机
  const show = shopOpen && state === 'play';
  if (shopEl) shopEl.classList.toggle('hidden', !show);
}
function openShop(){
  if (shopOpen) return;
  shopOpen = true;
  resetSticks();                 // 手指状态清掉，免得从商店回来人还在往一个方向跑
  shopCountLabel = '';
  // 客机无权开波，把「开打」收起来，免得点了没反应
  if (btnShopGo) btnShopGo.classList.toggle('hidden', netMode === 'guest');
  renderShop();
  syncShopDom();
}
function closeShop(){
  if (!shopOpen) return;
  shopOpen = false;
  syncShopDom();
}
function renderShop(){
  if (!shopGrid || !player) return;
  shopCashShown = player.cash;
  if (shopCashEl) shopCashEl.textContent = player.cash;
  const items = shopCatalog(player);
  shopGrid.innerHTML = items.map(it =>
    '<button class="shop-item' + (it.full ? ' full' : (it.ok ? '' : ' poor')) + '"' +
    ' data-id="' + it.id + '"' + (it.ok ? '' : ' disabled') + '>' +
    '<b>' + it.name + '</b><i>' + it.sub + '</i>' +
    '<u>' + it.have + '</u>' +
    '<em>' + (it.full ? '已满' : it.cost) + '</em></button>').join('');
}
function shopFootTick(){
  if (!shopOpen || !shopFootEl) return;
  // 单人时商店一直等你，所以不显示倒计时；联机不能卡住对方，显示还剩几秒
  const label = multiplayerActive()
    ? '下一波 ' + Math.max(0, Math.ceil(waveRest)) + ' 秒'
    : '买完点「开打」';
  if (label !== shopCountLabel){ shopCountLabel = label; shopFootEl.textContent = label; }
}
/* 每帧检查该不该开/关商店。房主和客机走的是不同的更新函数，
   所以这一份判断两边都要调——客机的 wave / spawnQueue 来自快照，同样准 */
function tickShop(){
  const clear = spawnQueue <= 0 && devilQueue <= 0 &&
                zombies.length === 0 && devils.length === 0 && bosses.length === 0;
  if (!clear){ closeShop(); return false; }
  // shopWave 记的是「已经为哪一波开过商店」，所以只在真正开的时候写。
  // 别在上面那个分支里也写一遍——那样每波打到一半就把标记刷成当前波，
  // 等清场时 shopWave 已经等于 wave，商店永远不会弹
  if (wave > 0 && shopWave !== wave){ shopWave = wave; openShop(); }
  // 波清了金币还可能在飞过来，钱包一变就重排一次货架（十来个按钮，只在波间跑）
  if (shopOpen && player && player.cash !== shopCashShown) renderShop();
  shopFootTick();
  return true;
}
function tickFloaters(dt){
  for (let i = floaters.length-1; i >= 0; i--){
    const f = floaters[i];
    f.life -= dt;
    if (f.pop > 0) f.pop -= dt;
    f.y -= dt * 26;
    if (f.life <= 0) floaters.splice(i, 1);
  }
}
function requestBuy(id){
  if (!player || !shopOpen) return;
  if (netMode === 'guest'){
    // 客机把请求塞进输入里让房主权威结账；本地先乐观扣一次，下一份快照会纠正
    localBuySeq++; localBuyId = id;
  }
  if (buyItem(player, id)){ sfx('buy'); renderShop(); }
  else sfx('nope');
}
if (shopGrid) shopGrid.addEventListener('click', e => {
  const btn = e.target && e.target.closest ? e.target.closest('.shop-item') : null;
  if (btn && btn.dataset.id) requestBuy(btn.dataset.id);
});
if (btnShopGo) btnShopGo.onclick = () => {
  if (netMode === 'guest') return;     // 客机无权开波，按钮那边已经藏起来了
  waveRest = 0;                        // 下一帧 update 就会 startWave
  closeShop();
  sfx('click');
};

function killReward(x, y, baseScore, ownerId){
  kills++; streak++; comboTimer = 9; updateMulti();
  score += baseScore * multiplier;
  dropCoin(x, y, coinValue(baseScore), ownerId);
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
  // 立刻拍一张成绩快照：reset() 会清掉 score/wave，等玩家点「上传」时早就归零了
  lastRun = { score, wave, kills, bestMulti, diff:DIF().key,
              solo:netMode === 'solo', submitted:false };
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
    if (player){ player.target = null; player.aimLock = null; }
    return {
      seq:++localInputSeq, mx:0, my:0,
      ax:player ? player.fx : 1, ay:player ? player.fy : 0,
      fire:false,
      weapon:localDesiredWeapon ?? (player ? player.weapon : 0),
      ultSeq:localUltSeq, buySeq:localBuySeq, buy:localBuyId
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
  // 自动瞄准放在最后：上面各模式先给出「玩家的意图方向」，这里再修正或接管
  [ax, ay] = applyAimAssist(player, ax, ay, dt);
  return { seq:++localInputSeq, mx, my, ax, ay, fire:firing,
    weapon:localDesiredWeapon ?? player.weapon,
    ultSeq:localUltSeq, buySeq:localBuySeq, buy:localBuyId };
}

function updatePlayerFromInput(p, input, dt, now){
  if (!p) return;
  const data = input || {};
  if (Number.isSafeInteger(data.seq) && data.seq >= 0) p.inputAt = data.seq;
  const ultSeq = Number(data.ultSeq) || 0;
  const shouldActivateUlt = ultSeq > p.lastUltSeq;
  if (shouldActivateUlt) p.lastUltSeq = ultSeq;
  // 客机的购买请求：只认序号递增的那一次，重发的输入不会重复扣钱。
  // buyItem 自己会校验解锁、余额、是否已满，所以这里不需要再信任对面发来的任何东西
  const buySeq = Number(data.buySeq) || 0;
  if (buySeq > (p.lastBuySeq || 0)){
    p.lastBuySeq = buySeq;
    if (typeof data.buy === 'string' && data.buy.length <= 12) buyItem(p, data.buy);
  }
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

  tickFloaters(dt);
  if (tickShop()){
    // 单人时商店一直等玩家，倒计时冻住；联机不能卡住对方，照常走
    if (!(shopOpen && netMode === 'solo')) waveRest -= dt;
    if (waveRest <= 0){
      closeShop();
      startWave();
      waveRest = multiplayerActive() ? SHOP_REST_NET : SHOP_REST_SOLO;
    }
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
    /* 卡住检测：看的是「自己这半秒真的挪了多远」，不是「跟玩家的距离有没有拉近」。
       原来那版用距离，两头都会错：玩家绕着圈跑，明明在走的僵尸被判成卡住；
       玩家迎面走过来，真卡死的僵尸反而一直判成正常。 */
    z.chk -= dt;
    if (z.chk <= 0){
      z.chk = .5;
      const moved = z.px === undefined ? Infinity : Math.hypot(z.x - z.px, z.y - z.py);
      // 已经贴上去开咬的不算卡住——它就该站着不动，
      // 判成卡住会让它顺手把玩家脚边的油桶点了
      if (d > z.r + target.r + 10 && moved < z.spd * .5 * .35){
        z.stuck++;
        if (z.stuck >= 3){ z.side = -z.side || z.pref; z.stuck = 1; }   // 这边绕不出去，换一边
      } else z.stuck = 0;
      z.px = z.x; z.py = z.y;
    }
    /* 绕障：对着挡路的那根柱子算切线，直接朝「刚好擦过柱边」的方向走。
       老办法是往侧面推一个分量，最多偏 49°，而且每 2 秒强制换一次边；
       绕过一根 r=64 的柱子要走 3 秒以上，于是永远绕不完，僵尸就在柱背面来回蹭——
       玩家往柱子后一站就是无限安全收割，正是「卡在墙体后过不来」。
       现在边一旦选定就守住，直到线真的通了才松开。 */
    const blocker = blockingPillar(z.x, z.y, target.x, target.y, z.r + 4);
    let sx, sy;
    if (blocker){
      const bx = blocker.x - z.x, by = blocker.y - z.y;
      const L = Math.hypot(bx, by) || 1;
      const R = blocker.r + z.r + 4;
      if (!z.side){
        // 第一次被挡：往玩家所在的那一侧绕，路更短；正对柱心时用自己的偏好
        const cross = bx*dy - by*dx;
        z.side = cross > 0 ? 1 : (cross < 0 ? -1 : z.pref);
      }
      const spread = Math.asin(Math.min(1, R / Math.max(L, R))) + .12;
      const a = Math.atan2(by, bx) + z.side * spread;
      sx = Math.cos(a); sy = Math.sin(a);
    } else {
      z.side = 0;                                   // 路通了，下次再被挡重新选边
      sx = dx/d + Math.cos(z.wob)*.25;
      sy = dy/d + Math.sin(z.wob)*.25;
    }
    // 卡久了就砸挡路的油桶：围墙会自己炸开，堆桶挡门不再是永久解
    if (z.stuck >= 2){
      for (const bl of barrels){
        if (bl.hp > 0 && bl.fuse === undefined &&
            Math.hypot(bl.x - z.x, bl.y - z.y) < bl.r + z.r + 6){
          bl.fuse = .4; sfx('click'); break;
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
      // 原来 Boss 只会直冲，玩家躲到石柱后面它就顶着柱子推一辈子，波次永远结束不了，
      // 只剩它的召唤源源不断送分送金币。现在走 bossSteer 寻路绕柱。
      const [sx, sy] = bossSteer(b, target.x, target.y, dt);
      b.x += sx * T.spd * spdMul * dt; b.y += sy * T.spd * spdMul * dt;
      b.walk += dt * 6 * spdMul;
      collide(b);
      b.cool1 -= dt; b.cool2 -= dt; b.cool3 -= dt; b.cool4 -= dt; b.cool5 -= dt;
      // 召唤增援（博士召唤精英）。场上数量上限只能限住同屏怪数，限不住总量——
      // 躲在大 Boss 进不去的石柱缝里（博士体型过不了窄口）照样能无限刷分刷金币，
      // 所以每只 Boss 还有总召唤次数，用完就只剩本体和其他技能。
      if (S.summon && b.summonLeft > 0 && b.cool1 <= 0 && zombies.length < 26){
        b.summonLeft--;
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

  // ----- 金币 -----
  // 掉出来先散一下，然后被 100px 内最近的活人吸走。阻尼按 dt 走指数，
  // 不用「每帧乘 0.92」那种写法——那个在 30fps 和 120fps 上手感完全不同
  const coinDamp = Math.exp(-3.2 * dt);
  for (let i = coins.length-1; i >= 0; i--){
    const c = coins[i];
    c.age += dt; c.life -= dt;
    if (c.pop > 0) c.pop -= dt;
    if (c.life <= 0){ coins.splice(i, 1); continue; }
    const info = nearestLivingPlayer(c);
    if (info){
      const t = info.player, d = info.distance || 1;
      if (d < t.r + 10){
        t.cash += c.v;
        if (t === player){ cashFloat(c.x, c.y, c.v); sfx('coin'); }
        coins.splice(i, 1); continue;
      }
      // 吸附半径随金币变旧而变大（100 → 300）。
      // 不这么做的话，风筝流玩家会把一地钱扔在身后自己蒸发掉，
      // 「钱是怎么来的」就变成一件说不清的事，货币系统当场失去意义
      const reach = COIN_MAGNET * (1 + (1 - c.life/COIN_LIFE) * 2);
      if (d < reach){
        const pull = 260 + 900 * Math.max(0, 1 - d/reach);
        c.vx += (t.x-c.x)/d * pull * dt;
        c.vy += (t.y-c.y)/d * pull * dt;
      }
    }
    c.vx *= coinDamp; c.vy *= coinDamp;
    c.x += c.vx*dt; c.y += c.vy*dt;
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

/* ---------- 快照瘦身 ----------
   原来 buildNetworkState 是把整个实体的标量字段一股脑倒过去，于是像僵尸的绕障状态
   （spd / wob / chk / stuck / side / pref / px / py）和 BOSS 的五个技能冷却
   这些**纯房主侧的 AI 状态**，全都按 17 位浮点跨网络发了一遍——客机一个都不看。
   实测：一只僵尸 330 字节、一个 BOSS 560 字节，而真正被渲染的字段不到一半。

   现在按类型走白名单 + 定点数。白名单是照着「客机那边到底谁会读它」一个字段一个字段
   对出来的（渲染函数 + 客机本地要跑的 collide / pickAimTarget），所以下面每组都注了出处。
   **加字段时必须同时改这里**，否则新字段到不了客机，表现是「房主看得见客机看不见」。

   数字是缩放倍数：10 = 保留 1 位小数，1000 = 3 位，0 = 原样（布尔/字符串/整数）。
   坐标 1 位小数够了——世界 1920×1280，半个像素的差别看不出来；
   朝向给 3 位，那是单位向量，再糙转身会一格一格的。
   nid 是稳定编号，客机靠它把前后两份快照里的同一只怪对上来做平滑（见 netSmoothCarry）。 */
function packNet(o, spec){
  if (spec.nid === 0 && o.nid === undefined) o.nid = ++netIdSeq;
  const out = {};
  for (const key in spec){
    const v = o[key];
    if (v === undefined) continue;
    const scale = spec[key];
    out[key] = (scale && typeof v === 'number' && Number.isFinite(v))
      ? Math.round(v * scale) / scale : v;
  }
  return out;
}
const NET_SPEC = {
  // drawZombie: x y fx fy hit walk ｜ pickAimTarget: x y r hp ｜ 血条: hp maxhp
  zombie:   { nid:0, x:10, y:10, r:0, hp:0, maxhp:0, walk:10, fx:1000, fy:1000, hit:100 },
  devil:    { nid:0, x:10, y:10, r:0, hp:0, maxhp:0, walk:10, fx:1000, fy:1000, hit:100 },
  // drawBoss 还要 mode / rage 决定姿态与配色；tier 用来在客机侧还原 T（技能表）
  boss:     { nid:0, x:10, y:10, r:0, hp:0, maxhp:0, walk:10, fx:1000, fy:1000, hit:100,
              boss:0, tier:0, mode:0, rage:0 },
  // 弹体：客机会按速度外推到下一份快照，所以 vx/vy 必须给
  bullet:   { nid:0, x:10, y:10, vx:10, vy:10, len:0, life:100, max:100, flame:0 },
  grenade:  { nid:0, x:10, y:10, vx:10, vy:10 },
  rocket:   { nid:0, x:10, y:10, vx:10, vy:10 },
  fireball: { nid:0, x:10, y:10, vx:10, vy:10, green:0 },
  // 油桶：客机的 collide 会读 x/y/r/hp，pickAimTarget 会读 fuse（点着了就不锁）
  barrel:   { x:10, y:10, r:0, hp:0, fuse:100 },
  pickup:   { x:10, y:10, type:0, life:100 },
  // 金币不外推：飞行只有零点几秒，25Hz 的跳变看不出来，不值得为它多发两个字段
  coin:     { x:10, y:10, life:100, pop:100 },
  hazard:   { x:10, y:10, r:10, warn:100, life:100 },
  banner:   { text:0, sub:0, life:100, big:0, small:0 },
  // 玩家：drawPlayer + 名牌血条 + 客机本地的 collide / 武器栏 / 商店 / 无双按钮
  player:   { id:0, name:0, slot:0, color:0, x:10, y:10, r:0, hp:10, alive:0,
              fx:1000, fy:1000, walk:10, moving:0, weapon:0, flash:100, inv:100,
              ultT:100, ultCharge:0, ultKills:0, swing:10, lastShot:0,
              cash:0, lastUltSeq:0,
              inputAt:0 },               // 房主处理到客机第几条输入，客机拿来对账（见 applyNetworkState）
};
const packList = (list, spec) => list.map(o => packNet(o, spec));


function networkPlayerState(p){
  const out = packNet(p, NET_SPEC.player);
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
    zombies:packList(zombies, NET_SPEC.zombie),
    devils:packList(devils, NET_SPEC.devil),
    bosses:packList(bosses, NET_SPEC.boss),
    bullets:packList(bullets, NET_SPEC.bullet),
    grenades:packList(grenades, NET_SPEC.grenade),
    rockets:packList(rockets, NET_SPEC.rocket),
    barrels:packList(barrels, NET_SPEC.barrel),
    fireballs:packList(fireballs, NET_SPEC.fireball),
    pickups:packList(pickups, NET_SPEC.pickup),
    coins:packList(coins, NET_SPEC.coin),
    hazards:packList(hazards, NET_SPEC.hazard),
    banners:packList(banners, NET_SPEC.banner)
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
  // 记下上一份快照里每个活动实体「当前画在哪」，新快照按编号对上后从这里平滑过去
  const smoothPrev = new Map();
  const remember = (tag, list) => {
    for (const e of list || []) if (e && e.nid !== undefined) smoothPrev.set(tag + e.nid, e);
  };
  remember('z', zombies); remember('d', devils); remember('b', bosses);
  remember('u', bullets); remember('g', grenades); remember('r', rockets); remember('f', fireballs);
  for (const p of players.values()) if (p !== previousLocal) smoothPrev.set('p' + p.id, p);
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
    p.cash = networkNumber(raw.cash, 0, 0, 1e9);
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
      // 对账：房主给的位置对应它处理到的第 inputAt 条输入，拿它和本机发那条输入时的预测比，
      // 差多少就在接下来几帧里慢慢补上。原来是每份快照都把人往（落后一个往返的）权威位置
      // 拽 35%，跑动时每 50ms 往回一顿，自己的角色就一卡一卡的。
      const authX = player.x, authY = player.y;
      const past = localPosHistory.find(h => h.seq === player.inputAt);
      player.x = previousLocal.x; player.y = previousLocal.y;
      const ex = past ? authX - past.x : authX - player.x;
      const ey = past ? authY - past.y : authY - player.y;
      const err = Math.hypot(ex, ey);
      if (err > 140){                          // 被击退/复活之类的大跳变，直接对齐
        player.x = authX; player.y = authY;
        localPosHistory = []; localCorrX = localCorrY = 0;
      } else if (err > (past ? 2 : 24)){       // 没有历史可比时权威位置本身就落后，死区放宽
        localCorrX = ex; localCorrY = ey;
      } else {
        localCorrX = localCorrY = 0;
      }
      localPosHistory = localPosHistory.filter(h => h.seq >= player.inputAt);
      if (localTarget) player.target = localTarget;
    } else {
      player.target = null;
    }
    if (previousLocal && Number.isFinite(previousLocal.cash) && player.cash > previousLocal.cash){
      cashFloat(player.x, player.y - 10, player.cash - previousLocal.cash);
      sfx('coin');
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
  coins = array('coins', 200);
  hazards = array('hazards', 300).map(h => {
    h.r = networkNumber(h.r, 0, 0, 500);
    h.warn = networkNumber(h.warn, 0, 0, .85);
    h.life = networkNumber(h.life, 0, 0, 1000);
    return h;
  });
  banners = array('banners', 40);
  const carry = (tag, list) => { for (const e of list) netSmoothCarry(smoothPrev.get(tag + e.nid), e); };
  carry('z', zombies); carry('d', devils); carry('b', bosses);
  carry('u', bullets); carry('g', grenades); carry('r', rockets); carry('f', fireballs);
  for (const p of players.values()) if (p !== player) netSmoothCarry(smoothPrev.get('p' + p.id), p);
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

/* ---------- 客端平滑：快照之间的移动外推 + 误差追赶 ----------
   _ax/_ay/_aw 是最近一份快照里的权威位置和走路动画相位，_at 是那份快照的房主时间，
   _vx/_vy/_vw 是按前后两份快照估出来的速度（弹体直接用自带的 vx/vy）。 */
function netSmoothCarry(prev, e){
  e._ax = e.x; e._ay = e.y; e._aw = Number.isFinite(e.walk) ? e.walk : undefined; e._at = time;
  const ownV = Number.isFinite(e.vx) && Number.isFinite(e.vy);
  e._vx = ownV ? e.vx : 0; e._vy = ownV ? e.vy : 0; e._vw = 0;
  if (!prev || prev._at === undefined) return;
  const span = time - prev._at;
  if (span > .001 && span < .5){
    if (!ownV){ e._vx = (e._ax - prev._ax)/span; e._vy = (e._ay - prev._ay)/span; }
    if (e._aw !== undefined && prev._aw !== undefined) e._vw = Math.max(0, (e._aw - prev._aw)/span);
  } else if (!ownV){
    e._vx = prev._vx || 0; e._vy = prev._vy || 0; e._vw = prev._vw || 0;
  }
  // 画面位置沿用上一帧画出来的地方，之后每帧再追向权威位置；离太远（瞬移/冲锋撞墙）就直接对齐
  if (Math.hypot(prev.x - e._ax, prev.y - e._ay) < 120){
    e.x = prev.x; e.y = prev.y;
    if (e._aw !== undefined && Number.isFinite(prev.walk)) e.walk = prev.walk;
  }
}
function netSmoothStep(e, dt){
  if (e._at === undefined) return;
  const ahead = Math.min(.2, Math.max(0, time - e._at));   // 最多外推 0.2 秒，断流时别让怪自己走穿墙
  const k = Math.min(1, dt*12);
  if (ahead < .2){ e.x += e._vx*dt; e.y += e._vy*dt; }
  e.x += (e._ax + e._vx*ahead - e.x)*k;
  e.y += (e._ay + e._vy*ahead - e.y)*k;
  if (e._aw !== undefined){
    e.walk += e._vw*dt;
    e.walk += (e._aw + e._vw*ahead - e.walk)*k;
  }
}

function updateGuest(dt, now){
  time += dt; frameN++;
  if (!player) return;
  tickFloaters(dt);
  tickShop();
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
    // 把对账出来的误差摊到约 0.15 秒里补，历史记录一起平移，免得下一份快照重复补
    if (localCorrX || localCorrY){
      const k = Math.min(1, dt*8), cx = localCorrX*k, cy = localCorrY*k;
      player.x += cx; player.y += cy; localCorrX -= cx; localCorrY -= cy;
      for (const h of localPosHistory){ h.x += cx; h.y += cy; }
      if (Math.abs(localCorrX) + Math.abs(localCorrY) < .3) localCorrX = localCorrY = 0;
      collide(player);
    }
  }
  localPosHistory.push({ seq:input.seq, x:player.x, y:player.y });
  if (localPosHistory.length > 120) localPosHistory.shift();
  if (now - lastInputSent >= 33){
    lastInputSent = now;
    net.sendInput(input);
  }
  // 快照每秒只来 20 份：两份之间按速度外推，再把画面位置平滑地追向外推后的权威位置
  for (const list of [zombies, devils, bosses, bullets, grenades, rockets, fireballs]){
    for (const e of list) netSmoothStep(e, dt);
  }
  for (const p of players.values()) if (p !== player) netSmoothStep(p, dt);
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
// 金币：一枚会转的小圆片。用椭圆宽度做转动，不另开一张贴图
function drawCoin(c, k){
  const bob = Math.sin(time*5 + k.x*.06)*2;
  if (k.life < 3 && Math.floor(time*6)%2) return;      // 快消失了就闪，提示该去捡
  const x = k.x, y = k.y + bob;
  const spin = Math.abs(Math.cos(time*3.4 + k.x*.05));
  const w = Math.max(1.6, 7 * spin) * (1 + (k.pop > 0 ? k.pop*1.6 : 0));
  shadow(c, x, k.y + 6, 6);
  c.save();
  c.strokeStyle = OUT; c.lineWidth = 1.4;
  c.beginPath(); c.ellipse(x, y, w, 7, 0, 0, 7);
  c.fillStyle = '#e8a91e'; c.fill(); c.stroke();
  if (w > 3.2){
    c.beginPath(); c.ellipse(x, y, w*.55, 4.2, 0, 0, 7);
    c.fillStyle = '#ffd75e'; c.fill();
  }
  c.restore();
}
// 捡钱的「+N」。纯本地反馈，不进快照
function drawFloaters(c){
  c.textAlign = 'center';
  c.lineJoin = 'round';
  for (const f of floaters){
    const a = Math.min(1, f.life / .35);
    c.globalAlpha = a;
    c.font = '900 ' + Math.round(15 + (f.pop > 0 ? f.pop*26 : 0)) + 'px sans-serif';
    c.lineWidth = 4; c.strokeStyle = '#23211d';
    c.strokeText('+' + f.v, f.x, f.y);
    c.fillStyle = '#ffd75e';
    c.fillText('+' + f.v, f.x, f.y);
  }
  c.globalAlpha = 1;
}
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

/* 触屏诊断浮层。
   「iOS 端无法移动」这类问题本机复现不出来，全靠别人的真机；
   没有这一层，回来的反馈只能是「就是动不了」，等于没有信息。
   打开后左上角实时显示触点账目，让人截一张图就能定位到底断在哪一环：
     · live 一直是 0        → 触摸事件根本没进来（容器把手势整个吞了）
     · start 涨、move 不涨  → 拖动被宿主的滚动接管了
     · cancel 在涨          → 手势被中途抢走，正是摇杆断的那一下
     · pd < claim           → preventDefault 没生效（事件不可取消），治不住抢手势
     · move.id 一直非空但 vec 不动 → 触点卡死了，对账那一步没兜住
     · 顶上出现 ERR 那一行 → 直接就是答案，不用再猜（2026-08-21 加） */
function drawTouchDiag(){
  if (!touchDebug) return;
  const L = [
    'live ' + touchDiag.live + '  start ' + touchDiag.start + '  move ' + touchDiag.move,
    'end ' + touchDiag.end + '  cancel ' + touchDiag.cancel +
      '  claim ' + touchDiag.claimed + '  pd ' + touchDiag.pd,
    'move id ' + tMove.id + '  vec ' + Math.round(tMove.vx) + ',' + Math.round(tMove.vy) +
      '  slot ' + tMove.slot,
    'fire id ' + tFire.id + '  vec ' + Math.round(tFire.vx) + ',' + Math.round(tFire.vy),
    'win ' + innerWidth + '×' + innerHeight + '  view ' + VW + '×' + VH +
      '  scale ' + viewScale.toFixed(2),
    'touch ' + isTouch + '  coarse ' + coarsePointer + '  pts ' + (navigator.maxTouchPoints || 0),
    'ctn ' + (container.ok ? container.orientation + (container.immersive ? '+imm' : '') : 'off') +
      '  dev ' + (container.deviceType || '-') + '  sa ' + container.safeArea.top + '/' +
      container.safeArea.right + '/' + container.safeArea.bottom + '/' + container.safeArea.left,
  ];
  // 出过错就顶在最上面：计数正常但功能没反应时，答案基本都在这一行
  const firstErr = touchDiag.err || window.__zwFirstError;
  if (firstErr) L.unshift('ERR ' + firstErr);
  ctx.save();
  ctx.textAlign = 'left';
  ctx.font = 'bold 12px monospace';
  ctx.fillStyle = 'rgba(8,10,13,.82)';
  ctx.fillRect(8, 44, 286, L.length*15 + 10);
  ctx.fillStyle = '#7dffb0';
  for (let i = 0; i < L.length; i++) ctx.fillText(L[i], 14, 60 + i*15);
  ctx.restore();
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
  // 钱包。刚进账时放大一下，不然一个静止的数字很容易被无视
  const cashPop = floaters.length ? Math.max(0, floaters[floaters.length-1].life - .55) : 0;
  ctx.font = 'bold ' + Math.round(17 + cashPop*22) + 'px sans-serif';
  ctx.strokeText('金币 ' + (player.cash|0), VW-18, 84);
  ctx.fillStyle = '#ffd75e';
  ctx.fillText('金币 ' + (player.cash|0), VW-18, 84);
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
  drawTouchDiag();
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
  // 商店开着时不画倒计时：单人时它是冻住的，画出来就是个不会动的数字
  if (!shopOpen && spawnQueue<=0 && devilQueue<=0 &&
      zombies.length===0 && devils.length===0 && bosses.length===0 && wave>0){
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
  // 地面 + 血迹（只画可视区域）。源矩形按地面位图的像素算，目标仍是世界坐标
  const gs = ground.width / WW;
  ctx.drawImage(ground, (cx|0)*gs, (cy|0)*gs, VW*gs, VH*gs, cx|0, cy|0, VW, VH);
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

  // 平面层：拾取物 + 金币
  for (const p of pickups) drawPickup(ctx, p);
  for (const k of coins) drawCoin(ctx, k);
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

  // 自动瞄准：给锁上的目标套一个直角括号，玩家要能一眼看出枪口跟着谁。
  // 油桶用橙色，跟锁敌的黄色分开——按住 Shift 甩过去时要立刻看出「瞄的是桶不是人」
  if (state === 'play' && player && player.aimLock && player.aimLock.hp > 0){
    const z = player.aimLock, R = (z.r || 12) + 7, c = R * .55;
    ctx.strokeStyle = barrels.includes(z) ? 'rgba(255,140,46,.95)' : 'rgba(255,210,62,.92)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (const [sx, sy] of [[-1,-1],[1,-1],[-1,1],[1,1]]){
      ctx.moveTo(z.x + sx*R, z.y + sy*R - sy*c);
      ctx.lineTo(z.x + sx*R, z.y + sy*R);
      ctx.lineTo(z.x + sx*R - sx*c, z.y + sy*R);
    }
    ctx.stroke();
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
  drawFloaters(ctx);     // 「+N」跟着世界坐标走，所以要在镜头变换里画
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

/* ========================================================
   排行榜（Toy JS SDK）
   Toy 没有实时联机能力，"多人感"走这条：异步竞争。
   平台侧规则（照文档）：榜位固定 1/2/3、周期 all/month/week/day、
   分数为整数且服务端只保留历史最高分（重复上报不会把成绩刷低）、
   读榜游客可读、上报需登录、是否上榜必须看 ranked 字段而不是 score。
   ======================================================== */
const RANK_SCORE = 1, RANK_WAVE = 2;           // 榜1=得分，榜2=坚守波数（榜3 预留）
const RANK_MAX = 16777215;                     // 平台分数上限
const RANK_AUTO_KEY = 'zombie-world-rank-auto';
function toySdk(){ return (typeof window !== 'undefined' && window.toy) || null; }
function rankReady(){
  const t = toySdk();
  return !!(t && typeof t.getRankList === 'function' && typeof t.submitScore === 'function');
}
// 只收标准难度：轻松打得轻松、硬核敌人更多分更高，混进同一个榜这榜就没意义了
function rankEligible(diffKey){ return diffKey === 'normal'; }
function clampScore(v){ return Math.max(0, Math.min(RANK_MAX, Math.round(Number(v) || 0))); }
function rankErrText(e){
  const raw = (e && (e.message || e.msg)) || '';
  const clean = String(raw).replace(/^\[ToySDK\]\s*/, '').trim();
  return clean || '排行榜暂时不可用，稍后再试';
}
let lastRun = null;        // 结算快照：reset() 会清空全局 score/wave，不能等玩家点按钮时才去读

/* ---------- 结算页：上传成绩 ---------- */
const overRank = document.getElementById('overRank');
const btnUpload = document.getElementById('btnUpload');
function setOverRank(text, kind){
  overRank.textContent = text || '';
  overRank.dataset.kind = kind || '';
  overRank.classList.toggle('hidden', !text);
}
function setUploadBtn(mode, label){
  btnUpload.dataset.mode = mode || '';
  if (label) btnUpload.textContent = label;
  btnUpload.classList.toggle('hidden', !mode);
}
async function uploadRun(){
  const t = toySdk();
  if (!t || !lastRun) throw new Error('没有可上传的成绩');
  await t.submitScore({ board:RANK_SCORE, score:clampScore(lastRun.score) });
  await t.submitScore({ board:RANK_WAVE,  score:clampScore(lastRun.wave) });
  lastRun.submitted = true;
  localStoreSet(RANK_AUTO_KEY, 'on');      // 同意过一次，之后就自动上传，不再每局点一下
  try { return await t.getMyRank({ board:RANK_SCORE, period:'all' }); }
  catch (_) { return null; }
}
async function doUpload(){
  btnUpload.disabled = true;
  setOverRank('正在上传成绩…');
  try {
    const mine = await uploadRun();
    setUploadBtn('view', '🏆 查看排行榜');
    setOverRank(mine && mine.ranked
      ? '已上榜 · 总榜第 ' + mine.rank + ' 名（' + Number(mine.score).toLocaleString() + ' 分）'
      : '成绩已上传', 'ok');
  } catch (e){
    setOverRank(rankErrText(e), 'error');
    setUploadBtn('upload', '🏆 重试上传');   // 多半是没登录，留着按钮让人重来
  } finally {
    btnUpload.disabled = false;
  }
}
function refreshOverRank(){
  setOverRank('');
  setUploadBtn('');
  if (!lastRun || !lastRun.solo || !rankReady()) return;   // 站外环境：一个字都不提排行榜
  if (!rankEligible(lastRun.diff)){
    const name = (DIFFS.find(d => d.key === lastRun.diff) || {}).name || '当前';
    setOverRank('本局是「' + name + '」难度 · 排行榜只统计标准难度');
    return;
  }
  if (lastRun.submitted){ setUploadBtn('view', '🏆 查看排行榜'); return; }
  if (localStoreGet(RANK_AUTO_KEY) === 'on') doUpload();
  else setUploadBtn('upload', '🏆 上传成绩到排行榜');
}
btnUpload.onclick = () => {
  if (btnUpload.dataset.mode === 'view'){ openRank('over'); sfx('click'); }
  else doUpload();
};

/* ---------- 排行榜页 ---------- */
const rankStatus = document.getElementById('rankStatus');
const rankListEl = document.getElementById('rankList');
const rankMine = document.getElementById('rankMine');
let rankBoard = RANK_SCORE, rankPeriod = 'all', rankToken = 0, rankReturn = 'menu';
function rankUnit(){ return rankBoard === RANK_WAVE ? ' 波' : ' 分'; }
function rankRow(item, unit){
  const li = document.createElement('li');
  const no = Number(item && item.rank) || 0;
  li.className = 'rank-row' + (no >= 1 && no <= 3 ? ' top' + no : '');
  const cNo = document.createElement('span');
  cNo.className = 'no'; cNo.textContent = no || '-';
  const face = document.createElement('img');
  face.className = 'face'; face.alt = ''; face.loading = 'lazy';
  if (item && item.avatar) face.src = item.avatar;
  face.onerror = () => { face.style.visibility = 'hidden'; };
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = (item && item.nickname) || '幸存者';   // 别人的昵称，只走 textContent
  const pt = document.createElement('span');
  pt.className = 'pt';
  pt.textContent = (Number(item && item.score) || 0).toLocaleString() + unit;
  li.appendChild(cNo); li.appendChild(face); li.appendChild(who); li.appendChild(pt);
  return li;
}
async function loadRank(){
  const token = ++rankToken;                 // 连点页签时，只认最后一次请求的结果
  rankListEl.innerHTML = '';
  rankMine.classList.add('hidden');
  rankStatus.classList.remove('hidden');
  rankStatus.dataset.kind = '';
  rankStatus.textContent = '加载中…';
  const t = toySdk();
  if (!t){
    rankStatus.textContent = '当前环境没有 Toy SDK，排行榜只在 B站 里可用';
    rankStatus.dataset.kind = 'error';
    return;
  }
  const unit = rankUnit();
  let list;
  try {
    list = await t.getRankList({ board:rankBoard, period:rankPeriod, limit:50 });
  } catch (e){
    if (token !== rankToken) return;
    rankStatus.textContent = rankErrText(e);
    rankStatus.dataset.kind = 'error';
    return;
  }
  if (token !== rankToken) return;
  if (!Array.isArray(list) || !list.length){
    rankStatus.textContent = '这个榜还空着，来当第一个';
    return;
  }
  rankStatus.classList.add('hidden');
  const rows = [];
  for (const item of list){
    const li = rankRow(item, unit);
    rows.push(li);
    rankListEl.appendChild(li);
  }
  // 我的排名：游客调这个会失败，属于正常情况，静默略过
  try {
    const mine = await t.getMyRank({ board:rankBoard, period:rankPeriod });
    if (token !== rankToken || !mine || !mine.ranked) return;
    rankMine.textContent = '我的排名：第 ' + mine.rank + ' 名 · ' +
      (Number(mine.score) || 0).toLocaleString() + unit;
    rankMine.classList.remove('hidden');
    const hit = rows[mine.rank - 1];
    if (hit && Number(list[mine.rank - 1] && list[mine.rank - 1].score) === Number(mine.score)){
      hit.classList.add('me');
    }
  } catch (_) { /* 未登录 */ }
}
function bindRankTabs(id, key, set){
  const box = document.getElementById(id);
  if (!box || !box.querySelectorAll) return;    // 排行榜是可选功能，缺元素也不该拖垮整个脚本
  const tabs = box.querySelectorAll('.rank-tab');
  tabs.forEach(btn => {
    btn.onclick = () => {
      tabs.forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      set(btn.dataset[key]);
      sfx('click');
      loadRank();
    };
  });
}
bindRankTabs('rankBoardTabs', 'board', v => { rankBoard = Number(v) || RANK_SCORE; });
bindRankTabs('rankPeriodTabs', 'period', v => { rankPeriod = v || 'all'; });
function openRank(from){
  rankReturn = from || 'menu';
  setScreen('rank');
  loadRank();
}
const btnRank = document.getElementById('btnRank');
if (rankReady()) btnRank.classList.remove('hidden');
btnRank.onclick = () => { openRank('menu'); sfx('click'); };
document.getElementById('btnRankBack').onclick = () => { setScreen(rankReturn); sfx('click'); };

/* ---------- 界面切换 ---------- */
const screens = { menu:document.getElementById('menu'), help:document.getElementById('help'),
                  pause:document.getElementById('pause'), over:document.getElementById('over'),
                  mapsel:document.getElementById('mapsel'), online:document.getElementById('online'),
                  rank:document.getElementById('rank') };
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
  syncShopDom();                                      // 暂停/结算时把商店收起来，回来再放出去
  syncContainerImmersive();                           // 开打进沉浸、停下就还回去（App 内才有效）
  if (touchPlay){ refreshSwapBtn(); layoutTouchUI(); }
  if (s === 'over') refreshOverRank();
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
/* ---------- 自动瞄准开关（记在本地） ---------- */
const aimBtns = [document.getElementById('btnAim'), document.getElementById('btnAim2')];
function refreshAimBtns(){
  const label = '自动瞄准：' + (aimAssist ? '开' : '关');
  for (const b of aimBtns) if (b) b.textContent = label;
}
function toggleAim(){
  aimAssist = !aimAssist;
  localStoreSet(AIM_KEY, aimAssist ? 'on' : 'off');
  if (player) player.aimLock = null;
  refreshAimBtns();
  sfx('click');
}
aimBtns.forEach(b => { if (b) b.onclick = toggleAim; });
refreshAimBtns();
/* 触屏诊断开关。默认关，也不记进 localStorage——它是排查用的，不该有人下次进来还开着 */
const btnTouchDbg = document.getElementById('btnTouchDbg');
if (btnTouchDbg){
  const refresh = () => { btnTouchDbg.textContent = '触屏诊断：' + (touchDebug ? '开' : '关'); };
  btnTouchDbg.onclick = () => {
    touchDebug = !touchDebug;
    if (touchDebug){ touchDiag.start = touchDiag.move = touchDiag.end = 0;
                     touchDiag.cancel = touchDiag.claimed = touchDiag.pd = 0; }
    refresh(); sfx('click');
  };
  refresh();
}
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
/* ---------- 画质（分辨率倍率） ---------- */
const btnQuality = document.getElementById('btnQuality');
const savedQuality = QUALITIES.findIndex(q => q.key === localStoreGet(QUALITY_KEY));
if (savedQuality >= 0) qualityIndex = savedQuality;
function refreshQualityBtn(){
  const q = QUALITIES[qualityIndex];
  // 顺带把实际渲染倍率写出来，玩家能直接看出这一档到底有没有生效
  btnQuality.textContent = '画质：' + q.name + '（' + renderScale.toFixed(1) + '×）';
}
btnQuality.onclick = () => {
  qualityIndex = (qualityIndex + 1) % QUALITIES.length;
  localStoreSet(QUALITY_KEY, QUALITIES[qualityIndex].key);
  fit();                       // 立刻按新档重建后备缓冲区
  refreshQualityBtn();
  sfx('click');
};
refreshQualityBtn();
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
  const gs = ground.width / WW;
  const srcH = WW * 126 / 224;
  c.drawImage(ground, 0, 0, WW*gs, srcH*gs, 0, 0, 224, 126);
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
const onlineConsent = document.getElementById('onlineConsent');
const btnCreateRoom = document.getElementById('btnCreateRoom');
const btnJoinP2P = document.getElementById('btnJoinP2P');
const onlineJoin = document.getElementById('onlineJoin');
const roomCodePanel = document.getElementById('roomCodePanel');
const roomCodeStepText = document.getElementById('roomCodeStep');
const roomCodeShow = document.getElementById('roomCodeShow');
const roomCodeBig = document.getElementById('roomCodeBig');
const roomCodeEnter = document.getElementById('roomCodeEnter');
const roomCodeInput = document.getElementById('roomCodeInput');
const roomPanel = document.getElementById('roomPanel');
const roomPlayers = document.getElementById('roomPlayers');
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
function setOnlineStatus(text, kind){
  onlineStatus.textContent = text;
  onlineStatus.dataset.kind = kind || '';
}
function setRoomRequestBusy(busy){
  roomRequestBusy = !!busy;
  btnCreateRoom.disabled = roomRequestBusy;
  btnJoinP2P.disabled = roomRequestBusy;
}

/* ---------- 信令：两台手机之间人肉互发一次「码」 ----------
   这是没有信令服务时的兜底路径：offer/answer 只能靠玩家自己发给对方
   （微信、面对面念都行）。三个阶段：
     host      房主出邀请码，同时等着粘对方的应答码
     guest-in  客机先粘房主的邀请码
     guest-out 客机产出应答码，发回去等房主粘贴
   连上以后（房里有 2 个人）这一整块就收起来，换成正常的房间面板。 */
/* ---------- 6 位房间码 ----------
   走房间服务器（`multiplayer.js` + `server/`）：房主开房拿一个 6 位码，
   队友输进去就进同一间房，2~4 人，不要求在同一个网络里。
   码的字母表去掉了 I O 0 1（见 server.js 的 ROOM_CODE_ALPHABET），念出来不会错。 */
const ROOM_CODE_CHARS = /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g;
const ROOM_CAPACITY = 4;
let roomStage = '';
function setRoomStage(stage){
  roomStage = stage;
  roomCodePanel.classList.toggle('hidden', !stage);
  roomCodeShow.classList.toggle('hidden', stage !== 'host');
  roomCodeEnter.classList.toggle('hidden', stage !== 'guest');
  onlineJoin.classList.toggle('hidden', !!stage || !!net.room);
  if (stage === 'host'){
    roomCodeStepText.textContent = '把这个房间码告诉队友，让他在「我加入」里输进去';
  } else if (stage === 'guest'){
    roomCodeStepText.textContent = '输入房主给你的 6 位房间码';
    roomCodeInput.value = '';
    setTimeout(() => { try { roomCodeInput.focus(); } catch (_) {} }, 30);
  } else {
    roomCodeBig.textContent = '······';
  }
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
  // 人齐了就把房间码那一块收起来，码已经没用了
  if (room && room.players.length >= 2 && roomStage) setRoomStage('');
  onlineJoin.classList.toggle('hidden', !!room || !!roomStage);
  roomPanel.classList.toggle('hidden', !room);
  if (!room) return;
  const capacity = room.capacity || 2;
  roomMeta.textContent = (net.isHost ? '你是房主 · ' : '') +
    '房间码 ' + (room.code || '——') + ' · ' +
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
  netCount.textContent = net.room.players.length + '/' + (net.room.capacity || 2);
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
  setRoomStage('');
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

const btnOnline = document.getElementById('btnOnline');
if (ONLINE_ENABLED) btnOnline.classList.remove('hidden');
btnOnline.onclick = () => {
  if (!ONLINE_ENABLED) return;
  setScreen('online');
  renderRoom();
  sfx('click');
};
btnCreateRoom.onclick = async () => {
  if (roomRequestBusy) return;
  if (!onlineConsentGranted()) return;
  audioInit();
  setRoomRequestBusy(true);
  setRoomStage('host');
  roomCodeBig.textContent = '······';
  setOnlineStatus('正在连接服务器…');
  try {
    const room = await net.createRoom(currentName(), ROOM_CAPACITY);
    roomCodeBig.textContent = room.code;
    setOnlineStatus('房间码 ' + room.code + ' —— 告诉队友，他输进去就能进来。', 'ok');
  } catch (error){
    setRoomStage('');
    setOnlineStatus(error.message || '开房失败，稍后再试', 'error');
  } finally {
    setRoomRequestBusy(false);
  }
};
btnJoinP2P.onclick = () => {
  if (roomRequestBusy) return;
  if (!onlineConsentGranted()) return;
  audioInit();
  setRoomStage('guest');
  setOnlineStatus('输入房主给你的 6 位房间码。');
};
// 只留房间码字母表里的字符并自动转大写：
// 服务端是大小写敏感的，让人因为输了小写而进不去太蠢了
roomCodeInput.addEventListener('input', () => {
  const clean = roomCodeInput.value.toUpperCase().replace(ROOM_CODE_CHARS, '').slice(0, 6);
  if (clean !== roomCodeInput.value) roomCodeInput.value = clean;
});
roomCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnRoomCodeGo.click(); });
const btnRoomCodeGo = document.getElementById('btnRoomCodeGo');
btnRoomCodeGo.onclick = async () => {
  if (roomRequestBusy) return;
  const code = roomCodeInput.value.toUpperCase().replace(ROOM_CODE_CHARS, '');
  if (code.length !== 6){ setOnlineStatus('房间码是 6 位字母数字。', 'error'); return; }
  setRoomRequestBusy(true);
  setOnlineStatus('正在加入 ' + code + '…');
  try {
    await net.joinRoom(code, currentName());
    setRoomStage('');
    setOnlineStatus('已进房，等房主开局。', 'ok');
  } catch (error){
    setOnlineStatus(error.message || '加入失败', 'error');
  } finally {
    setRoomRequestBusy(false);
  }
};
document.getElementById('btnRoomCodeCancel').onclick = () => {
  setRoomStage('');
  net.disconnect(true);
  setOnlineStatus('已取消。');
  renderRoom();
};
btnReady.onclick = () => {
  audioInit();
  const self = net.room && net.room.players.find(p => p.id === net.selfId);
  if (self) net.setReady(!self.ready);
};
btnRoomStart.onclick = () => { audioInit(); net.startMatch(); };
btnRoomMap.onclick = () => { mapReturnScreen = 'online'; setScreen('mapsel'); sfx('click'); };
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
  if (net.room) net.room.capacity = Number(message.capacity)||2;
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
/* 「联机服务器连接中断。」这句话等于没说。浏览器不让脚本看到 WebSocket 握手的
   HTTP 状态码，所以这里绕一下：连不上时去探一次 /healthz——
   探得通说明服务器活着，那就是握手被拒（最常见的是从 file:// 或别的端口打开，
   来源不在白名单里）；探不通才是网络或服务器的问题。 */
async function explainNetFailure(){
  let base;
  try {
    const u = new URL(net.url);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = u.pathname.replace(/\/ws$/, '/healthz');
    base = u.toString();
  } catch (_) { return '联机服务器连不上。'; }
  try {
    const r = await fetch(base, { cache:'no-store' });
    if (r.ok){
      const here = location.origin;
      return '服务器是通的，但它拒绝了这个页面的来源（' + here + '）。'
           + '把游戏从正式地址打开就好——本地直接双击 index.html 是连不上的。';
    }
    return '联机服务器没有正常应答（' + r.status + '）。';
  } catch (_) {
    return '连不上联机服务器。检查一下网络；也可能是服务器正好在重启。';
  }
}
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
    // 先给一句立刻能看见的，再去探因、把话说具体
    setOnlineStatus('联机服务器连不上，正在看是什么原因…', 'error');
    refreshNetHud('断线');
    explainNetFailure().then(msg => {
      if (net.connected) return;                 // 探的过程中又连上了就别覆盖
      setOnlineStatus(msg, 'error');
    }).catch(() => {});
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
// 会话恢复只对 WSS 后端有意义。局域网直连的 hasSavedSession() 恒为 false：一条 P2P 管道
// 随页面而生随页面而灭，刷新就等于断线，没有能被「恢复」的东西——与其假装能恢复，不如直说。
if (ONLINE_ENABLED && net.hasSavedSession()){
  restoringSavedSession = true;
  onlineConsent.checked = true;
  setScreen('online');
  setOnlineStatus('正在恢复上一次联机会话…');
  net.resumeSavedSession().catch(error => {
    setOnlineStatus(error.message || '会话恢复失败，请重新加入房间。', 'error');
  });
} else if (!ONLINE_ENABLED){
  net.disconnect(true);          // 清掉可能残留的会话凭证，别让它在后台重连
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
initContainer();         // 容器能力是异步探的，探到了它会自己再排一次版
requestAnimationFrame(loop);
