import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../toy-sdk-bridge.js", import.meta.url), "utf8");

function loadBridge(toy){
  const window = { toy };
  const context = vm.createContext({ window, globalThis:window, TextEncoder });
  vm.runInContext(SOURCE, context, { filename:"toy-sdk-bridge.js" });
  return window.ZombieToyBridge;
}

function sdk(overrides = {}){
  return {
    isSupport:async () => true,
    getUserProfile:async () => ({ nickname:"幸存者" }),
    getCloudStorage:async () => ({}),
    setCloudStorage:async () => {},
    removeCloudStorage:async () => {},
    submitScore:async () => ({ score:1 }),
    getRankList:async () => [],
    getMyRank:async () => ({ ranked:false, rank:0, score:0 }),
    ...overrides
  };
}

test("detect probes every Toy ability through isSupport", async () => {
  const seen = [];
  const bridge = loadBridge(sdk({
    isSupport:async ability => {
      seen.push(ability);
      return ability !== "getMyRank";
    }
  }));

  const result = await bridge.detect();
  assert.deepEqual(seen, [
    "getUserProfile", "getCloudStorage", "setCloudStorage", "removeCloudStorage",
    "submitScore", "getRankList", "getMyRank"
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    getUserProfile:true,
    getCloudStorage:true,
    setCloudStorage:true,
    removeCloudStorage:true,
    submitScore:true,
    getRankList:true,
    getMyRank:false
  });
});

test("unsupported, missing and rejected abilities degrade to false", async () => {
  const toy = sdk({
    isSupport:async ability => {
      if (ability === "getRankList") throw new Error("unsupported");
      return true;
    }
  });
  delete toy.submitScore;
  const bridge = loadBridge(toy);

  assert.equal(await bridge.isSupported("submitScore"), false);
  assert.equal(await bridge.isSupported("getRankList"), false);
  assert.equal(await bridge.isSupported("notARealToyAbility"), false);
});

test("requestNickname invokes getUserProfile immediately and discards identifiers", async () => {
  let called = false;
  const bridge = loadBridge(sdk({
    getUserProfile(){
      called = true;
      return Promise.resolve({
        nickname:"  B站  幸存者  123456  ",
        avatar:"https://example.invalid/avatar.png",
        toyOpenId:"must-not-leave-the-bridge"
      });
    }
  }));

  const request = bridge.requestNickname();
  assert.equal(called, true);
  assert.equal(await request, "B站 幸存者 12345");
});

test("nickname normalization counts Unicode code points and keeps manual fallback safe", () => {
  const bridge = loadBridge(null);
  assert.equal(bridge.normalizeNickname("  🧟🧟🧟  玩家  ", 5), "🧟🧟🧟 玩");
  assert.equal(bridge.normalizeNickname(null), "");
});

test("requestNickname fails cleanly without the SDK", async () => {
  const bridge = loadBridge(null);
  await assert.rejects(bridge.requestNickname(), /不支持读取 B站资料/);
});

test("cloud JSON reads only the requested key and tolerates missing or malformed values", async () => {
  const seen = [];
  const bridge = loadBridge(sdk({
    getCloudStorage:async keys => {
      seen.push(keys);
      return { prefs_v1:'{"v":1,"difficulty":"normal"}' };
    }
  }));

  assert.deepEqual(
    JSON.parse(JSON.stringify(await bridge.getCloudJson("prefs_v1"))),
    { v:1, difficulty:"normal" }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [["prefs_v1"]]);

  const missing = loadBridge(sdk({ getCloudStorage:async () => ({}) }));
  assert.equal(await missing.getCloudJson("prefs_v1"), null);
  const malformed = loadBridge(sdk({ getCloudStorage:async () => ({ prefs_v1:"{" }) }));
  assert.equal(await malformed.getCloudJson("prefs_v1"), null);
});

test("cloud keys are validated before the SDK is called", async () => {
  let calls = 0;
  const bridge = loadBridge(sdk({
    getCloudStorage:async () => { calls++; return {}; },
    setCloudStorage:async () => { calls++; },
    removeCloudStorage:async () => { calls++; }
  }));
  const invalid = ["", "__reserved", "has.dot", "中文", "a".repeat(129)];
  for (const key of invalid){
    await assert.rejects(bridge.getCloudJson(key), /key/);
    await assert.rejects(bridge.setCloudJson(key, {}), /key/);
  }
  await assert.rejects(bridge.removeCloudKeys([]), /至少需要/);
  assert.equal(calls, 0);
});

test("cloud writes exact JSON and enforces the 1024 byte UTF-8 limit", async () => {
  const payloads = [];
  const bridge = loadBridge(sdk({ setCloudStorage:async items => { payloads.push(items); } }));
  await bridge.setCloudJson("prefs_v1", { v:1, difficulty:"hard" });
  assert.deepEqual(JSON.parse(JSON.stringify(payloads)), [
    { prefs_v1:'{"v":1,"difficulty":"hard"}' }
  ]);

  const exact = "a".repeat(1022); // JSON quotes add two bytes.
  await bridge.setCloudJson("limit", exact);
  assert.equal(new TextEncoder().encode(payloads[1].limit).byteLength, 1024);
  await assert.rejects(bridge.setCloudJson("limit", "🧟".repeat(256)), /1024/);

  const circular = {};
  circular.self = circular;
  const before = payloads.length;
  await assert.rejects(bridge.setCloudJson("prefs_v1", circular), /JSON/);
  assert.equal(payloads.length, before);
});

test("unsupported cloud abilities never call their SDK methods", async () => {
  let calls = 0;
  const bridge = loadBridge(sdk({
    isSupport:async ability => !ability.includes("CloudStorage"),
    getCloudStorage:async () => { calls++; return {}; },
    setCloudStorage:async () => { calls++; },
    removeCloudStorage:async () => { calls++; }
  }));
  await assert.rejects(bridge.getCloudJson("prefs_v1"), /不支持/);
  await assert.rejects(bridge.setCloudJson("prefs_v1", { v:1 }), /不支持/);
  await assert.rejects(bridge.removeCloudKeys(["prefs_v1"]), /不支持/);
  assert.equal(calls, 0);
});

test("cloud delete de-duplicates validated keys and propagates SDK errors", async () => {
  const removed = [];
  const bridge = loadBridge(sdk({ removeCloudStorage:async keys => { removed.push(keys); } }));
  await bridge.removeCloudKeys(["prefs_v1", "prefs_v1", "progress-v1"]);
  assert.deepEqual(JSON.parse(JSON.stringify(removed)), [["prefs_v1", "progress-v1"]]);

  const rejected = loadBridge(sdk({
    getCloudStorage:async () => { throw new Error("not logged in"); }
  }));
  await assert.rejects(rejected.getCloudJson("prefs_v1"), /not logged in/);
});
