import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { makeTempRoot } from "../helpers/temp-root.mjs";
import {
  resolveEntitlement,
  activateByEmail,
  assertAllowed,
  EntitlementError,
  CACHE_FILE,
} from "../../core/entitlement.mjs";

/** @param {object} body */
const fakeFetch = (body) => async () => ({ ok: true, json: async () => body });
const failingFetch = async () => {
  throw new Error("network down");
};

function setup(t) {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  return { ashuraHome: tmp.root, cwd: tmp.root };
}

test("should be free without a member key", async (t) => {
  const s = setup(t);
  const e = await resolveEntitlement({ ...s, env: {}, fetchImpl: fakeFetch({ ok: true, status: "active" }) });
  assert.equal(e.mode, "free");
});

test("should be full when the server says active and write the cache", async (t) => {
  const s = setup(t);
  const e = await resolveEntitlement({ ...s, env: { ASHURA_MEMBER_KEY: "k" }, fetchImpl: fakeFetch({ ok: true, status: "active", payload: { premiumPrompt: "P" } }) });
  assert.equal(e.mode, "full");
  assert.equal(e.premiumPrompt, "P");
  assert.equal(CACHE_FILE, "threadspost-license-cache.json");
  assert.ok(fs.existsSync(path.join(s.ashuraHome, CACHE_FILE)));
});

test("should be free when the server says invalid", async (t) => {
  const s = setup(t);
  const e = await resolveEntitlement({ ...s, env: { ASHURA_MEMBER_KEY: "k" }, fetchImpl: fakeFetch({ ok: true, status: "invalid" }) });
  assert.equal(e.mode, "free");
});

test("should stay full on server failure with a cache within 30 days", async (t) => {
  const s = setup(t);
  const keyHash = crypto.createHash("sha256").update("k").digest("hex");
  fs.writeFileSync(path.join(s.ashuraHome, CACHE_FILE), JSON.stringify({ verifiedAt: Date.now() - 5 * 86_400_000, keyHash, premiumPrompt: "" }));
  const e = await resolveEntitlement({ ...s, env: { ASHURA_MEMBER_KEY: "k" }, fetchImpl: failingFetch });
  assert.equal(e.mode, "full");
});

test("should be free on server failure with an old cache", async (t) => {
  const s = setup(t);
  const keyHash = crypto.createHash("sha256").update("k").digest("hex");
  fs.writeFileSync(path.join(s.ashuraHome, CACHE_FILE), JSON.stringify({ verifiedAt: Date.now() - 31 * 86_400_000, keyHash, premiumPrompt: "" }));
  const e = await resolveEntitlement({ ...s, env: { ASHURA_MEMBER_KEY: "k" }, fetchImpl: failingFetch });
  assert.equal(e.mode, "free");
});

test("should read the member key from member.json", async (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.ashuraHome, "member.json"), JSON.stringify({ key: "from-file" }));
  let seenUrl = "";
  const e = await resolveEntitlement({
    ...s,
    env: {},
    fetchImpl: async (url) => {
      seenUrl = String(url);
      return { ok: true, json: async () => ({ ok: true, status: "active" }) };
    },
  });
  assert.equal(e.mode, "full");
  assert.match(seenUrl, /key=from-file/);
});

test("activateByEmail should save the key on success and explain failures", async (t) => {
  const s = setup(t);
  const bad = await activateByEmail("not-an-email", { ashuraHome: s.ashuraHome, fetchImpl: failingFetch });
  assert.equal(bad.activated, false);
  const ok = await activateByEmail("a@example.com", { ashuraHome: s.ashuraHome, fetchImpl: fakeFetch({ ok: true, status: "active", key: "K" }) });
  assert.equal(ok.activated, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.ashuraHome, "member.json"), "utf8")).key, "K");
  const inv = await activateByEmail("a@example.com", { ashuraHome: s.ashuraHome, fetchImpl: fakeFetch({ ok: true, status: "invalid" }) });
  assert.equal(inv.activated, false);
});

test("should forbid images, unattended and user self reply for free but allow the system credit reply when credit place is reply", () => {
  const free = { mode: "free", message: "", limits: { kinds: ["text"], unattended: false, selfReply: false, credit: { text: "c", place: "reply" } } };
  assert.throws(() => assertAllowed(/** @type {any} */ (free), "generate_images"), EntitlementError);
  assert.throws(() => assertAllowed(/** @type {any} */ (free), "publish_kind:carousel"), EntitlementError);
  assert.throws(() => assertAllowed(/** @type {any} */ (free), "unattended"), EntitlementError);
  assert.throws(() => assertAllowed(/** @type {any} */ (free), "user_self_reply"), EntitlementError);
  assert.doesNotThrow(() => assertAllowed(/** @type {any} */ (free), "publish_kind:text"));
  assert.doesNotThrow(() => assertAllowed(/** @type {any} */ (free), "system_credit_reply"));
  const full = { mode: "full", message: "", limits: { kinds: ["text", "image", "carousel"], unattended: true, selfReply: true, credit: null } };
  for (const a of ["generate_images", "publish_kind:carousel", "unattended", "user_self_reply"]) {
    assert.doesNotThrow(() => assertAllowed(/** @type {any} */ (full), /** @type {any} */ (a)));
  }
});

test("should not use a cache made for a different member key", async (t) => {
  const s = setup(t);
  await resolveEntitlement({ ...s, env: { ASHURA_MEMBER_KEY: "k1" }, fetchImpl: fakeFetch({ ok: true, status: "active" }) });
  const e = await resolveEntitlement({ ...s, env: { ASHURA_MEMBER_KEY: "k2" }, fetchImpl: failingFetch });
  assert.equal(e.mode, "free");
});

test("should not trust a cache dated in the future", async (t) => {
  const s = setup(t);
  await resolveEntitlement({ ...s, env: { ASHURA_MEMBER_KEY: "k" }, fetchImpl: fakeFetch({ ok: true, status: "active" }), now: () => Date.now() + 5 * 86_400_000 });
  const e = await resolveEntitlement({ ...s, env: { ASHURA_MEMBER_KEY: "k" }, fetchImpl: failingFetch });
  assert.equal(e.mode, "free");
});
