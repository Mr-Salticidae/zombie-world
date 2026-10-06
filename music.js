/* 背景音乐：Web Audio 实时合成的芯片音乐，不带任何音频文件。

   五段原创曲：主菜单 / 战斗（随波次加强）/ BOSS / 波间商店 / 阵亡收尾（结算页接主菜单曲的安静版）。

   曲子写成谱面文本（下面的 SONG_DEFS），这里只负责演奏：
   · 一小节 16 格（4/4 拍的十六分音符），空格分隔。
     旋律轨：音名（A4、C#5、Bb3）= 起一个音，'-' = 延长上一个音，'.' = 休止。
     鼓轨：每格若干字母，k 底鼓 · s 军鼓 · h 闭镲 · o 开镲 · t 嗵鼓 · c 吊镲，'.' = 空。
     琶音和贝斯大多按和弦现生成（arp / bass8 …），省得把同一个型手抄八遍。
   · 每个声部有一个「档位」（level）。场景给出当前档位，档位以内的声部才发声——
     战斗曲就是靠这个随波次一层层加厚：贝斯 + 底鼓 → 加军鼓镲片 → 加琶音 → 加主旋律 → 加低八度加倍。
   · 调度用「提前排程」：游戏主循环每帧调一次 tick()，把未来 LOOKAHEAD 秒内的音符
     按 AudioContext 的时钟排好。不另开 setInterval——后台标签页里主循环停了，音乐也跟着停；
     回来时落后超过 RESYNC 秒就整体跳到当前时刻，不会把攒下的音一口气补出来。
   · 换曲只在小节线上换；BOSS 登场、阵亡这类急事在下一拍就换。档位变化在小节线上生效，
     速度变化在整首曲子回到开头时生效（中途变速听着像卡顿）。
   · 音乐走自己的总线直连输出，不进音效那条压缩器：否则机枪一响，音乐就被压得一抽一抽的。
   · 这个文件不碰 DOM、不读游戏状态。场景由 script.js 的 musicScene() 决定，这里只管演奏，
     所以能在 Node 里用假的 AudioContext 跑单测（test/music.test.js），也能离线渲染成 WAV 试听
     （tools/music-preview.html）。 */
(function (global){
  'use strict';

  const STEPS = 16;          // 一小节 16 格
  const LOOKAHEAD = 0.15;    // 提前排程秒数：要盖过一帧最长 33ms 的间隔，还要留余量
  const RESYNC = 0.25;       // 落后超过这么多秒就整体跳到当前时刻（后台标签页、长卡顿）
  // 音乐总线音量。实测（10 秒密集交火 vs 战斗曲档位 3）：0.55 时音乐 -20.8 LUFS、音效 -19.6 LUFS，
  // 几乎平起平坐、抢枪声；降到 0.3（-5.3 dB）让战斗曲落在约 -26 LUFS，比交火低 6 LU 以上。
  // 没枪声的场景（菜单、商店、结算）再由 SCENES[].gain 抬回来
  const VOLUME = 0.3;
  const DUCK = 0.35;         // 暂停时压到这么多
  const FADE = 0.4;          // 开关、压低的音量过渡秒数

  /* ---------- 音高 ---------- */
  const PITCH = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  function midiOf(name){
    const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
    if (!m) return null;
    return 12 * (Number(m[3]) + 1) + PITCH[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }
  function freqOf(midi){ return 440 * Math.pow(2, (midi - 69) / 12); }

  /* ---------- 谱面解析 ---------- */
  function tokens(text){
    const tok = String(text).trim().split(/\s+/);
    if (tok.length !== STEPS) throw new Error('一小节要 ' + STEPS + ' 格，这里是 ' + tok.length + ' 格：' + text);
    return tok;
  }
  // 旋律轨 → [{ step, len, midi }]
  function parseMelody(text){
    const out = [];
    tokens(text).forEach((t, i) => {
      if (t === '.') return;
      if (t === '-'){
        const last = out[out.length - 1];
        if (last && last.step + last.len === i) last.len++;   // 只延长紧挨着的那个音；休止后的 '-' 仍是休止
        return;
      }
      const midi = midiOf(t);
      if (midi === null) throw new Error('认不出的音名「' + t + '」：' + text);
      out.push({ step:i, len:1, midi });
    });
    return out;
  }
  // 鼓轨 → [{ step, hit }]
  const DRUM_HITS = 'kshotc';
  function parseDrums(text){
    const out = [];
    tokens(text).forEach((t, i) => {
      if (t === '.') return;
      for (const ch of t){
        if (!DRUM_HITS.includes(ch)) throw new Error('认不出的鼓「' + ch + '」：' + text);
        out.push({ step:i, hit:ch });
      }
    });
    return out;
  }

  /* ---------- 和弦与生成型 ---------- */
  const CHORDS = {
    Am:['A','C','E'], F:['F','A','C'], C:['C','E','G'], G:['G','B','D'], E:['E','G#','B'],
    Em:['E','G','B'], D:['D','F#','A'], B:['B','D#','F#'],
    Dm:['D','F','A'], Bb:['Bb','D','F'], A:['A','C#','E'],
  };
  // 从根音往上摞成原位三和弦（midi 升序）
  function chordMidis(chord, oct){
    const names = CHORDS[chord];
    if (!names) throw new Error('没定义的和弦 ' + chord);
    const out = [];
    for (const n of names){
      let m = midiOf(n + oct);
      while (out.length && m <= out[out.length - 1]) m += 12;
      out.push(m);
    }
    return out;
  }
  const fill = (n, f) => Array.from({ length:n }, (_, i) => f(i));
  // 十六分音符琶音：1-3-5-8-5-3 往返
  const arp = oct => chord => {
    const [a, b, c] = chordMidis(chord, oct);
    const cyc = [a, b, c, a + 12, c, b];
    return fill(STEPS, i => ({ step:i, len:1, midi:cyc[i % cyc.length] }));
  };
  // 八分音符琶音：1-3-5-3（商店曲用，轻一点）
  const arp8 = oct => chord => {
    const [a, b, c] = chordMidis(chord, oct);
    const cyc = [a, b, c, b];
    return fill(8, i => ({ step:i * 2, len:1, midi:cyc[i % cyc.length] }));
  };
  // 八分音符贝斯：根音与高八度交替
  const bass8 = oct => chord => {
    const r = chordMidis(chord, oct)[0];
    return fill(8, i => ({ step:i * 2, len:1, midi:r + (i % 2 ? 12 : 0) }));
  };
  // 十六分音符奔马贝斯：根-根-高八度-根
  const bassGallop = oct => chord => {
    const r = chordMidis(chord, oct)[0];
    return fill(STEPS, i => ({ step:i, len:1, midi:r + (i % 4 === 2 ? 12 : 0) }));
  };
  // 四分音符贝斯：根音与高八度交替，每个音占半拍（跳着走）
  const bassQuarter = oct => chord => {
    const r = chordMidis(chord, oct)[0];
    return fill(4, i => ({ step:i * 4, len:2, midi:r + (i % 2 ? 12 : 0) }));
  };

  /* ---------- 曲谱 ----------
     tracks：src = 读哪一行谱，inst = 用哪个音色，level = 档位，shift = 移调半音数
     parts：每个 src 一行；数组 = 逐小节（短于小节数就循环），字符串 = 每小节都一样，函数 = 按和弦生成 */
  const SONG_DEFS = {
    // 主菜单：A 小调，英雄感里带一点阴暗。结算页用同一首的安静版（只留贝斯和琶音）
    menu: {
      chords:['Am','F','C','G','Am','F','G','E'],
      tracks:[
        { src:'bass',  inst:'bass',  level:0 },
        { src:'arp',   inst:'arp',   level:0 },
        { src:'drums', inst:'drums', level:1 },
        { src:'lead',  inst:'lead',  level:2 },
      ],
      parts:{
        bass: bass8(2),
        arp:  arp(3),
        drums:'k . h . s . h . k . h . s . h h',
        lead:[
          'A4 - - - . . E5 - D5 - C5 - B4 - A4 -',
          'C5 - - - A4 - - - F4 - G4 - A4 - C5 -',
          'G4 - - - E5 - - - D5 - C5 - G4 - - -',
          'B4 - - - D5 - - - G5 - - - - - . .',
          'A4 - - - . . E5 - D5 - C5 - B4 - A4 -',
          'C5 - - - A4 - - - F5 - E5 - D5 - C5 -',
          'B4 - - - D5 - - - G5 - - - F5 - D5 -',
          'E5 - - - - - - - G#4 - - - B4 - - -',
        ],
      },
    },

    // 战斗：E 小调，奔马贝斯。档位 1 → 4 一层层加厚，速度随波次从 144 提到 162
    combat: {
      chords:['Em','Em','C','D','Em','Em','C','B'],
      tracks:[
        { src:'bass',  inst:'bass',    level:0 },
        { src:'kick',  inst:'drums',   level:0 },
        { src:'beat',  inst:'drums',   level:1 },
        { src:'arp',   inst:'arp',     level:2 },
        { src:'lead',  inst:'lead',    level:3 },
        { src:'lead',  inst:'leadLow', level:4, shift:-12 },
        { src:'hats',  inst:'drums',   level:4 },
      ],
      parts:{
        bass: bassGallop(2),
        kick: 'k . . . k . . . k . . . k . . .',
        beat: 'h . h . s . h . h . h . s . h h',
        arp:  arp(4),
        hats: '. h . h . h . h . h . h . h . o',
        lead:[
          'E5 - - E5 G5 - E5 - B5 - - - A5 - G5 -',
          'F#5 - - - E5 - - - D5 - E5 - - - . .',
          'E5 - - E5 G5 - E5 - C6 - - - B5 - G5 -',
          'A5 - - - F#5 - - - D5 - F#5 - A5 - - -',
          'E5 - - E5 G5 - E5 - B5 - - - A5 - G5 -',
          'F#5 - - - G5 - - - A5 - B5 - - - . .',
          'C6 - - - B5 - - - A5 - - - G5 - - -',
          'F#5 - - - D#5 - - - B4 - - - F#5 - - -',
        ],
      },
    },

    // BOSS：D 小调，贝斯半音推进，主旋律用三全音（Ab）压人
    boss: {
      chords:['Dm','Dm','Bb','A','Dm','Dm','Bb','A'],
      tracks:[
        { src:'bass', inst:'bass',   level:0 },
        { src:'kick', inst:'drums',  level:0 },
        { src:'beat', inst:'drums',  level:1 },
        { src:'arp',  inst:'arp',    level:2 },
        { src:'lead', inst:'lead50', level:3 },
      ],
      parts:{
        bass:[
          'D2 D2 D3 D2 Eb2 D2 D3 D2 D2 D2 D3 D2 F2 E2 Eb2 D2',
          'D2 D2 D3 D2 Eb2 D2 D3 D2 D2 D2 D3 D2 F2 E2 Eb2 D2',
          'Bb1 Bb1 Bb2 Bb1 Bb1 Bb1 Bb2 Bb1 Bb1 Bb1 Bb2 Bb1 C2 Bb1 A1 Bb1',
          'A1 A1 A2 A1 A1 A1 A2 A1 A1 A1 A2 A1 C#2 E2 G2 C#3',
        ],
        kick: 'k . . k k . . . k . . k k . k .',
        beat: 'h . s h h . s . h . s h t . t t',
        arp:  arp(4),
        lead:[
          'D5 . D5 . F5 . D5 . Ab5 - - - G5 - F5 -',
          'D5 . D5 . F5 . D5 . C5 - Bb4 - A4 - - -',
          'Bb4 . Bb4 . D5 . F5 . A5 - - - G5 - F5 -',
          'E5 - - - C#5 - - - A4 - - - G#4 - A4 -',
          'D5 . D5 . F5 . D5 . Ab5 - - - G5 - F5 -',
          'D6 - C6 - Bb5 - A5 - G5 - F5 - E5 - D5 -',
          'Bb4 . Bb4 . D5 . F5 . A5 - - - G5 - F5 -',
          'A5 - - - - - - - C#6 - - - E6 - - -',
        ],
      },
    },

    // 波间商店：C 大调，跳着走的小调子，松一口气
    shop: {
      chords:['C','Am','F','G','C','Am','F','G'],
      tracks:[
        { src:'bass',  inst:'bass',  level:0 },
        { src:'drums', inst:'drums', level:0 },
        { src:'arp',   inst:'arp',   level:1 },
        { src:'lead',  inst:'lead',  level:2 },
      ],
      parts:{
        bass: bassQuarter(2),
        drums:'k . h . s . h . k . k . s . h .',
        arp:  arp8(4),
        lead:[
          'E5 . G5 . C6 - . . G5 . E5 . C5 - . .',
          'A4 . C5 . E5 - . . C5 . A4 . E4 - . .',
          'F4 . A4 . C5 - . . A4 . C5 . F5 - . .',
          'G4 . B4 . D5 - . . F5 - E5 - D5 - . .',
          'E5 . G5 . C6 - . . G5 . E5 . C5 - . .',
          'A4 . C5 . E5 . A5 - - - G5 - E5 - . .',
          'F5 . E5 . D5 . C5 . A4 - C5 - F5 - . .',
          'G5 - - - F5 - - - D5 - - - B4 - - -',
        ],
      },
    },

    // 阵亡：两小节下行收尾，只放一遍
    gameover: {
      loop:false,
      chords:['Am','Am'],
      tracks:[
        { src:'bass',  inst:'bass',  level:0 },
        { src:'drums', inst:'drums', level:0 },
        { src:'lead',  inst:'lead',  level:0 },
      ],
      parts:{
        bass:['A2 - - - - - - - E2 - - - - - - -', 'A1 - - - - - - - - - - - - - - -'],
        drums:['k . . . . . . . k . . . . . . .', 'k . . . . . . . . . . . . . . .'],
        lead:['E5 - - - D5 - - - C5 - - - B4 - - -', 'A4 - - - - - - - - - - - - - - -'],
      },
    },
  };

  // 编译：每小节、每行谱按格分桶，演奏时直接按格取
  function compile(def){
    const drumSrc = new Set(def.tracks.filter(t => t.inst === 'drums').map(t => t.src));
    const bars = def.chords.map((chord, i) => {
      const bar = {};
      for (const src of Object.keys(def.parts)){
        const part = def.parts[src];
        let evs;
        if (typeof part === 'function') evs = part(chord, i);
        else {
          const text = Array.isArray(part) ? part[i % part.length] : part;
          evs = drumSrc.has(src) ? parseDrums(text) : parseMelody(text);
        }
        const buckets = fill(STEPS, () => []);
        for (const e of evs) buckets[e.step].push(e);
        bar[src] = buckets;
      }
      return bar;
    });
    return { loop:def.loop !== false, tracks:def.tracks, bars };
  }
  const SONGS = {};
  for (const k of Object.keys(SONG_DEFS)) SONGS[k] = compile(SONG_DEFS[k]);

  /* ---------- 场景 ----------
     level = 默认档位；combat 的档位和速度由游戏按战况每帧给。
     urgent = 下一拍就换（不等小节线）；crash = 切进来时敲一声吊镲。
     gain = 场景音量：战斗和 BOSS 有枪声盖着，取 1；菜单、商店、结算没有枪声，抬 2–4 dB */
  const SCENES = {
    menu:     { song:'menu',     level:3, bpm:112, gain:1.6 },
    results:  { song:'menu',     level:0, bpm:96,  gain:1.6 },
    combat:   { song:'combat',   level:2, bpm:144, gain:1 },
    boss:     { song:'boss',     level:4, bpm:160, gain:1, urgent:true, crash:true },
    shop:     { song:'shop',     level:3, bpm:104, gain:1.3 },
    gameover: { song:'gameover', level:3, bpm:90,  gain:1.4, urgent:true },
  };
  const SCENE_FADE = 0.25;   // 换场景时场景音量的过渡秒数

  /* ---------- 音色 ----------
     duty = 脉冲波占空比（芯片音乐的标志音色），type = 内置波形；a/d/s/r = 包络；
     sub = 叠一层同音高的脉冲波——三角波贝斯在手机外放上几乎听不见，靠它补出泛音 */
  const INST = {
    lead:    { duty:.25,  gain:.085, a:.005, d:.10, s:.70, r:.06, vib:true },
    lead50:  { duty:.5,   gain:.070, a:.004, d:.08, s:.60, r:.05, vib:true },
    leadLow: { duty:.5,   gain:.045, a:.004, d:.08, s:.60, r:.05 },
    arp:     { duty:.125, gain:.035, a:.002, d:.05, s:.35, r:.02 },
    bass:    { type:'triangle', gain:.24, a:.003, d:.06, s:.85, r:.03, sub:{ duty:.5, gain:.05 } },
  };

  /* ---------- 引擎 ----------
     ac = AudioContext（或 OfflineAudioContext），dest = 接到哪（默认 ac.destination）。
     opts.lite = 手机上省掉贝斯泛音层和颤音 LFO，少开一半振荡器 */
  function createEngine(ac, dest, opts){
    opts = opts || {};
    const lite = !!opts.lite;
    const bus = ac.createGain();
    bus.gain.value = 0;
    bus.connect(dest || ac.destination);
    // 场景音量单独一级：它的自动化按换曲时刻排（随时间单调往后），不和开关 / 暂停压低那一级互相打架
    const stage = ac.createGain();
    stage.gain.value = 1;
    stage.connect(bus);
    let stageGain = 1;

    const waves = {};
    function pulse(duty){
      if (!waves[duty]){
        const N = 40;
        const real = new Float32Array(N), imag = new Float32Array(N);
        for (let n = 1; n < N; n++) real[n] = 2 / (n * Math.PI) * Math.sin(n * Math.PI * duty);
        waves[duty] = ac.createPeriodicWave(real, imag);
      }
      return waves[duty];
    }
    let noise = null;
    function noiseBuf(){
      if (!noise){
        const len = (ac.sampleRate * 2) | 0;
        noise = ac.createBuffer(1, len, ac.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      return noise;
    }

    // 包络：起音 → 衰减到持续电平 → 释放。音尾提前收一点，连续的同音才听得出是两下
    function env(p, t, dur, peak, s){
      const end = t + Math.max(dur - s.r * .5, s.a + .005);
      p.setValueAtTime(0, t);
      p.linearRampToValueAtTime(peak, t + s.a);
      const dEnd = t + s.a + s.d;
      if (dEnd < end){
        p.linearRampToValueAtTime(peak * s.s, dEnd);
        p.setValueAtTime(peak * s.s, end);
      }
      p.linearRampToValueAtTime(0, end + s.r);
    }
    function voice(spec, freq, t, dur, peak){
      const o = ac.createOscillator();
      if (spec.duty) o.setPeriodicWave(pulse(spec.duty)); else o.type = spec.type;
      o.frequency.setValueAtTime(freq, t);
      const g = ac.createGain();
      env(g.gain, t, dur, peak, spec);
      o.connect(g); g.connect(stage);
      o.start(t); o.stop(t + dur + spec.r + .03);
      return o;
    }
    function note(name, midi, t, dur){
      const spec = INST[name];
      const f = freqOf(midi);
      const o = voice(spec, f, t, dur, spec.gain);
      if (spec.vib && !lite && dur > .3){          // 长音才加颤音，短音加了只会糊
        const lfo = ac.createOscillator();
        lfo.frequency.setValueAtTime(5.5, t);
        const depth = ac.createGain();
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(9, t + Math.min(.25, dur * .5));   // ±9 音分，慢慢起
        lfo.connect(depth); depth.connect(o.detune);
        lfo.start(t); lfo.stop(t + dur + spec.r + .03);
      }
      if (spec.sub && !lite){
        const s = spec.sub;
        voice({ duty:s.duty, a:spec.a, d:spec.d, s:spec.s, r:spec.r }, f, t, dur, s.gain);
      }
    }
    function sweep(type, f0, f1, dur, vol, t){
      const o = ac.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(.0005, t + dur);
      o.connect(g); g.connect(stage);
      o.start(t); o.stop(t + dur + .02);
    }
    function hiss(ftype, freq, dur, vol, t){
      const n = ac.createBufferSource(); n.buffer = noiseBuf();
      const f = ac.createBiquadFilter(); f.type = ftype;
      f.frequency.setValueAtTime(freq, t);
      const g = ac.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(.0005, t + dur);
      n.connect(f); f.connect(g); g.connect(stage);
      n.start(t, Math.random() * .8); n.stop(t + dur + .02);
    }
    function hit(ch, t){
      switch (ch){
        case 'k': sweep('sine', 150, 42, .13, .55, t); break;
        case 's': hiss('highpass', 1400, .13, .20, t); sweep('triangle', 200, 150, .07, .16, t); break;
        case 'h': hiss('highpass', 8000, .035, .06, t); break;
        case 'o': hiss('highpass', 7000, .16, .05, t); break;
        case 't': sweep('sine', 220, 85, .17, .32, t); break;
        case 'c': hiss('highpass', 5200, 1.1, .12, t); break;
      }
    }

    let enabled = true, ducked = false;
    let cur = null;        // 正在放的：{ key, song, bar, step, level, bpm, done }
    let want = null;       // 想放的：{ key, song, level, bpm, urgent, crash }
    let nextTime = 0;      // 下一格的时刻（AudioContext 时钟）

    function applyGain(){
      const now = ac.currentTime;
      const target = enabled ? VOLUME * (ducked ? DUCK : 1) : 0;
      const g = bus.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(target, now + FADE);
    }
    function setEnabled(on){ on = !!on; if (on === enabled && cur) return; enabled = on; applyGain(); }
    function setDuck(on){ on = !!on; if (on === ducked) return; ducked = on; applyGain(); }

    // 每帧都会调；同一场景只更新档位和速度，换场景才排一次切换
    function setScene(key, o){
      const spec = SCENES[key];
      if (!spec) return;
      o = o || {};
      const level = o.level != null ? o.level : spec.level;
      const bpm = o.bpm || spec.bpm;
      if (want && want.key === key){ want.level = level; want.bpm = bpm; return; }
      want = { key, song:spec.song, level, bpm, urgent:!!spec.urgent, crash:!!spec.crash };
    }

    function begin(t){
      cur = { key:want.key, song:SONGS[want.song], bar:0, step:0, level:want.level, bpm:want.bpm, done:false };
      nextTime = t;
      const g = SCENES[want.key].gain || 1;             // 场景音量：在新曲子第一拍开始过渡
      stage.gain.setValueAtTime(stageGain, t);
      stage.gain.linearRampToValueAtTime(g, t + SCENE_FADE);
      stageGain = g;
      if (want.crash && enabled) hit('c', t);           // BOSS 登场：先敲一声吊镲
    }
    function playStep(t){
      const bar = cur.song.bars[cur.bar];
      const spStep = 60 / cur.bpm / 4;
      for (const tr of cur.song.tracks){
        if (tr.level > cur.level) continue;
        const evs = bar[tr.src][cur.step];
        for (const e of evs){
          if (tr.inst === 'drums') hit(e.hit, t);
          else note(tr.inst, e.midi + (tr.shift || 0), t, e.len * spStep);
        }
      }
    }

    function tick(now){
      if (now == null) now = ac.currentTime;
      if (!want) return;
      if (nextTime < now - RESYNC) nextTime = now + .05;              // 后台回来：跳到现在，不补音
      for (let guard = 0; guard < 256; guard++){
        if (!cur || cur.done){
          if (cur && cur.done && cur.key === want.key) return;        // 只放一遍的曲子放完了：静着等下一个场景
          begin(Math.max(nextTime, now + .05));
        }
        if (nextTime >= now + LOOKAHEAD) return;
        if (want.key !== cur.key && (cur.step === 0 || (want.urgent && cur.step % 4 === 0))) begin(nextTime);
        if (cur.step === 0 && want.key === cur.key){
          cur.level = want.level;                                     // 档位：小节线上生效
          if (cur.bar === 0) cur.bpm = want.bpm;                      // 速度：整首回到开头才生效
        }
        if (enabled) playStep(nextTime);
        nextTime += 60 / cur.bpm / 4;
        if (++cur.step === STEPS){
          cur.step = 0;
          if (++cur.bar === cur.song.bars.length){
            if (cur.song.loop) cur.bar = 0; else cur.done = true;
          }
        }
      }
    }

    applyGain();
    return {
      setScene, setEnabled, setDuck, tick,
      get playing(){ return cur && !cur.done ? { key:cur.key, bar:cur.bar, step:cur.step, level:cur.level, bpm:cur.bpm } : null; },
      get nextTime(){ return nextTime; },
    };
  }

  global.ZombieMusic = {
    createEngine, SONGS, SONG_DEFS, SCENES, INST,
    parseMelody, parseDrums, midiOf, freqOf, chordMidis,
    STEPS, LOOKAHEAD, RESYNC, VOLUME, DUCK,
  };
})(typeof window !== 'undefined' ? window : globalThis);
