/* 热点直连联机：两台手机连同一个热点，走 WebRTC DataChannel 点对点，不需要任何服务器。
 *
 * 为什么不是 WebSocket：Toy 只托管静态包、不跑 Node，而我们的玩家几乎全在手机上，
 * 「租一台公网服务器」和「拿 PC 当主机」两条路都不成立。同一热点下两台设备在一个内网里，
 * 用 host 候选直接互连，连 NAT 穿透都不用碰——P2P 最常见的死法（对称 NAT 要 TURN 中转，
 * 而 TURN 就是一台要自己养的服务器）在这个场景下不存在。
 *
 * 为什么只有 2 人：没有服务器就没有信令通道，offer/answer 只能靠人肉互发。
 * 两人一来一回两条码就够；四人星型要六次握手，那个 UX 不能用。所以 capacity 定死 2。
 *
 * 这个类对 script.js 呈现的接口与 multiplayer.js 的 ZombieNetwork 完全一致
 * （同样的方法、同样的 room 形状、同样的 7 个事件），所以游戏本体一行都不用改。
 * 差别只在多了三个信令方法：createRoom 之后要 exportCode / acceptRemoteCode。
 *
 * 房主同时兼任「服务器」：房间状态机就在房主页面里跑。这不是妥协——WSS 版的权威模拟
 * 本来就在房主浏览器里（见 README），服务器那 1000 行里绝大部分是在防一台面向陌生人的
 * 公共服务器（房间码、容量、限流、重连令牌、Origin 白名单），一条两台手机之间的直连管道上
 * 没有那些对手。
 */
(function(global){
  "use strict";

  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 去掉了 I O 0 1，念出来不会错
  const GATHER_TIMEOUT_MS = 4000;   // 候选收集封顶：不用 trickle，等收齐再一次性出码
  const HELLO_TIMEOUT_MS  = 8000;   // 通道开了但对方迟迟不报到
  const PING_INTERVAL_MS  = 2000;

  /* ---------- 信令服务（可选）----------
     它只做一件事：把房主的码递给客机、把客机的码递回房主，然后消失。
     游戏数据仍然全程 P2P，一个字节都不经过它。递的就是下面 packCode 出来的那串码本身——
     服务器当它是一坨不透明的字符串，所以编解码这块一行都不用改。

     地址故意做成可换的：workers.dev 在国内能不能稳定连上没人验证过，
     万一不通就换个地址，服务端几十行、迁移很便宜。
       · SIGNAL_DEFAULT   随包发布的默认地址，留空 = 这条路关掉
       · localStorage 里的 zombie-world-signal 覆盖它（真机排查/临时换地址用）
     任何一步失败都不该把玩家困住：所有失败路径最终都回落到复制粘贴那一套。 */
  const SIGNAL_DEFAULT = "";
  const SIGNAL_KEY = "zombie-world-signal";
  const SIGNAL_POLL_MS = 1000;      // 房主轮询应答的间隔
  const SIGNAL_WAIT_MS = 90000;     // 等队友的上限，比服务端 2 分钟的房间寿命短一点
  const SIGNAL_HTTP_MS = 8000;      // 单次请求超时：WebView 里卡住的请求不会自己醒

  function signalBase(){
    let v = SIGNAL_DEFAULT;
    try {
      const saved = global.localStorage && global.localStorage.getItem(SIGNAL_KEY);
      if (saved !== null && saved !== undefined) v = saved;
    } catch (_) {}
    return String(v || "").trim().replace(/\/+$/, "");
  }

  async function signalFetch(url, options){
    if (typeof global.fetch !== "function") throw new Error("这个环境不支持联网加入，请改用邀请码");
    const ctrl = typeof global.AbortController === "function" ? new global.AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), SIGNAL_HTTP_MS);
    try {
      return await global.fetch(url, Object.assign({ signal: ctrl ? ctrl.signal : undefined }, options));
    } finally { clearTimeout(timer); }
  }

  function randomId(n){
    const bytes = new Uint8Array(n);
    (global.crypto || global.msCrypto).getRandomValues(bytes);
    let out = "";
    for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return out;
  }

  /* ---------- 码的编解码 ----------
     故意用「无损压缩 + base64」而不是把 SDP 拆成字段再重建：重建要靠模板，模板写错了
     表现是「码看着没问题但就是连不上」，在拿不到真机日志的情况下这种 bug 最难查。
     无损方案体积大一些（复制粘贴无所谓），但它不可能把连接搞坏。
     等哪天要换二维码（装不下几百字节以上）再做字段级压缩，那时已经有真机结论垫底了。 */
  async function packCode(obj){
    const json = JSON.stringify(obj);
    const raw = new TextEncoder().encode(json);
    let bytes = raw;
    let flag = "0";                                    // 0 = 未压缩，1 = deflate-raw
    if (typeof global.CompressionStream === "function"){
      try {
        const stream = new Blob([raw]).stream().pipeThrough(new global.CompressionStream("deflate-raw"));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        flag = "1";
      } catch (_) { bytes = raw; flag = "0"; }         // 老 WebView 没有 CompressionStream，退回明文
    }
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return flag + btoa(bin);
  }

  async function unpackCode(text){
    const trimmed = String(text || "").replace(/\s+/g, "");
    if (trimmed.length < 2) throw new Error("这串码太短了，八成是复制时漏了一截");
    const flag = trimmed[0];
    if (flag !== "0" && flag !== "1") throw new Error("这不是本游戏的联机码");
    let bytes;
    try {
      const bin = atob(trimmed.slice(1));
      bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    } catch (_) { throw new Error("这串码读不出来，八成是复制时漏了一截"); }
    if (flag === "1"){
      if (typeof global.DecompressionStream !== "function"){
        throw new Error("这台设备不支持解压这串码，请让对方在设置里关掉压缩");
      }
      const stream = new Blob([bytes]).stream().pipeThrough(new global.DecompressionStream("deflate-raw"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch (_) { throw new Error("这串码内容不完整，请让对方重新复制一次"); }
  }

  function safeName(value, fallback){
    const name = String(value == null ? "" : value).trim().slice(0, 12);
    return name || fallback;
  }

  class ZombiePeerNetwork extends EventTarget {
    constructor(){
      super();
      this.pc = null;
      this.dc = null;
      this.room = null;
      this.selfId = null;
      this.latency = null;
      this.url = "";                 // 没有服务器地址这回事，留着只为接口一致
      this.hosting = false;
      this.peerName = null;
      this.pingTimer = null;
      this.helloTimer = null;
      this.lastPingAt = 0;
      this.closing = false;
    }

    get isHost(){
      return !!(this.room && this.selfId && this.room.hostId === this.selfId);
    }

    /* ---- 接口对齐：这三个在 P2P 下没有意义，但 script.js 会调 ---- */
    setServerUrl(){ return ""; }
    hasSavedSession(){ return false; }
    resumeSavedSession(){ return Promise.resolve(false); }

    emit(name, detail){
      this.dispatchEvent(new CustomEvent(name, { detail }));
    }

    /* ---------- 信令 ---------- */

    // 房主：先把房间在本地建起来（此刻只有自己），再生成邀请码
    async createRoom(name, _capacity){
      this.teardown();
      this.hosting = true;
      this.selfId = randomId(8);
      this.room = {
        code: randomId(6),
        hostId: this.selfId,
        phase: "lobby",
        mapIndex: 0,
        capacity: 2,                 // 人肉信令的硬上限，见文件头
        players: [{ id:this.selfId, name:safeName(name, "房主"), slot:0, ready:false, connected:true }]
      };

      this.openPeer();
      this.bindChannel(this.pc.createDataChannel("zombie", { ordered:true }));
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this.gather();

      this.lastCode = await packCode({ v:1, t:"offer", sdp:this.pc.localDescription.sdp,
                                       name:this.room.players[0].name });
      this.emit("signal", { kind: "offer", code: this.lastCode });
      this.emitRoomState();
      return this.room;
    }

    // 房主：粘贴对方发回的应答码
    async acceptRemoteCode(text){
      if (!this.hosting || !this.pc) throw new Error("还没开房，先点「我开房」");
      const payload = await unpackCode(text);
      if (payload.t !== "answer") throw new Error("这是一张邀请码，不是应答码——你们俩都点了「我开房」？");
      this.peerName = safeName(payload.name, "队友");
      await this.pc.setRemoteDescription({ type:"answer", sdp:payload.sdp });
      this.emit("status", { state:"connecting" });
    }

    // 客机：粘贴房主的邀请码，产出应答码
    async joinWithCode(text, name){
      this.teardown();
      const payload = await unpackCode(text);
      if (payload.t !== "offer") throw new Error("这是一张应答码，不是邀请码——让房主发他那张");
      this.hosting = false;
      this.selfId = null;                                    // 身份由房主分配
      this.myName = safeName(name, "队友");

      this.openPeer();
      this.pc.ondatachannel = event => this.bindChannel(event.channel);
      await this.pc.setRemoteDescription({ type:"offer", sdp:payload.sdp });
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this.gather();

      this.lastCode = await packCode({ v:1, t:"answer", sdp:this.pc.localDescription.sdp,
                                       name:this.myName });
      this.emit("signal", { kind: "answer", code: this.lastCode });
    }


    /* ---------- 走信令服务的那条路：4 位房间号 ----------
       这一层只是「把码递过去」的搬运工，底下复用的还是 createRoom / joinWithCode / acceptRemoteCode，
       一行都没改。所以信令服务挂了、被墙了、审核环境不让访问，把复制粘贴那条路点出来就还能玩。 */

    signalReady(){ return !!signalBase(); }

    // 联机页打开时探一次，用来决定「我开房」是给房间号还是给邀请码。
    // 探不通不算错误，只是这条路今天用不了
    async probeSignal(){
      const base = signalBase();
      if (!base) return false;
      try {
        const res = await signalFetch(base + "/health");
        return res.ok;
      } catch (_) { return false; }
    }

    async signalJson(url, options){
      const res = await signalFetch(url, options);
      let body = null;
      try { body = res.status === 204 ? null : await res.json(); } catch (_) {}
      return { status: res.status, body: body || {} };
    }

    // 房主：开房 → 拿 4 位号 → 后台等应答
    async createRoomOnline(name){
      const base = signalBase();
      if (!base) throw new Error("这一版没有配信令服务，请用邀请码");
      this.useStun = true;
      const room = await this.createRoom(name);          // 照旧，顺便把码存进 this.lastCode
      let r;
      try {
        r = await this.signalJson(base + "/new", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offer: this.lastCode, name: room.players[0].name })
        });
      } catch (_) { throw new Error("信令服务连不上，请改用邀请码"); }
      if (r.status === 429) throw new Error("开房太频繁了，等几分钟再试");
      if (r.status !== 200) throw new Error("信令服务连不上，请改用邀请码");
      this.signalCode = r.body.code;
      this.signalToken = r.body.token;
      this.emit("signal", { kind: "room", roomCode: this.signalCode });
      this.pollAnswer(Date.now());
      return room;
    }

    // 房主：轮询应答。连上、超时、房间过期三种情况都要有明确的收尾，不能静静地卡住
    pollAnswer(startedAt){
      clearTimeout(this.signalTimer);
      this.signalTimer = setTimeout(async () => {
        if (!this.signalCode || !this.hosting) return;
        // 别拿 this.dc 判「连上没」：房主的 dc 在 createDataChannel 那一刻就存在了，
        // 那样第一跳就会退出。真正的标志是远端描述被应用（不管是这里收的还是手动粘的）
        if (!this.pc || this.pc.remoteDescription) return;
        if (Date.now() - startedAt > SIGNAL_WAIT_MS){
          this.dropSignalRoom();
          this.emit("signal", { kind: "room.timeout" });
          return;
        }
        let r;
        try {
          r = await this.signalJson(signalBase() + "/answer?code=" + this.signalCode +
                                    "&token=" + encodeURIComponent(this.signalToken));
        } catch (_) {
          this.pollAnswer(startedAt);                          // 网络抖一下不算数，接着等
          return;
        }
        if (r.status === 204){ this.pollAnswer(startedAt); return; }
        if (r.status === 404){
          this.dropSignalRoom();
          this.emit("signal", { kind: "room.timeout" });
          return;
        }
        if (r.status !== 200 || !r.body.answer){ this.pollAnswer(startedAt); return; }
        try {
          await this.acceptRemoteCode(r.body.answer);
          this.dropSignalRoom();                               // 接上头了，号还回号池
        } catch (error){
          this.fail(error.message || "对方的应答用不了");
        }
      }, SIGNAL_POLL_MS);
    }

    // 客机：输 4 位号 → 取 offer → 回 answer
    async joinWithRoomCode(code, name){
      const base = signalBase();
      if (!base) throw new Error("这一版没有配信令服务，请用邀请码");
      const clean = String(code || "").replace(/\D/g, "");
      if (clean.length !== 4) throw new Error("房间号是 4 位数字");
      this.useStun = true;
      let got;
      try {
        got = await this.signalJson(base + "/offer?code=" + clean);
      } catch (_) { throw new Error("信令服务连不上，请改用邀请码"); }
      if (got.status === 404) throw new Error("没有这个房间号，或者它已经过期了（房间只留 2 分钟）");
      if (got.status !== 200 || !got.body.offer) throw new Error("信令服务返回的内容不对，请改用邀请码");

      await this.joinWithCode(got.body.offer, name);           // 照旧，顺便把应答码存进 this.lastCode
      let r;
      try {
        r = await this.signalJson(base + "/answer?code=" + clean, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: this.lastCode, name: this.myName })
        });
      } catch (_) { throw new Error("应答没发出去，请改用邀请码"); }
      if (r.status === 409) throw new Error("这个房间已经有人加入了");
      if (r.status === 404) throw new Error("房间过期了，让房主重开一个");
      if (r.status !== 200) throw new Error("应答没发出去，请改用邀请码");
      this.emit("signal", { kind: "room.joined", roomCode: clean });
    }

    // 用完就销毁：把号早点还回去，也免得别人还能取到这间房的 offer
    dropSignalRoom(){
      clearTimeout(this.signalTimer);
      this.signalTimer = null;
      const code = this.signalCode, token = this.signalToken;
      this.signalCode = null; this.signalToken = null;
      if (!code || !signalBase()) return;
      signalFetch(signalBase() + "/close?code=" + code + "&token=" + encodeURIComponent(token),
                  { method: "POST" }).catch(() => {});
    }

    openPeer(){
      if (typeof global.RTCPeerConnection !== "function"){
        throw new Error("这个环境不支持 WebRTC，热点联机用不了");
      }
      /* 走房间号那条路时挂上公共 STUN，走复制粘贴那条路时不挂。
         为什么分开：STUN 会多出 srflx 候选，正好覆盖「mDNS 名解析不了」的情况
         （浏览器给的 host 候选是 xxx.local，iOS 上解析它要 App 持有本地网络权限，
         而那个权限属于 B站 App、不属于我们）。代价是码会变长、候选收集要多等一会儿——
         对复制粘贴是实打实的体验损失，对房间号则一点都不疼，因为码不过人眼。
         真机验出 mDNS 确实不通的话，再把复制粘贴那条也打开。 */
      const iceServers = this.useStun
        ? [{ urls: ["stun:stun.miwifi.com:3478", "stun:stun.qq.com:3478"] }]
        : [];
      this.pc = new global.RTCPeerConnection({ iceServers });
      this.pc.oniceconnectionstatechange = () => {
        const state = this.pc && this.pc.iceConnectionState;
        if (state === "failed" || state === "disconnected"){
          this.emit("status", { state:"disconnected" });
          if (state === "failed") this.fail("两台手机没能连上，确认都连着同一个热点再重试");
        }
      };
    }

    // 不用 trickle：等候选收齐（或超时）再出码，这样一来一回两条码就够，不必反复交换
    gather(){
      return new Promise(resolve => {
        if (!this.pc || this.pc.iceGatheringState === "complete") return resolve();
        const finish = () => {
          clearTimeout(timer);
          if (this.pc) this.pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        };
        const check = () => { if (this.pc && this.pc.iceGatheringState === "complete") finish(); };
        const timer = setTimeout(finish, GATHER_TIMEOUT_MS);
        this.pc.addEventListener("icegatheringstatechange", check);
      });
    }

    bindChannel(channel){
      this.dc = channel;
      channel.onopen = () => {
        this.emit("status", { state:"connected" });
        this.startPing();
        if (this.hosting){
          // 房主等客机报到；对方要是打开了通道却不报到，别让大厅永远转圈
          this.helloTimer = setTimeout(() => this.fail("对方连上了但没能进房，请重新交换一次码"), HELLO_TIMEOUT_MS);
        } else {
          this.wire("hello", { name:this.myName });
        }
      };
      channel.onclose = () => {
        if (this.closing) return;
        this.emit("room.closed", { type:"room.closed", reason:"对方已断开" });
        this.clearRoom();
      };
      channel.onerror = () => this.emit("status", { state:"error" });
      channel.onmessage = event => {
        let message;
        try { message = JSON.parse(String(event.data)); }
        catch (_) { return; }
        if (!message || typeof message.type !== "string") return;
        this.onWire(message);
      };
    }

    /* ---------- 收到对端消息 ---------- */
    onWire(message){
      if (this.hosting) this.onWireAsHost(message);
      else this.onWireAsGuest(message);
    }

    onWireAsHost(message){
      switch (message.type){
        case "hello": {
          clearTimeout(this.helloTimer);
          this.helloTimer = null;
          if (this.room.players.length >= 2) return;              // 一条管道只可能有一个对端
          this.room.players.push({
            id: randomId(8),
            name: safeName(message.name, this.peerName || "队友"),
            slot: 1, ready:false, connected:true
          });
          this.emitRoomState();
          break;
        }
        case "room.ready": {
          const guest = this.room.players[1];
          if (guest){ guest.ready = !!message.ready; this.emitRoomState(); }
          break;
        }
        case "input": {
          // 房主这边把它当成本地事件抛出去，script.js 的 host 分支照单全收
          this.emit("input", message);
          this.emit("message", message);
          break;
        }
        case "leave": {
          this.room.players.length = 1;
          this.room.phase = "lobby";
          this.room.players[0].ready = false;
          this.emitRoomState();
          this.emit("room.closed", { type:"room.closed", reason:"队友已离开" });
          break;
        }
        case "ping": this.wire("pong", { sentAt:message.sentAt }); break;
        case "pong": this.markLatency(); break;
      }
    }

    onWireAsGuest(message){
      switch (message.type){
        case "room.state": {
          this.selfId = typeof message.selfId === "string" ? message.selfId : this.selfId;
          this.room = {
            code: String(message.code || ""),
            hostId: String(message.hostId || ""),
            phase: message.phase === "playing" ? "playing" : "lobby",
            mapIndex: Number.isInteger(message.mapIndex) ? Math.max(0, Math.min(4, message.mapIndex)) : 0,
            capacity: 2,
            players: Array.isArray(message.players) ? message.players : []
          };
          this.emit("room.state", Object.assign({ type:"room.state" }, message));
          this.emit("message", message);
          break;
        }
        case "match.start": {
          if (this.room){
            this.room.phase = "playing";
            if (Number.isInteger(message.mapIndex)) this.room.mapIndex = message.mapIndex;
            if (Array.isArray(message.players)) this.room.players = message.players;
          }
          this.emit("match.start", message);
          this.emit("message", message);
          break;
        }
        case "match.finish": {
          if (this.room) this.room.phase = "lobby";
          this.emit("match.finish", message);
          this.emit("message", message);
          break;
        }
        case "snapshot":
        case "room.closed":
          this.emit(message.type, message);
          this.emit("message", message);
          if (message.type === "room.closed") this.clearRoom();
          break;
        case "ping": this.wire("pong", { sentAt:message.sentAt }); break;
        case "pong": this.markLatency(); break;
      }
    }

    markLatency(){
      this.latency = Math.max(0, Math.round(performance.now() - this.lastPingAt));
      this.emit("pong", { type:"pong" });
    }

    /* ---------- 房主广播房间状态 ---------- */
    emitRoomState(){
      if (!this.room) return;
      const base = {
        type: "room.state",
        code: this.room.code,
        hostId: this.room.hostId,
        phase: this.room.phase,
        mapIndex: this.room.mapIndex,
        capacity: 2,
        players: this.room.players
      };
      // 每人收到的 selfId 不同，所以分别发
      this.wire("room.state", Object.assign({}, base, {
        selfId: this.room.players[1] ? this.room.players[1].id : null
      }));
      this.emit("room.state", Object.assign({}, base, { selfId:this.selfId }));
      this.emit("message", base);
    }

    /* ---------- 发送 ---------- */

    // 直接往管道里塞；房主/客机都可能用
    wire(type, payload){
      if (!this.dc || this.dc.readyState !== "open") return false;
      this.dc.send(JSON.stringify(Object.assign({ type }, payload || {})));
      return true;
    }

    /* script.js 只认识 send(type, payload)：客机原样上管道，房主则要自己当服务器处理掉，
       因为对房主来说这些消息的收件人就是它自己。 */
    send(type, payload){
      if (!this.hosting) return this.wire(type, payload);

      switch (type){
        case "room.ready": {
          const host = this.room && this.room.players[0];
          if (host){ host.ready = !!(payload && payload.ready); this.emitRoomState(); }
          return true;
        }
        case "room.config": {
          if (this.room && payload && Number.isInteger(payload.mapIndex)){
            this.room.mapIndex = Math.max(0, Math.min(4, payload.mapIndex));
            this.emitRoomState();
          }
          return true;
        }
        case "match.start": {
          if (!this.room || this.room.phase !== "lobby") return false;
          if (this.room.players.length < 2 || !this.room.players.every(p => p.ready)){
            this.emit("error", { type:"error", code:"NOT_READY", message:"还有人没准备好。", requestType:"match.start" });
            return false;
          }
          this.room.phase = "playing";
          const detail = { type:"match.start", mapIndex:this.room.mapIndex, players:this.room.players };
          this.wire("match.start", detail);
          this.emit("match.start", detail);
          this.emit("message", detail);
          return true;
        }
        case "match.finish": {
          if (!this.room) return false;
          this.room.phase = "lobby";
          for (const player of this.room.players) player.ready = false;
          this.wire("match.finish", { type:"match.finish" });
          this.emit("match.finish", { type:"match.finish" });
          this.emitRoomState();
          return true;
        }
        case "leave": return this.wire("leave", payload);
        default:      return this.wire(type, payload);      // snapshot 之类直接走管道
      }
    }

    setReady(ready){ return this.send("room.ready", { ready:!!ready }); }
    configureRoom(mapIndex){ return this.send("room.config", { mapIndex }); }
    startMatch(){ return this.send("match.start"); }
    sendInput(input){ return this.hosting ? false : this.wire("input", input); }
    sendSnapshot(snapshot){ return this.hosting ? this.wire("snapshot", snapshot) : false; }

    // 接口对齐：WSS 版靠房间码加入，P2P 靠邀请码，这个方法在 P2P 下不该被调到
    joinRoom(){
      return Promise.reject(new Error("热点联机请用邀请码加入，不是房间码"));
    }

    startPing(){
      this.stopPing();
      this.pingTimer = setInterval(() => {
        this.lastPingAt = performance.now();
        this.wire("ping", { sentAt:Date.now() });
      }, PING_INTERVAL_MS);
    }
    stopPing(){
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    fail(reason){
      this.emit("error", { type:"error", code:"P2P_FAILED", message:reason });
      this.emit("status", { state:"error" });
    }

    leaveRoom(){
      this.wire("leave", {});
      this.disconnect(true);
      this.emit("room.left", {});
    }

    teardown(){
      this.closing = true;
      this.dropSignalRoom();          // 不然取消开房之后，那个号还在服务端挂着两分钟
      this.stopPing();
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
      if (this.dc){ try { this.dc.close(); } catch (_) {} }
      if (this.pc){ try { this.pc.close(); } catch (_) {} }
      this.dc = null;
      this.pc = null;
      this.closing = false;
    }

    disconnect(_clearSession){
      this.teardown();
      this.clearRoom();
      this.emit("status", { state:"closed" });
    }

    clearRoom(){
      this.room = null;
      this.selfId = null;
      this.hosting = false;
      this.peerName = null;
      this.latency = null;
      this.lastCode = null;
      this.useStun = false;
    }
  }

  global.ZombiePeerNetwork = ZombiePeerNetwork;
  global.zombiePeerCodec = { packCode, unpackCode };   // 给测试用

  // 线上唯一能用的联机形态就是热点直连，所以 net 直接指向它。
  // WSS 版整套保留在 multiplayer.js（window.ZombieNetwork / window.zombieWsNetwork），
  // 哪天真有了公网服务器，把下面这行换回去即可。
  global.zombieWsNetwork = global.zombieNetwork;
  global.zombieNetwork = new ZombiePeerNetwork();
})(window);
