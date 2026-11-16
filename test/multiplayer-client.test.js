import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../multiplayer.js", import.meta.url), "utf8");

class FakeEventTarget {
  addEventListener() {}
  dispatchEvent() { return true; }
}

class FakeCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
}

function storage(){
  const values = new Map();
  return {
    getItem:key => values.get(key) ?? null,
    setItem:(key, value) => values.set(key, String(value)),
    removeItem:key => values.delete(key)
  };
}

function loadClient(){
  let now = 1;
  const window = {
    location:{ protocol:"https:", host:"game.example", hostname:"game.example" },
    localStorage:storage(),
    sessionStorage:storage()
  };
  const context = vm.createContext({
    window,
    globalThis:window,
    location:window.location,
    EventTarget:FakeEventTarget,
    CustomEvent:FakeCustomEvent,
    WebSocket:{ OPEN:1 },
    performance:{ now:() => now },
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console
  });
  vm.runInContext(SOURCE, context, { filename:"multiplayer.js" });
  return { client:window.zombieNetwork, setNow:value => { now = value; } };
}

test("multiplayer client rejects oversized server messages", () => {
  const { client } = loadClient();
  assert.equal(client.acceptServerMessage("x".repeat(512 * 1024)), true);
  assert.equal(client.acceptServerMessage("x".repeat(512 * 1024 + 1)), false);
});

test("multiplayer client bounds server message count and resets the time window", () => {
  const { client, setNow } = loadClient();
  for (let index = 0; index < 400; index += 1) {
    assert.equal(client.acceptServerMessage("{}"), true);
  }
  assert.equal(client.acceptServerMessage("{}"), false);
  setNow(10_002);
  assert.equal(client.acceptServerMessage("{}"), true);
});

test("multiplayer client bounds aggregate server data per window", () => {
  const { client } = loadClient();
  const halfMegabyte = "x".repeat(512 * 1024);
  for (let index = 0; index < 128; index += 1) {
    assert.equal(client.acceptServerMessage(halfMegabyte), true);
  }
  assert.equal(client.acceptServerMessage("x"), false);
});

test("multiplayer client skips snapshots while its upload buffer is backed up", () => {
  const { client } = loadClient();
  const sent = [];
  client.ws = { readyState:1, bufferedAmount:0, send:data => sent.push(data) };
  assert.equal(client.sendSnapshot({ tick:1 }), true);
  client.ws.bufferedAmount = 64 * 1024 + 1;
  assert.equal(client.sendSnapshot({ tick:2 }), false);
  assert.equal(client.sendInput({ mx:1 }), true);
  assert.equal(sent.length, 2);
});

test("station selection uses the room server's advertised map count", () => {
  const { client } = loadClient();
  const room = { type:"room.state", code:"ABC234", phase:"lobby", hostId:"host", players:[] };
  client.onMessage({ ...room, mapIndex:5 });
  assert.equal(client.room.mapCount, 5);
  assert.equal(client.room.mapIndex, 4);

  client.onMessage({ ...room, mapCount:6, mapIndex:5 });
  client.onMessage({ type:"match.start", mapIndex:5 });
  assert.equal(client.room.mapCount, 6);
  assert.equal(client.room.mapIndex, 5);
});

test("the host keeps sending snapshots during the transition to results", () => {
  const game = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  const definitions = ["sendHostSnapshot", "loop"].map(name => {
    const match = game.match(new RegExp("^function " + name + "\\([\\s\\S]*?^}", "m"));
    assert.ok(match, name);
    return match[0];
  });
  const sent = [];
  const context = vm.createContext({
    state:"dying", netMode:"host", frameN:1, last:100, lastSnapshotSent:100,
    snapshotTick:1, time:0, particles:[], shake:0,
    multiplayerActive:() => true,
    buildNetworkState:() => ({ phase:"dying" }),
    net:{ sendSnapshot:snapshot => sent.push(snapshot) },
    render(){}, requestAnimationFrame(){},
  });
  vm.runInContext(definitions.join("\n"), context);
  context.loop(130);
  assert.equal(sent.length, 0);
  context.loop(151);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state.phase, "dying");
  assert.equal(sent[0].tick, 2);
});
