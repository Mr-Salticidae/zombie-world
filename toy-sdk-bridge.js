"use strict";

/* ============================================================
   Toy JS SDK 1.5.0 适配层
   - 所有能力先走 toy.isSupport()，不靠猜测或虚构联机 API。
   - getUserProfile 必须由用户点击触发；这里只返回昵称。
   - toyOpenId 不是鉴权凭证，因此不暴露、不存储、不传给联机服务器。
   - 云存储只读指定 key，并在调用 SDK 前校验 key 与 1KB value 上限。
   ============================================================ */
(function exposeToySdkBridge(global){
  const ABILITIES = Object.freeze([
    "getUserProfile",
    "getCloudStorage",
    "setCloudStorage",
    "removeCloudStorage",
    "submitScore",
    "getRankList",
    "getMyRank",
    "getChargeUnlock",
    "openChargePanel"
  ]);
  const CLOUD_VALUE_MAX_BYTES = 1024;
  const CLOUD_KEY_MAX_BYTES = 128;
  const ANY_PAID_TIER_FEN = 1;

  function sdk(){
    return global && global.toy ? global.toy : null;
  }

  async function isSupported(ability){
    const toy = sdk();
    if (!ABILITIES.includes(ability) || !toy ||
        typeof toy.isSupport !== "function" || typeof toy[ability] !== "function"){
      return false;
    }
    try {
      return (await toy.isSupport(ability)) === true;
    } catch (_) {
      return false;
    }
  }

  async function detect(){
    const values = await Promise.all(ABILITIES.map(isSupported));
    const result = {};
    ABILITIES.forEach((ability, index) => { result[ability] = values[index]; });
    return Object.freeze(result);
  }

  function normalizeNickname(value, maxLength){
    const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 12;
    return Array.from(String(value || "").trim().replace(/\s+/gu, " "))
      .slice(0, limit)
      .join("");
  }

  async function requestNickname(){
    const toy = sdk();
    if (!toy || typeof toy.getUserProfile !== "function"){
      throw new Error("当前环境不支持读取 B站资料");
    }

    // 保持 getUserProfile 在按钮点击调用栈内立即执行，以满足“用户操作触发”。
    const profilePromise = toy.getUserProfile();
    const profile = await profilePromise;
    const nickname = normalizeNickname(profile && profile.nickname, 12);
    if (!nickname) throw new Error("没有读取到可用的 B站昵称");

    // 有意不返回 avatar / toyOpenId；联机目前只需要昵称，遵循数据最小化。
    return nickname;
  }

  async function requestChargeUnlock(){
    const toy = sdk();
    if (!toy || typeof toy.getChargeUnlock !== "function") return { status:"unsupported", unlocked:false };
    const result = await toy.getChargeUnlock({ minPrice:ANY_PAID_TIER_FEN });
    return { status:result?.status ?? "unavailable", unlocked:result?.status === "ok" && result.data?.unlocked === true };
  }

  async function openCreatorChargePanel(){
    const toy = sdk();
    if (!toy || typeof toy.openChargePanel !== "function") throw new Error("当前环境不支持打开充电面板");
    // SDK 要求在用户点击的调用栈内打开官方面板。
    return toy.openChargePanel({ minPrice:ANY_PAID_TIER_FEN });
  }

  function utf8Bytes(value){
    return new TextEncoder().encode(String(value)).byteLength;
  }

  function validateCloudKey(value){
    const key = String(value || "");
    if (!key || key.startsWith("__") || !/^[A-Za-z0-9_-]+$/.test(key) ||
        utf8Bytes(key) > CLOUD_KEY_MAX_BYTES){
      throw new TypeError("云存储 key 不合法");
    }
    return key;
  }

  async function requireAbility(ability){
    if (!(await isSupported(ability))){
      throw new Error("当前环境不支持 " + ability);
    }
    return sdk();
  }

  async function getCloudJson(keyValue){
    const key = validateCloudKey(keyValue);
    const toy = await requireAbility("getCloudStorage");
    const items = await toy.getCloudStorage([key]);
    if (!items || !Object.prototype.hasOwnProperty.call(items, key) ||
        typeof items[key] !== "string") return null;
    try {
      return JSON.parse(items[key]);
    } catch (_) {
      return null;
    }
  }

  async function setCloudJson(keyValue, value){
    const key = validateCloudKey(keyValue);
    let encoded;
    try {
      encoded = JSON.stringify(value);
    } catch (_) {
      throw new TypeError("云存档必须是可序列化的 JSON");
    }
    if (typeof encoded !== "string"){
      throw new TypeError("云存档必须是可序列化的 JSON");
    }
    if (utf8Bytes(encoded) > CLOUD_VALUE_MAX_BYTES){
      throw new RangeError("云存档超过 1024 字节");
    }
    const toy = await requireAbility("setCloudStorage");
    await toy.setCloudStorage({ [key]:encoded });
  }

  async function removeCloudKeys(keyValues){
    if (!Array.isArray(keyValues) || !keyValues.length){
      throw new TypeError("至少需要一个云存储 key");
    }
    const keys = Array.from(new Set(keyValues.map(validateCloudKey)));
    const toy = await requireAbility("removeCloudStorage");
    await toy.removeCloudStorage(keys);
  }

  global.ZombieToyBridge = Object.freeze({
    abilities:ABILITIES,
    detect,
    isSupported,
    normalizeNickname,
    requestNickname,
    requestChargeUnlock,
    openCreatorChargePanel,
    getCloudJson,
    setCloudJson,
    removeCloudKeys
  });
})(typeof window !== "undefined" ? window : globalThis);
