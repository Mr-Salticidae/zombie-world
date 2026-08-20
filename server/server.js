import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");

const DEFAULT_RECONNECT_GRACE_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_MESSAGE_BYTES = 512 * 1024;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 10_000;
const DEFAULT_RATE_LIMIT_MAX_MESSAGES = 600;
const DEFAULT_MAX_SNAPSHOT_BYTES = 256 * 1024;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 40;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 128;
const DEFAULT_MAX_ROOMS = 64;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CLIENT_MESSAGE_TYPES = new Set([
  "room.create",
  "room.join",
  "room.resume",
  "room.ready",
  "room.config",
  "match.start",
  "match.finish",
  "input",
  "snapshot",
  "leave",
  "ping",
]);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeName(value) {
  if (typeof value !== "string") {
    throw new ProtocolError("INVALID_NAME", "Player name must be a string.");
  }
  const name = value.trim().replace(/\s+/gu, " ");
  const length = Array.from(name).length;
  if (length < 1 || length > 24) {
    throw new ProtocolError("INVALID_NAME", "Player name must contain 1 to 24 characters.");
  }
  return name;
}

function normalizeRoomCode(value) {
  if (typeof value !== "string") {
    throw new ProtocolError("INVALID_ROOM_CODE", "Room code must be a string.");
  }
  const code = value.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/u.test(code)) {
    throw new ProtocolError("INVALID_ROOM_CODE", "Room code must contain exactly 6 valid characters.");
  }
  return code;
}

function normalizeCapacity(value) {
  const capacity = value ?? 4;
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 4) {
    throw new ProtocolError("INVALID_CAPACITY", "Room capacity must be an integer from 2 to 4.");
  }
  return capacity;
}

function normalizeMapIndex(value) {
  const mapIndex = value ?? 0;
  if (!Number.isInteger(mapIndex) || mapIndex < 0 || mapIndex > 4) {
    throw new ProtocolError("INVALID_MAP", "Map index must be an integer from 0 to 4.");
  }
  return mapIndex;
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    slot: player.slot,
    ready: player.ready,
    connected: player.connected,
  };
}

function playerList(room) {
  return [...room.players.values()]
    .sort((a, b) => a.slot - b.slot)
    .map(publicPlayer);
}

function randomRoomCode() {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function newResumeToken() {
  return randomBytes(24).toString("base64url");
}

function byteLength(data) {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return Number.POSITIVE_INFINITY;
}

function safeSend(ws, payload, options = {}) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  const encoded = JSON.stringify(payload);
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  if (ws.bufferedAmount + Buffer.byteLength(encoded) > maxBufferedBytes) {
    if (!options.dropIfBackpressured) ws.close(1013, "Client is too slow");
    return false;
  }
  ws.send(encoded);
  return true;
}

function sendError(ws, error, requestType) {
  const protocolError = error instanceof ProtocolError
    ? error
    : new ProtocolError("INTERNAL_ERROR", "Unexpected server error.");
  safeSend(ws, {
    type: "error",
    code: protocolError.code,
    message: protocolError.message,
    requestType,
  });
}

function staticFileHandler(staticRoot) {
  const resolvedRoot = path.resolve(staticRoot);
  const rootPrefix = `${resolvedRoot}${path.sep}`;
  const privateTopLevelPaths = new Set([
    ".agents",
    ".claude",
    ".git",
    "node_modules",
    "server",
    "test",
    "tools",
  ]);

  return (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end("Method Not Allowed");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      response.writeHead(400);
      response.end("Bad Request");
      return;
    }

    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^[/\\]+/u, "");
    const pathSegments = relativePath.replaceAll("\\", "/").split("/");
    const firstSegment = pathSegments[0].toLowerCase();
    if (
      firstSegment.startsWith(".")
      || privateTopLevelPaths.has(firstSegment)
      || /^package(?:-lock)?\.json$/iu.test(relativePath)
    ) {
      response.writeHead(404);
      response.end("Not Found");
      return;
    }
    let filePath = path.resolve(resolvedRoot, relativePath);
    if (filePath !== resolvedRoot && !filePath.startsWith(rootPrefix)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    const normalizedRelative = path.relative(resolvedRoot, filePath).replaceAll("\\", "/");
    const normalizedSegments = normalizedRelative.split("/");
    const normalizedTopLevel = normalizedSegments[0].toLowerCase();
    if (
      normalizedTopLevel.startsWith(".")
      || privateTopLevelPaths.has(normalizedTopLevel)
      || /^package(?:-lock)?\.json$/iu.test(normalizedRelative)
    ) {
      response.writeHead(404);
      response.end("Not Found");
      return;
    }

    let fileStats;
    try {
      fileStats = statSync(filePath);
      if (fileStats.isDirectory()) {
        filePath = path.join(filePath, "index.html");
        fileStats = statSync(filePath);
      }
      if (!fileStats.isFile()) throw new Error("Not a file");
    } catch {
      response.writeHead(404);
      response.end("Not Found");
      return;
    }

    const headers = {
      "Content-Type": CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
      "Content-Length": fileStats.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  };
}

function sanitizeInput(message, playerId) {
  if (!Number.isSafeInteger(message.seq) || message.seq < 0) {
    throw new ProtocolError("INVALID_INPUT", "Input seq must be a non-negative safe integer.");
  }

  const input = {
    type: "input",
    playerId,
    seq: message.seq,
  };
  for (const field of ["mx", "my", "ax", "ay"]) {
    if (message[field] === undefined) continue;
    if (!finiteNumber(message[field]) || Math.abs(message[field]) > 1) {
      throw new ProtocolError("INVALID_INPUT", `${field} must be a finite number from -1 to 1.`);
    }
    input[field] = message[field];
  }
  if (message.fire !== undefined) {
    if (typeof message.fire !== "boolean") {
      throw new ProtocolError("INVALID_INPUT", "fire must be a boolean.");
    }
    input.fire = message.fire;
  }
  if (message.weapon !== undefined) {
    if (!Number.isInteger(message.weapon) || message.weapon < 0 || message.weapon > 8) {
      throw new ProtocolError("INVALID_INPUT", "weapon must be an integer from 0 to 8.");
    }
    input.weapon = message.weapon;
  }
  if (message.ultSeq !== undefined) {
    if (!Number.isSafeInteger(message.ultSeq) || message.ultSeq < 0) {
      throw new ProtocolError("INVALID_INPUT", "ultSeq must be a non-negative safe integer.");
    }
    input.ultSeq = message.ultSeq;
  }
  if (message.clientTime !== undefined) {
    if (!finiteNumber(message.clientTime) || message.clientTime < 0) {
      throw new ProtocolError("INVALID_INPUT", "clientTime must be a non-negative finite number.");
    }
    input.clientTime = message.clientTime;
  }
  return input;
}

function validateSnapshot(message) {
  if (message.tick !== undefined && (!Number.isSafeInteger(message.tick) || message.tick < 0)) {
    throw new ProtocolError("INVALID_SNAPSHOT", "Snapshot tick must be a non-negative safe integer.");
  }
  if (message.simTime !== undefined && (!finiteNumber(message.simTime) || message.simTime < 0)) {
    throw new ProtocolError("INVALID_SNAPSHOT", "Snapshot simTime must be a non-negative finite number.");
  }
  if (message.state !== undefined && !isRecord(message.state)) {
    throw new ProtocolError("INVALID_SNAPSHOT", "Snapshot state must be an object.");
  }
}

function normalizeAllowedOrigins(value) {
  if (value === undefined || value === null) return null;
  const entries = typeof value === "string"
    ? value.split(",")
    : value instanceof Set || Array.isArray(value)
      ? [...value]
      : null;
  if (!entries) {
    throw new TypeError("allowedOrigins must be a string, array or Set.");
  }

  const origins = new Set();
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new TypeError("allowedOrigins entries must be non-empty strings.");
    }
    let origin;
    try {
      origin = new URL(entry.trim()).origin;
    } catch {
      throw new TypeError(`Invalid allowed origin: ${entry}`);
    }
    if (origin === "null") {
      throw new TypeError(`Invalid allowed origin: ${entry}`);
    }
    origins.add(origin);
  }
  return origins;
}

function requestOrigin(request) {
  const header = request.headers.origin;
  if (typeof header !== "string" || header.trim() === "") return null;
  try {
    const origin = new URL(header).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export function createGameServer(options = {}) {
  const staticRoot = path.resolve(options.staticRoot ?? PROJECT_ROOT);
  const wsPath = options.wsPath ?? "/ws";
  const reconnectGraceMs = options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const rateLimitMaxMessages = options.rateLimitMaxMessages ?? DEFAULT_RATE_LIMIT_MAX_MESSAGES;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const snapshotIntervalMs = options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
  const codeGenerator = options.codeGenerator ?? randomRoomCode;
  const logger = options.logger ?? console;

  if (!Number.isFinite(reconnectGraceMs) || reconnectGraceMs < 0) {
    throw new TypeError("reconnectGraceMs must be a non-negative number.");
  }
  if (!Number.isFinite(maxMessageBytes) || maxMessageBytes < 1024) {
    throw new TypeError("maxMessageBytes must be at least 1024.");
  }
  if (!Number.isFinite(rateLimitWindowMs) || rateLimitWindowMs <= 0) {
    throw new TypeError("rateLimitWindowMs must be a positive number.");
  }
  if (!Number.isSafeInteger(rateLimitMaxMessages) || rateLimitMaxMessages < 1) {
    throw new TypeError("rateLimitMaxMessages must be a positive safe integer.");
  }
  for (const [name, value] of Object.entries({
    maxSnapshotBytes,
    snapshotIntervalMs,
    maxBufferedBytes,
    maxConnections,
    maxRooms,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }

  const rooms = new Map();
  const clients = new Map();
  const httpServer = createServer(staticFileHandler(staticRoot));
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: maxMessageBytes,
    // 快照是重复度极高的 JSON，permessage-deflate 实测能压到约 1/2.9——
    // 每个客机从 80 KB/s 降到 28 KB/s，中转带宽是这台机器最贵的东西，必须开。
    // concurrencyLimit 挡住「一堆房间同时刷快照把 CPU 吃光」；
    // threshold 以下的小包（输入、心跳、房间状态）不压，压了反而更大。
    perMessageDeflate: {
      zlibDeflateOptions: { level: 6, memLevel: 8 },
      concurrencyLimit: 10,
      threshold: 512,
      serverNoContextTakeover: false,   // 保留上下文：连续快照之间高度相似，字典复用省得多
      clientNoContextTakeover: false,
    },
  });
  let heartbeatTimer = null;
  let listening = false;
  let closing = false;

  function makeUniqueRoomCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = normalizeRoomCode(codeGenerator());
      if (!rooms.has(code)) return code;
    }
    throw new ProtocolError("ROOM_CODE_EXHAUSTED", "Unable to allocate a unique room code.");
  }

  function roomForClient(client) {
    const room = rooms.get(client.roomCode);
    const player = room?.players.get(client.playerId);
    if (!room || !player) {
      throw new ProtocolError("NOT_IN_ROOM", "Join or create a room first.");
    }
    return { room, player };
  }

  function requireFreshClient(client) {
    if (client.roomCode || client.playerId) {
      throw new ProtocolError("ALREADY_IN_ROOM", "Leave the current room before joining another.");
    }
  }

  function requireLobby(room) {
    if (room.phase !== "lobby") {
      throw new ProtocolError("INVALID_PHASE", "This action is only available in the lobby.");
    }
  }

  function requirePlaying(room) {
    if (room.phase !== "playing") {
      throw new ProtocolError("INVALID_PHASE", "The match has not started.");
    }
  }

  function requireHost(room, player) {
    if (room.hostId !== player.id) {
      throw new ProtocolError("FORBIDDEN", "Only the room host may perform this action.");
    }
  }

  function sendRoomStateTo(room, player) {
    if (!player.connected || !player.ws) return;
    safeSend(player.ws, {
      type: "room.state",
      selfId: player.id,
      resumeToken: player.resumeToken,
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      mapIndex: room.mapIndex,
      capacity: room.capacity,
      players: playerList(room),
    });
  }

  function broadcastRoomState(room) {
    for (const player of room.players.values()) {
      sendRoomStateTo(room, player);
    }
  }

  function broadcast(room, payload, predicate = () => true, sendOptions) {
    for (const player of room.players.values()) {
      if (player.connected && player.ws && predicate(player)) {
        safeSend(player.ws, payload, sendOptions);
      }
    }
  }

  function clearPlayerTimer(player) {
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
  }

  function clearClientMembership(player) {
    if (!player.ws) return;
    const client = clients.get(player.ws);
    if (client && client.playerId === player.id) {
      client.roomCode = null;
      client.playerId = null;
    }
  }

  function closeRoom(room, reason) {
    if (!room || room.closed) return;
    room.closed = true;
    rooms.delete(room.code);
    for (const player of room.players.values()) {
      clearPlayerTimer(player);
      clearClientMembership(player);
      if (player.connected && player.ws) {
        safeSend(player.ws, {
          type: "room.closed",
          code: room.code,
          reason,
        });
      }
      player.connected = false;
      player.ws = null;
    }
    room.players.clear();
  }

  function removeGuest(room, player, reason = "LEFT") {
    clearPlayerTimer(player);
    room.players.delete(player.id);
    clearClientMembership(player);
    if (player.connected && player.ws) {
      safeSend(player.ws, {
        type: "room.closed",
        code: room.code,
        reason,
      });
    }
    player.connected = false;
    player.ws = null;
    if (room.players.size === 0) rooms.delete(room.code);
    else broadcastRoomState(room);
  }

  function nextOpenSlot(room) {
    const used = new Set([...room.players.values()].map((player) => player.slot));
    for (let slot = 0; slot < room.capacity; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    return -1;
  }

  function attachPlayer(client, room, player) {
    client.roomCode = room.code;
    client.playerId = player.id;
    player.connected = true;
    player.disconnectedAt = null;
    player.ws = client.ws;
    clearPlayerTimer(player);
  }

  function makePlayer(name, slot, ws) {
    return {
      id: randomUUID(),
      name,
      slot,
      ready: false,
      connected: true,
      resumeToken: newResumeToken(),
      disconnectedAt: null,
      disconnectTimer: null,
      ws,
    };
  }

  function handleCreate(client, message) {
    requireFreshClient(client);
    if (rooms.size >= maxRooms) {
      throw new ProtocolError("SERVER_BUSY", "The room limit has been reached.");
    }
    const capacity = normalizeCapacity(message.capacity);
    const mapIndex = normalizeMapIndex(message.mapIndex);
    const player = makePlayer(normalizeName(message.name), 0, client.ws);
    const room = {
      code: makeUniqueRoomCode(),
      hostId: player.id,
      phase: "lobby",
      mapIndex,
      capacity,
      players: new Map([[player.id, player]]),
      createdAt: Date.now(),
      closed: false,
    };
    rooms.set(room.code, room);
    attachPlayer(client, room, player);
    broadcastRoomState(room);
  }

  function handleJoin(client, message) {
    requireFreshClient(client);
    const code = normalizeRoomCode(message.code);
    const room = rooms.get(code);
    if (!room || room.closed) {
      throw new ProtocolError("ROOM_NOT_FOUND", "Room not found.");
    }
    requireLobby(room);
    if (room.players.size >= room.capacity) {
      throw new ProtocolError("ROOM_FULL", "The room is full.");
    }
    const slot = nextOpenSlot(room);
    if (slot < 0) {
      throw new ProtocolError("ROOM_FULL", "The room is full.");
    }
    const player = makePlayer(normalizeName(message.name), slot, client.ws);
    room.players.set(player.id, player);
    attachPlayer(client, room, player);
    broadcastRoomState(room);
  }

  function handleResume(client, message) {
    requireFreshClient(client);
    const code = normalizeRoomCode(message.code);
    if (typeof message.resumeToken !== "string" || message.resumeToken.length < 16 || message.resumeToken.length > 128) {
      throw new ProtocolError("INVALID_RESUME_TOKEN", "Reconnect token is invalid.");
    }
    const room = rooms.get(code);
    if (!room || room.closed) {
      throw new ProtocolError("ROOM_NOT_FOUND", "Room not found.");
    }
    const player = [...room.players.values()]
      .find((candidate) => candidate.resumeToken === message.resumeToken);
    if (!player) {
      throw new ProtocolError("RESUME_FAILED", "Reconnect token is invalid or expired.");
    }

    const previousWs = player.ws;
    if (previousWs && previousWs !== client.ws) {
      const previousClient = clients.get(previousWs);
      if (previousClient) {
        previousClient.roomCode = null;
        previousClient.playerId = null;
      }
    }

    player.resumeToken = newResumeToken();
    attachPlayer(client, room, player);
    if (previousWs && previousWs !== client.ws && previousWs.readyState === WebSocket.OPEN) {
      previousWs.close(4001, "Session resumed elsewhere");
    }
    broadcastRoomState(room);
  }

  function handleReady(client, message) {
    const { room, player } = roomForClient(client);
    requireLobby(room);
    if (typeof message.ready !== "boolean") {
      throw new ProtocolError("INVALID_READY", "ready must be a boolean.");
    }
    player.ready = message.ready;
    broadcastRoomState(room);
  }

  function handleConfig(client, message) {
    const { room, player } = roomForClient(client);
    requireLobby(room);
    requireHost(room, player);
    room.mapIndex = normalizeMapIndex(message.mapIndex);
    broadcastRoomState(room);
  }

  function handleStart(client) {
    const { room, player } = roomForClient(client);
    requireLobby(room);
    requireHost(room, player);
    const players = [...room.players.values()];
    if (players.length < 2) {
      throw new ProtocolError("MIN_PLAYERS", "At least two players are required.");
    }
    if (players.some((candidate) => !candidate.connected)) {
      throw new ProtocolError("PLAYER_DISCONNECTED", "All players must be connected before starting.");
    }
    if (players.some((candidate) => !candidate.ready)) {
      throw new ProtocolError("NOT_READY", "All players must be ready before starting.");
    }
    room.phase = "playing";
    broadcastRoomState(room);
    broadcast(room, {
      type: "match.start",
      code: room.code,
      hostId: room.hostId,
      mapIndex: room.mapIndex,
      players: playerList(room),
      startedAt: Date.now(),
    });
  }

  function handleFinish(client) {
    const { room, player } = roomForClient(client);
    requirePlaying(room);
    requireHost(room, player);
    room.phase = "lobby";
    for (const candidate of room.players.values()) {
      candidate.ready = false;
    }
    broadcastRoomState(room);
  }

  function handleInput(client, message) {
    const { room, player } = roomForClient(client);
    requirePlaying(room);
    const input = sanitizeInput(message, player.id);
    if (player.id === room.hostId) return;
    const host = room.players.get(room.hostId);
    if (!host?.connected || !host.ws) {
      throw new ProtocolError("HOST_UNAVAILABLE", "Room host is reconnecting.");
    }
    safeSend(host.ws, input);
  }

  function handleSnapshot(client, message) {
    const { room, player } = roomForClient(client);
    requirePlaying(room);
    requireHost(room, player);
    const now = Date.now();
    if (now - client.lastSnapshotAt < snapshotIntervalMs) return;
    if (Buffer.byteLength(JSON.stringify(message)) > maxSnapshotBytes) {
      throw new ProtocolError("INVALID_SNAPSHOT", "Snapshot payload is too large.");
    }
    client.lastSnapshotAt = now;
    validateSnapshot(message);
    const snapshot = { ...message, type: "snapshot" };
    broadcast(
      room,
      snapshot,
      (candidate) => candidate.id !== room.hostId,
      { dropIfBackpressured:true, maxBufferedBytes },
    );
  }

  function handleLeave(client) {
    const { room, player } = roomForClient(client);
    if (player.id === room.hostId) closeRoom(room, "HOST_LEFT");
    else removeGuest(room, player);
  }

  function handleMessage(client, message) {
    if (!isRecord(message) || typeof message.type !== "string") {
      throw new ProtocolError("INVALID_MESSAGE", "Message must be an object with a string type.");
    }
    if (!CLIENT_MESSAGE_TYPES.has(message.type)) {
      throw new ProtocolError("UNKNOWN_TYPE", `Unsupported message type: ${message.type}`);
    }
    switch (message.type) {
      case "room.create":
        handleCreate(client, message);
        break;
      case "room.join":
        handleJoin(client, message);
        break;
      case "room.resume":
        handleResume(client, message);
        break;
      case "room.ready":
        handleReady(client, message);
        break;
      case "room.config":
        handleConfig(client, message);
        break;
      case "match.start":
        handleStart(client);
        break;
      case "match.finish":
        handleFinish(client);
        break;
      case "input":
        handleInput(client, message);
        break;
      case "snapshot":
        handleSnapshot(client, message);
        break;
      case "leave":
        handleLeave(client);
        break;
      case "ping":
        safeSend(client.ws, {
          type: "pong",
          serverTime: Date.now(),
        }, { maxBufferedBytes });
        break;
      default:
        throw new ProtocolError("UNKNOWN_TYPE", `Unsupported message type: ${message.type}`);
    }
  }

  function expireDisconnectedPlayer(room, player) {
    if (room.closed || player.connected || room.players.get(player.id) !== player) return;
    if (player.id === room.hostId) {
      closeRoom(room, "HOST_TIMEOUT");
    } else {
      room.players.delete(player.id);
      clearPlayerTimer(player);
      if (room.players.size === 0) rooms.delete(room.code);
      else broadcastRoomState(room);
    }
  }

  function detachClient(client) {
    const room = rooms.get(client.roomCode);
    const player = room?.players.get(client.playerId);
    if (!room || !player || player.ws !== client.ws) return;
    player.connected = false;
    player.ws = null;
    player.disconnectedAt = Date.now();
    client.roomCode = null;
    client.playerId = null;
    clearPlayerTimer(player);
    player.disconnectTimer = setTimeout(
      () => expireDisconnectedPlayer(room, player),
      reconnectGraceMs,
    );
    player.disconnectTimer.unref?.();
    broadcastRoomState(room);
  }

  wss.on("connection", (ws) => {
    const client = {
      ws,
      connectionId: randomUUID(),
      roomCode: null,
      playerId: null,
      lastPongAt: Date.now(),
      messageTimes: [],
      rateLimited: false,
      lastSnapshotAt: 0,
    };
    clients.set(ws, client);
    safeSend(ws, {
      type: "session",
      connectionId: client.connectionId,
      reconnectGraceMs,
      heartbeatIntervalMs,
    });

    ws.on("pong", () => {
      client.lastPongAt = Date.now();
    });

    ws.on("message", (data, isBinary) => {
      let requestType;
      try {
        if (client.rateLimited) return;
        const now = Date.now();
        const cutoff = now - rateLimitWindowMs;
        let expiredCount = 0;
        while (
          expiredCount < client.messageTimes.length
          && client.messageTimes[expiredCount] <= cutoff
        ) {
          expiredCount += 1;
        }
        if (expiredCount > 0) client.messageTimes.splice(0, expiredCount);
        if (client.messageTimes.length >= rateLimitMaxMessages) {
          client.rateLimited = true;
          sendError(
            ws,
            new ProtocolError(
              "RATE_LIMITED",
              `Message rate exceeds ${rateLimitMaxMessages} per ${rateLimitWindowMs}ms.`,
            ),
            "rate-limit",
          );
          ws.close(1008, "Message rate limit exceeded");
          return;
        }
        client.messageTimes.push(now);
        if (isBinary) {
          throw new ProtocolError("BINARY_NOT_SUPPORTED", "Only JSON text messages are accepted.");
        }
        if (byteLength(data) > maxMessageBytes) {
          ws.close(1009, "Message too large");
          return;
        }
        let message;
        try {
          message = JSON.parse(data.toString("utf8"));
        } catch {
          throw new ProtocolError("INVALID_JSON", "Message is not valid JSON.");
        }
        requestType = isRecord(message) ? message.type : undefined;
        handleMessage(client, message);
      } catch (error) {
        if (!(error instanceof ProtocolError)) {
          logger.error?.("WebSocket message handler failed", error);
        }
        sendError(ws, error, requestType);
      }
    });

    ws.on("close", () => {
      detachClient(client);
      clients.delete(ws);
    });

    ws.on("error", (error) => {
      logger.warn?.("WebSocket connection error", error);
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== wsPath) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (wss.clients.size >= maxConnections) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const origin = requestOrigin(request);
    if (allowedOrigins && (!origin || !allowedOrigins.has(origin))) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const ws of wss.clients) {
        const client = clients.get(ws);
        if (!client) continue;
        if (now - client.lastPongAt > heartbeatTimeoutMs) {
          ws.terminate();
          continue;
        }
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  async function listen(port = 0, host = "127.0.0.1") {
    if (listening) throw new Error("Server is already listening.");
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, host);
    });
    listening = true;
    return httpServer.address();
  }

  async function close() {
    if (closing) return;
    closing = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    for (const room of rooms.values()) {
      for (const player of room.players.values()) clearPlayerTimer(player);
    }
    rooms.clear();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (listening) {
      await new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      listening = false;
    }
  }

  return {
    httpServer,
    wss,
    rooms,
    clients,
    listen,
    close,
    address: () => httpServer.address(),
    options: {
      staticRoot,
      wsPath,
      reconnectGraceMs,
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      maxMessageBytes,
      rateLimitWindowMs,
      rateLimitMaxMessages,
      maxSnapshotBytes,
      snapshotIntervalMs,
      maxBufferedBytes,
      maxConnections,
      maxRooms,
      allowedOrigins: allowedOrigins ? [...allowedOrigins] : null,
    },
  };
}

const runtimeProcess = globalThis.process;
const isDirectRun = runtimeProcess?.argv?.[1]
  && import.meta.url === pathToFileURL(path.resolve(runtimeProcess.argv[1])).href;

if (isDirectRun) {
  const port = Number.parseInt(runtimeProcess.env.PORT ?? "8080", 10);
  const host = runtimeProcess.env.HOST ?? "127.0.0.1";
  const allowedOrigins = runtimeProcess.env.ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(host) && !allowedOrigins?.length) {
    console.error("ALLOWED_ORIGINS is required when HOST is not loopback.");
    runtimeProcess.exitCode = 1;
  } else {
    const gameServer = createGameServer({
      allowedOrigins: allowedOrigins?.length ? allowedOrigins : undefined,
    });
    gameServer.listen(port, host)
      .then(() => {
        console.log(`Zombie World listening on http://${host}:${port}`);
      })
      .catch((error) => {
        console.error(error);
        runtimeProcess.exitCode = 1;
      });

    const shutdown = async () => {
      await gameServer.close();
      runtimeProcess.exit(0);
    };
    runtimeProcess.once("SIGINT", shutdown);
    runtimeProcess.once("SIGTERM", shutdown);
  }
}
