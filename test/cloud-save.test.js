import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../script.js", import.meta.url), "utf8");

function extract(name){
  const start = SOURCE.indexOf("function " + name);
  assert.ok(start >= 0, "missing function " + name);
  let depth = 0;
  for (let i = SOURCE.indexOf("{", start); i < SOURCE.length; i++){
    if (SOURCE[i] === "{") depth++;
    else if (SOURCE[i] === "}" && --depth === 0) return SOURCE.slice(start, i + 1);
  }
  throw new Error("unbalanced function " + name);
}

const context = vm.createContext({
  DIFFS:[{ key:"easy" }, { key:"normal" }, { key:"hard" }],
  MAPS:new Array(5).fill(null),
  aimAssist:true,
  diffIndex:1,
  mapIndex:0,
  DIF(){ return this.DIFFS[this.diffIndex]; },
  cloudPrefsRevision:2,
  state:"menu",
  netMode:"solo"
});
vm.runInContext([
  extract("preferenceSnapshot"),
  extract("normalizePreferenceRecord"),
  extract("choosePreferenceRecord"),
  extract("canApplyCloudPreferences"),
  "globalThis.api = { preferenceSnapshot, normalizePreferenceRecord, choosePreferenceRecord, canApplyCloudPreferences };"
].join("\n"), context);

const api = context.api;
const plain = value => JSON.parse(JSON.stringify(value));

test("cloud preferences accept only the versioned whitelist", () => {
  const fallback = {
    v:1, updatedAt:10, aimAssist:false, difficulty:"normal", preferredMap:2
  };
  const record = api.normalizePreferenceRecord({
    v:1,
    updatedAt:99.9,
    aimAssist:true,
    difficulty:"hard",
    preferredMap:4,
    toyOpenId:"must-not-be-persisted",
    serverUrl:"wss://example.invalid"
  }, fallback);
  assert.deepEqual(plain(record), {
    v:1, updatedAt:99, aimAssist:true, difficulty:"hard", preferredMap:4
  });
  assert.equal(Object.hasOwn(record, "toyOpenId"), false);
  assert.equal(Object.hasOwn(record, "serverUrl"), false);
  assert.equal(api.normalizePreferenceRecord({ v:2 }, fallback), null);
});

test("invalid cloud fields fall back without escaping allowed ranges", () => {
  const fallback = {
    v:1, updatedAt:10, aimAssist:false, difficulty:"easy", preferredMap:1
  };
  assert.deepEqual(plain(api.normalizePreferenceRecord({
    v:1,
    updatedAt:-5,
    aimAssist:"yes",
    difficulty:"nightmare",
    preferredMap:99
  }, fallback)), {
    v:1, updatedAt:0, aimAssist:false, difficulty:"easy", preferredMap:1
  });
});

test("newest preference record wins and cloud wins an exact tie", () => {
  const local = { updatedAt:20, source:"local" };
  const cloud = { updatedAt:30, source:"cloud" };
  assert.equal(api.choosePreferenceRecord(local, cloud), cloud);
  assert.equal(api.choosePreferenceRecord({ ...local, updatedAt:40 }, cloud).source, "local");
  assert.equal(api.choosePreferenceRecord({ ...local, updatedAt:30 }, cloud), cloud);
  assert.equal(api.choosePreferenceRecord(local, null), local);
});

test("late cloud reads cannot apply after a user change or during a match", () => {
  context.cloudPrefsRevision = 2;
  context.state = "menu";
  context.netMode = "solo";
  assert.equal(api.canApplyCloudPreferences(2), true);

  context.cloudPrefsRevision = 3;
  assert.equal(api.canApplyCloudPreferences(2), false);
  context.cloudPrefsRevision = 2;
  context.state = "play";
  assert.equal(api.canApplyCloudPreferences(2), false);
  context.state = "menu";
  context.netMode = "host";
  assert.equal(api.canApplyCloudPreferences(2), false);
});
