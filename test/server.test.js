import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "ws";
import { createGameServer } from "../server/server.js";

class TestPeer {
  constructor(url, options) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url, options);
    this.ws.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  async open() {
    await once(this.ws, "open");
    return this.waitFor((message) => message.type === "session");
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(predicate, timeoutMs = 1_500) {
    const existingIndex = this.messages.findIndex(predicate);
    if (existingIndex >= 0) {
      return Promise.resolve(this.messages.splice(existingIndex, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Timed out waiting for WebSocket message."));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = once(this.ws, "close");
    this.ws.close();
    await closed;
  }

  terminate() {
    this.ws.terminate();
  }
}

async function startFixture(options = {}) {
  const server = createGameServer({
    heartbeatIntervalMs: 0,
    reconnectGraceMs: 100,
    logger: { error() {}, warn() {} },
    ...options,
  });
  const address = await server.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const httpUrl = `http://127.0.0.1:${address.port}`;
  const peers = [];

  return {
    server,
    url,
    httpUrl,
    async peer(options) {
      const peer = new TestPeer(url, options);
      peers.push(peer);
      await peer.open();
      return peer;
    },
    async close() {
      await Promise.allSettled(peers.map((peer) => peer.close()));
      await server.close();
    },
  };
}

async function createAndJoin(fixture, capacity = 4) {
  const host = await fixture.peer();
  host.send({ type: "room.create", name: "Host", capacity, mapIndex: 1 });
  const hostState = await host.waitFor((message) => message.type === "room.state");

  const guest = await fixture.peer();
  guest.send({ type: "room.join", code: hostState.code, name: "Guest" });
  const guestState = await guest.waitFor((message) => message.type === "room.state");
  await host.waitFor(
    (message) => message.type === "room.state" && message.players.length === 2,
  );
  return { host, guest, hostState, guestState };
}

async function readyAndStart(host, guest) {
  host.send({ type: "room.ready", ready: true });
  await host.waitFor(
    (message) => message.type === "room.state"
      && message.players.find((player) => player.id === message.selfId)?.ready,
  );
  guest.send({ type: "room.ready", ready: true });
  await guest.waitFor(
    (message) => message.type === "room.state"
      && message.players.every((player) => player.ready),
  );
  host.send({ type: "match.start" });
  const started = await host.waitFor((message) => message.type === "match.start");
  await guest.waitFor((message) => message.type === "match.start");
  return started;
}

test("serves the static game and reserves /ws for WebSocket upgrades", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const indexResponse = await fetch(`${fixture.httpUrl}/`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-type"), /^text\/html/u);
  assert.match(await indexResponse.text(), /<canvas id="game"/u);

  const privateResponse = await fetch(`${fixture.httpUrl}/server/server.js`);
  assert.equal(privateResponse.status, 404);
  for (const encodedPath of [
    "/foo%2F..%2Fserver%2Fserver.js",
    "/foo%2F..%2Fpackage.json",
  ]) {
    const response = await fetch(`${fixture.httpUrl}${encodedPath}`);
    assert.equal(response.status, 404);
  }
});

test("enforces the configured WebSocket Origin allowlist", async (t) => {
  const fixture = await startFixture({
    allowedOrigins: ["https://game.example"],
  });
  t.after(() => fixture.close());

  const allowed = await fixture.peer({ origin: "https://game.example" });
  assert.equal(allowed.ws.readyState, WebSocket.OPEN);

  const denied = new WebSocket(fixture.url, { origin: "https://evil.example" });
  denied.on("error", () => {});
  const statusCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for rejected WebSocket upgrade.")),
      1_500,
    );
    denied.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode);
    });
    denied.once("open", () => {
      clearTimeout(timer);
      reject(new Error("Disallowed Origin unexpectedly connected."));
    });
  });
  assert.equal(statusCode, 403);
  denied.terminate();
});

test("closes a connection that exceeds its per-window message rate", async (t) => {
  const fixture = await startFixture({
    rateLimitWindowMs: 10_000,
    rateLimitMaxMessages: 3,
  });
  t.after(() => fixture.close());
  const peer = await fixture.peer();

  for (let index = 1; index <= 3; index += 1) {
    peer.send({ type: "ping", ts: { large:"x".repeat(128) } });
    const pong = await peer.waitFor((message) => message.type === "pong");
    assert.equal("ts" in pong, false);
  }

  const closed = once(peer.ws, "close");
  peer.send({ type: "ping", ts: 4 });
  const error = await peer.waitFor(
    (message) => message.type === "error" && message.code === "RATE_LIMITED",
  );
  assert.equal(error.requestType, "rate-limit");
  const [closeCode] = await closed;
  assert.equal(closeCode, 1008);
});

test("creates, joins, readies, configures and starts a 2-4 player room", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { host, guest, hostState, guestState } = await createAndJoin(fixture);

  assert.equal(hostState.phase, "lobby");
  assert.equal(hostState.capacity, 4);
  assert.equal(hostState.hostId, hostState.selfId);
  assert.equal(guestState.code, hostState.code);
  assert.notEqual(guestState.selfId, hostState.selfId);
  assert.ok(guestState.resumeToken);

  guest.send({ type: "room.config", mapIndex: 3 });
  const forbidden = await guest.waitFor((message) => message.type === "error");
  assert.equal(forbidden.code, "FORBIDDEN");

  host.send({ type: "room.config", mapIndex: 3 });
  const configured = await guest.waitFor(
    (message) => message.type === "room.state" && message.mapIndex === 3,
  );
  assert.equal(configured.mapIndex, 3);

  const started = await readyAndStart(host, guest);
  assert.equal(started.mapIndex, 3);
  assert.equal(started.players.length, 2);

  guest.send({ type: "match.finish" });
  const finishForbidden = await guest.waitFor((message) => message.type === "error");
  assert.equal(finishForbidden.code, "FORBIDDEN");

  host.send({ type: "match.finish" });
  const returnedToLobby = await guest.waitFor(
    (message) => message.type === "room.state"
      && message.phase === "lobby"
      && message.players.every((player) => !player.ready),
  );
  assert.equal(returnedToLobby.players.every((player) => !player.ready), true);
});

test("rejects joins when the configured room capacity is full", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { hostState } = await createAndJoin(fixture, 2);
  const extra = await fixture.peer();
  extra.send({ type: "room.join", code: hostState.code, name: "Too Late" });
  const error = await extra.waitFor((message) => message.type === "error");
  assert.equal(error.code, "ROOM_FULL");
});

test("enforces authority and relays guest inputs and host snapshots", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { host, guest, guestState } = await createAndJoin(fixture);
  await readyAndStart(host, guest);

  guest.send({ type: "snapshot", tick: 1, state: { score: 10 } });
  const snapshotError = await guest.waitFor((message) => message.type === "error");
  assert.equal(snapshotError.code, "FORBIDDEN");

  guest.send({
    type: "input",
    playerId: "forged",
    seq: 7,
    mx: 0.5,
    my: -0.25,
    ax: 1,
    ay: 0,
    fire: true,
    weapon: 2,
    ultSeq: 1,
  });
  const input = await host.waitFor(
    (message) => message.type === "input" && message.seq === 7,
  );
  assert.equal(input.playerId, guestState.selfId);
  assert.equal(input.fire, true);
  assert.equal(input.weapon, 2);

  const snapshot = {
    type: "snapshot",
    tick: 44,
    simTime: 2.5,
    state: { score: 900, players: [{ id: guestState.selfId, x: 10, y: 20 }] },
  };
  host.send(snapshot);
  const relayed = await guest.waitFor(
    (message) => message.type === "snapshot" && message.tick === 44,
  );
  assert.deepEqual(relayed, snapshot);

  guest.send({ type: "input", seq: 8, mx: 2 });
  const invalidInput = await guest.waitFor((message) => message.type === "error");
  assert.equal(invalidInput.code, "INVALID_INPUT");
});

test("bounds snapshot size and relay frequency", async (t) => {
  const fixture = await startFixture({
    snapshotIntervalMs: 80,
    maxSnapshotBytes: 1024,
  });
  t.after(() => fixture.close());
  const { host, guest } = await createAndJoin(fixture);
  await readyAndStart(host, guest);

  host.send({ type:"snapshot", tick:1, state:{ players:[] } });
  await guest.waitFor((message) => message.type === "snapshot" && message.tick === 1);

  host.send({ type:"snapshot", tick:2, state:{ players:[] } });
  await assert.rejects(
    guest.waitFor((message) => message.type === "snapshot" && message.tick === 2, 140),
    /Timed out/u,
  );

  await delay(85);
  host.send({ type:"snapshot", tick:3, state:{ players:[] } });
  await guest.waitFor((message) => message.type === "snapshot" && message.tick === 3);

  await delay(85);
  host.send({ type:"snapshot", tick:4, state:{ padding:"x".repeat(1600) } });
  const error = await host.waitFor(
    (message) => message.type === "error" && message.code === "INVALID_SNAPSHOT",
  );
  assert.equal(error.requestType, "snapshot");
});

test("rejects new rooms after the configured room limit", async (t) => {
  const fixture = await startFixture({ maxRooms:1 });
  t.after(() => fixture.close());
  const first = await fixture.peer();
  first.send({ type:"room.create", name:"First" });
  await first.waitFor((message) => message.type === "room.state");

  const second = await fixture.peer();
  second.send({ type:"room.create", name:"Second" });
  const error = await second.waitFor(
    (message) => message.type === "error" && message.code === "SERVER_BUSY",
  );
  assert.equal(error.requestType, "room.create");
});

test("restores the same player with a reconnect token during the grace window", async (t) => {
  const fixture = await startFixture({ reconnectGraceMs: 180 });
  t.after(() => fixture.close());
  const { host, guest, guestState } = await createAndJoin(fixture);
  const disconnectedStatePromise = host.waitFor(
    (message) => message.type === "room.state"
      && message.players.some(
        (player) => player.id === guestState.selfId && !player.connected,
      ),
  );
  guest.terminate();
  await disconnectedStatePromise;

  const resumed = await fixture.peer();
  resumed.send({
    type: "room.resume",
    code: guestState.code,
    resumeToken: guestState.resumeToken,
  });
  const resumedState = await resumed.waitFor(
    (message) => message.type === "room.state" && message.selfId === guestState.selfId,
  );
  assert.equal(resumedState.selfId, guestState.selfId);
  assert.notEqual(resumedState.resumeToken, guestState.resumeToken);
  assert.equal(
    resumedState.players.find((player) => player.id === guestState.selfId)?.connected,
    true,
  );
});

test("removes timed-out guests and closes an active room after host timeout", async (t) => {
  const fixture = await startFixture({ reconnectGraceMs: 70 });
  t.after(() => fixture.close());
  const first = await createAndJoin(fixture);
  const guestRemoved = first.host.waitFor(
    (message) => message.type === "room.state" && message.players.length === 1,
  );
  first.guest.terminate();
  const afterRemoval = await guestRemoved;
  assert.equal(afterRemoval.players.length, 1);

  first.host.send({ type: "leave" });
  await first.host.waitFor(
    (message) => message.type === "room.closed" && message.reason === "HOST_LEFT",
  );

  const second = await createAndJoin(fixture);
  await readyAndStart(second.host, second.guest);
  const roomClosed = second.guest.waitFor(
    (message) => message.type === "room.closed" && message.reason === "HOST_TIMEOUT",
  );
  second.host.terminate();
  const closed = await roomClosed;
  assert.equal(closed.code, second.hostState.code);
  await delay(10);
  assert.equal(fixture.server.rooms.has(second.hostState.code), false);
});
