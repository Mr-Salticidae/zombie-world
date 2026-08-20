"use strict";

/* ============================================================
   僵尸危机 · 多人联机传输层
   浏览器只使用原生 WebSocket；房间、身份和重连由 Node 服务端管理。
   游戏模拟仍在 script.js 中，由房主浏览器作为权威端推进。
   ============================================================ */
(function exposeMultiplayerClient(global){
  const SESSION_KEY = "zombie-world-multiplayer-session";
  const SERVER_KEY = "zombie-world-multiplayer-server";

  function storageGet(kind, key){
    try { return global[kind] ? global[kind].getItem(key) : null; }
    catch (_) { return null; }
  }

  function storageSet(kind, key, value){
    try {
      if (global[kind]) global[kind].setItem(key, value);
      return true;
    } catch (_) { return false; }
  }

  function storageRemove(kind, key){
    try {
      if (global[kind]) global[kind].removeItem(key);
      return true;
    } catch (_) { return false; }
  }

  /* 线上房间服务器的地址。
     不能靠 location.host 猜：游戏在 Toy 平台上跑在 www.bilibilitoy.com 的 iframe 里，
     跟服务器根本不同源，猜出来的地址必然是错的。所以这里写死一个默认值，
     由 localStorage 的 zombie-world-server 覆盖（换服务器 / 真机排查时不用重新过审）。
     留空 = 回落到 location.host —— 本地开发时游戏就是这台服务器自己发的，正好对得上。

     反过来一条同样重要：服务器那边的 ALLOWED_ORIGINS 必须写 https://www.bilibilitoy.com，
     不是 bilibili.com。填错的表现是「连接被拒绝」且客户端看不出原因。见 server/deploy/README.md。 */
  const SERVER_DEFAULT = "wss://tiaozhuxiansheng.com/zombie/ws";

  function defaultServerUrl(){
    if (SERVER_DEFAULT) return SERVER_DEFAULT;
    if (location.protocol === "http:" || location.protocol === "https:"){
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      return protocol + "//" + location.host + "/ws";
    }
    return "ws://localhost:8080/ws";
  }

  function normalizeServerUrl(value){
    try {
      const raw = String(value || "").trim() || defaultServerUrl();
      if (/^https?:\/\//i.test(raw)){
        const url = new URL(raw);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        if (!url.pathname || url.pathname === "/") url.pathname = "/ws";
        return url.toString();
      }
      if (!/^wss?:\/\//i.test(raw)) return normalizeServerUrl("ws://" + raw.replace(/^\/+/, "") + "/ws");
      const url = new URL(raw);
      if (!url.pathname || url.pathname === "/") url.pathname = "/ws";
      return url.toString();
    } catch (_) {
      return defaultServerUrl();
    }
  }

  function readSession(){
    try {
      const value = JSON.parse(storageGet("sessionStorage", SESSION_KEY) || "null");
      if (value && value.url && value.code && value.token) return value;
    } catch (_) {}
    return null;
  }

  function safePlayers(value){
    if (!Array.isArray(value)) return [];
    return value.slice(0, 4).flatMap((player, index) => {
      if (!player || typeof player !== "object" || typeof player.id !== "string") return [];
      const id = player.id.slice(0, 80);
      if (!id) return [];
      const slot = Number.isInteger(player.slot)
        ? Math.max(0, Math.min(3, player.slot))
        : index;
      return [{
        id,
        name:typeof player.name === "string" ? player.name.slice(0, 24) : `玩家${slot+1}`,
        slot,
        ready:!!player.ready,
        connected:player.connected !== false
      }];
    });
  }

  class ZombieNetwork extends EventTarget {
    constructor(){
      super();
      this.ws = null;
      this.url = normalizeServerUrl(storageGet("localStorage", SERVER_KEY) || defaultServerUrl());
      this.activeUrl = null;
      this.room = null;
      this.selfId = null;
      this.resumeToken = null;
      this.pendingResume = null;
      this.latency = null;
      this.connected = false;
      this.connecting = null;
      this.connectReject = null;
      this.connectTimer = null;
      this.pendingRoomRequest = null;
      this.intentionalClose = false;
      this.reconnectAttempt = 0;
      this.reconnectGraceMs = 10_000;
      this.reconnectDeadline = 0;
      this.reconnectTimer = null;
      this.heartbeatTimer = null;
      this.lastPingAt = 0;
    }

    get isHost(){
      return !!(this.room && this.selfId && this.room.hostId === this.selfId);
    }

    hasSavedSession(){
      return !!readSession();
    }

    resumeSavedSession(){
      const saved = readSession();
      if (!saved) return Promise.resolve(false);
      this.url = normalizeServerUrl(saved.url);
      this.pendingResume = saved;
      this.resumeToken = saved.token;
      this.reconnectDeadline = performance.now() + this.reconnectGraceMs;
      return this.connect().then(() => true);
    }

    emit(name, detail){
      this.dispatchEvent(new CustomEvent(name, { detail }));
    }

    settleRoomRequest(error, value){
      const pending = this.pendingRoomRequest;
      if (!pending) return;
      this.pendingRoomRequest = null;
      clearTimeout(pending.timer);
      if (error) pending.reject(error);
      else pending.resolve(value);
    }

    setServerUrl(value){
      const next = normalizeServerUrl(value);
      if (next !== this.url && (this.ws || this.connecting)) this.disconnect(false);
      this.url = next;
      storageSet("localStorage", SERVER_KEY, next);
      return next;
    }

    connect(value){
      if (value) this.setServerUrl(value);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this);
      if (this.connecting) return this.connecting;

      this.intentionalClose = false;
      this.emit("status", { state:"connecting", url:this.url });
      const socketUrl = this.url;
      this.connecting = new Promise((resolve, reject) => {
        let settled = false;
        let socket;
        const settle = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
          this.connectReject = null;
          if (error){
            this.connecting = null;
            reject(error);
          } else {
            resolve(this);
          }
        };
        this.connectReject = error => settle(error || new Error("连接已取消"));
        try {
          socket = new WebSocket(socketUrl);
        } catch (error){
          settle(error);
          return;
        }
        this.ws = socket;
        const remaining = this.reconnectDeadline
          ? Math.max(500, this.reconnectDeadline - performance.now() - 150)
          : 4000;
        this.connectTimer = setTimeout(() => {
          if (socket !== this.ws || socket.readyState === WebSocket.OPEN) return;
          settle(new Error("连接服务器超时"));
          try { socket.close(); } catch (_) {}
        }, Math.min(4000, remaining));

        socket.addEventListener("open", () => {
          if (socket !== this.ws) return;
          this.connected = true;
          this.connecting = null;
          this.activeUrl = socketUrl;
          this.reconnectAttempt = 0;
          this.emit("status", { state:"connected", url:socketUrl });
          this.startHeartbeat();

          const saved = this.pendingResume || readSession();
          if (saved && normalizeServerUrl(saved.url) === socketUrl){
            this.pendingResume = saved;
            this.send("room.resume", { code:saved.code, resumeToken:saved.token });
          }
          settle();
        });

        socket.addEventListener("message", event => {
          if (socket !== this.ws || typeof event.data !== "string") return;
          let message;
          try { message = JSON.parse(event.data); }
          catch (_) { return; }
          if (!message || typeof message.type !== "string") return;
          this.onMessage(message);
        });

        socket.addEventListener("error", () => {
          settle(new Error("无法连接联机服务器"));
          this.emit("status", { state:"error", url:socketUrl });
          try { socket.close(); } catch (_) {}
        });

        socket.addEventListener("close", event => {
          if (socket !== this.ws) return;
          settle(new Error("联机服务器连接已关闭"));
          this.stopHeartbeat();
          this.connected = false;
          this.connecting = null;
          this.ws = null;
          this.activeUrl = null;
          this.emit("status", {
            state:this.intentionalClose ? "closed" : "disconnected",
            code:event.code,
            reason:event.reason || ""
          });
          this.settleRoomRequest(new Error("联机服务器连接已关闭"));
          const canResume = this.pendingResume || (this.room && this.resumeToken) || readSession();
          if (!this.intentionalClose && canResume){
            if (!this.pendingResume){
              this.pendingResume = readSession() || {
                url:socketUrl,
                code:this.room.code,
                token:this.resumeToken
              };
            }
            if (!this.reconnectDeadline){
              this.reconnectDeadline = performance.now() + this.reconnectGraceMs;
            }
            this.scheduleReconnect();
          }
        });
      });
      return this.connecting;
    }

    disconnect(clearSession){
      this.intentionalClose = true;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.stopHeartbeat();
      this.settleRoomRequest(new Error("房间请求已取消"));
      if (clearSession !== false) this.clearRoom();
      if (this.connectReject) this.connectReject(new Error("连接已取消"));
      if (this.ws){
        const socket = this.ws;
        this.ws = null;
        try { socket.close(1000, "client closed"); } catch (_) {}
      }
      this.connected = false;
      this.connecting = null;
      this.activeUrl = null;
    }

    scheduleReconnect(){
      if (this.reconnectTimer || this.intentionalClose) return;
      const remaining = this.reconnectDeadline - performance.now();
      if (this.reconnectDeadline && remaining <= 100){
        this.emit("error", {
          type:"error",
          code:"RESUME_FAILED",
          message:"Reconnect window expired.",
          requestType:"room.resume"
        });
        this.clearRoom();
        return;
      }
      const delay = Math.min(900, Math.max(150, remaining ? remaining-100 : 900))
        * (.85 + Math.random()*.15);
      this.reconnectAttempt++;
      this.emit("status", { state:"reconnecting", delay, attempt:this.reconnectAttempt });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect().catch(() => this.scheduleReconnect());
      }, delay);
    }

    startHeartbeat(){
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (!this.connected) return;
        this.lastPingAt = performance.now();
        this.send("ping", { sentAt:Date.now() });
      }, 5000);
    }

    stopHeartbeat(){
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    onMessage(message){
      if (message.type === "session"){
        this.connectionId = message.connectionId || this.connectionId;
        if (Number.isFinite(message.reconnectGraceMs) && message.reconnectGraceMs > 0){
          this.reconnectGraceMs = message.reconnectGraceMs;
        }
      } else if (message.type === "room.state"){
        if (!/^[A-Z2-9]{6}$/.test(String(message.code || "")) ||
            !["lobby","playing"].includes(message.phase) ||
            typeof message.hostId !== "string"){
          this.emit("error", {
            type:"error",
            code:"INVALID_SERVER_MESSAGE",
            message:"服务器返回了不兼容的房间数据。",
            requestType:"room.state"
          });
          return;
        }
        this.room = {
          code:String(message.code),
          hostId:message.hostId.slice(0,80),
          phase:message.phase,
          mapIndex:Number.isInteger(message.mapIndex) ? Math.max(0, Math.min(4, message.mapIndex)) : 0,
          capacity:Number.isInteger(message.capacity) ? Math.max(2, Math.min(4, message.capacity)) : 4,
          players:safePlayers(message.players)
        };
        this.selfId = typeof message.selfId === "string" ? message.selfId.slice(0,80) : this.selfId;
        this.resumeToken = typeof message.resumeToken === "string"
          ? message.resumeToken.slice(0,128)
          : this.resumeToken;
        this.pendingResume = null;
        this.reconnectDeadline = 0;
        if (this.room.code && this.resumeToken){
          storageSet("sessionStorage", SESSION_KEY, JSON.stringify({
            url:this.activeUrl || this.url,
            code:this.room.code,
            token:this.resumeToken
          }));
        }
        this.settleRoomRequest(null, this.room);
      } else if (message.type === "match.start" && this.room){
        this.room.phase = "playing";
        this.room.mapIndex = Number.isInteger(message.mapIndex)
          ? Math.max(0, Math.min(4, message.mapIndex))
          : this.room.mapIndex;
        if (Array.isArray(message.players)) this.room.players = safePlayers(message.players);
        message.mapIndex = this.room.mapIndex;
        message.players = this.room.players;
      } else if (message.type === "room.closed"){
        this.clearRoom();
      } else if (message.type === "pong"){
        this.latency = Math.max(0, Math.round(performance.now() - this.lastPingAt));
      } else if (message.type === "error" && message.requestType === "room.resume"){
        this.pendingResume = null;
        this.reconnectDeadline = 0;
        this.clearRoom();
      } else if (message.type === "error" && this.pendingRoomRequest &&
                 message.requestType === this.pendingRoomRequest.type){
        const error = new Error(message.message || "房间请求失败");
        error.code = message.code;
        this.settleRoomRequest(error);
      }
      this.emit(message.type, message);
      this.emit("message", message);
    }

    clearRoom(){
      this.room = null;
      this.selfId = null;
      this.resumeToken = null;
      this.pendingResume = null;
      this.reconnectDeadline = 0;
      storageRemove("sessionStorage", SESSION_KEY);
    }

    send(type, payload){
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      this.ws.send(JSON.stringify(Object.assign({ type }, payload || {})));
      return true;
    }

    async createRoom(name, capacity){
      this.clearRoom();
      await this.connect();
      return this.requestRoom("room.create", {
        name,
        capacity:Math.max(2, Math.min(4, capacity || 4))
      });
    }

    async joinRoom(code, name){
      this.clearRoom();
      await this.connect();
      return this.requestRoom("room.join", {
        code:String(code || "").trim().toUpperCase(),
        name
      });
    }

    requestRoom(type, payload){
      if (this.pendingRoomRequest) return Promise.reject(new Error("已有房间请求正在处理"));
      return new Promise((resolve, reject) => {
        const pending = { type, resolve, reject, timer:null };
        pending.timer = setTimeout(() => {
          if (this.pendingRoomRequest !== pending) return;
          this.pendingRoomRequest = null;
          reject(new Error("房间服务器响应超时，请重试"));
          this.disconnect(true);
        }, 8000);
        this.pendingRoomRequest = pending;
        if (!this.send(type, payload)){
          this.settleRoomRequest(new Error("联机连接尚未就绪"));
        }
      });
    }

    setReady(ready){
      return this.send("room.ready", { ready:!!ready });
    }

    configureRoom(mapIndex){
      return this.send("room.config", { mapIndex });
    }

    startMatch(){
      return this.send("match.start");
    }

    sendInput(input){
      return this.send("input", input);
    }

    sendSnapshot(snapshot){
      return this.send("snapshot", snapshot);
    }

    leaveRoom(){
      this.send("leave");
      this.disconnect(true);
      this.emit("room.left", {});
    }
  }

  global.ZombieNetwork = ZombieNetwork;
  global.zombieNetwork = new ZombieNetwork();
})(window);
