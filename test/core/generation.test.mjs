import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempRoot } from "../helpers/temp-root.mjs";
import { openDb, LeaseBusyError, acquireLease } from "../../core/db.mjs";
import { createJob, getJob, adoptCodexDraft } from "../../core/jobs.mjs";
import { runCodexExec } from "../../core/codex.mjs";
import { runOutline, runImages, runAutoDraft, recoverGenerations } from "../../core/generation.mjs";
import { EntitlementError } from "../../core/entitlement.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(here, "../fixtures/fake-codex.mjs");
const appRoot = path.resolve(here, "../..");

const FULL = { mode: "full", message: "", limits: { kinds: ["text", "image", "carousel"], unattended: true, selfReply: true, credit: null } };
const FREE = { mode: "free", message: "", limits: { kinds: ["text"], unattended: false, selfReply: false, credit: { text: "#c", place: "body" } } };

/** 偽の codex で動かす exec。env で動きを決める */
const fakeExec = (env) => (o) =>
  runCodexExec({
    ...o,
    command: process.execPath,
    commandPrefix: [FAKE],
    env: { ...process.env, ...env },
    passThroughForTests: Object.keys(env),
    graceMs: { interrupt: 100, terminate: 100 },
  });

function setup(t) {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  t.after(() => db.close());
  return { db, dataRoot: tmp.root };
}

const brief = { theme: "議事録をAIで", kind: "carousel", slideCount: 2 };

test("should create a draft from the outline chat and record the conversation", async (t) => {
  const { db, dataRoot } = setup(t);
  const jobId = createJob(db, { brief, source: "ui" });
  const final = JSON.stringify({
    reply: "下書きを作りました",
    draft: { kind: "carousel", text: "議事録の清書に毎回40分", topicTag: "AI活用", selfReplyText: "", images: [{ headline: "a", body: "b", prompt: "c", altText: "d" }, { headline: "e", body: "f", prompt: "g", altText: "h" }] },
  });
  const r = await runOutline({ db, dataRoot, appRoot, jobId, userMessage: null, entitlement: FULL, exec: fakeExec({ FAKE_CODEX_FINAL: final }) });
  assert.equal(r.status, "completed");
  const j = getJob(db, jobId);
  assert.equal(j?.draft?.kind, "carousel");
  assert.equal(j?.draft?.images?.length, 2);
  assert.deepEqual(j?.chat.map((m) => m.role), ["assistant"]);
  assert.equal(j?.chat[0].text, "下書きを作りました");
  const gen = /** @type {any} */ (db.prepare("SELECT status, purpose FROM generations WHERE job_id = ?").get(jobId));
  assert.deepEqual([gen.status, gen.purpose], ["completed", "outline"]);
  assert.ok(/** @type {any[]} */ (db.prepare("SELECT kind FROM job_events WHERE job_id = ?").all(jobId)).length > 0);
});

test("should record the user message and run the outline in a read-only sandbox", async (t) => {
  const { db, dataRoot } = setup(t);
  const jobId = createJob(db, { brief, source: "ui" });
  const rec = path.join(dataRoot, "rec.json");
  await runOutline({ db, dataRoot, appRoot, jobId, userMessage: "もっと短く", entitlement: FULL, exec: fakeExec({ FAKE_CODEX_RECORD: rec }) });
  const seen = JSON.parse(fs.readFileSync(rec, "utf8"));
  assert.ok(seen.args.join(" ").includes("-s read-only"));
  assert.ok(seen.args.includes("--output-schema"));
  assert.match(seen.stdin, /もっと短く/);
  assert.equal(getJob(db, jobId)?.chat[0].text, "もっと短く");
});

test("should fail the outline without changing the draft when codex returns invalid json", async (t) => {
  const { db, dataRoot } = setup(t);
  const jobId = createJob(db, { brief, source: "ui" });
  const r = await runOutline({ db, dataRoot, appRoot, jobId, userMessage: null, entitlement: FULL, exec: fakeExec({ FAKE_CODEX_FINAL: "not json" }) });
  assert.equal(r.status, "failed");
  assert.equal(getJob(db, jobId)?.draft, null);
});

test("should force text drafts for free users", async (t) => {
  const { db, dataRoot } = setup(t);
  const jobId = createJob(db, { brief, source: "ui" });
  const final = JSON.stringify({ reply: "x", draft: { kind: "carousel", text: "本文", topicTag: "", selfReplyText: "", images: [{ headline: "a", body: "", prompt: "", altText: "" }, { headline: "b", body: "", prompt: "", altText: "" }] } });
  await runOutline({ db, dataRoot, appRoot, jobId, userMessage: null, entitlement: FREE, exec: fakeExec({ FAKE_CODEX_FINAL: final }) });
  const d = getJob(db, jobId)?.draft;
  assert.equal(d?.kind, "text");
  assert.equal(d?.images, undefined);
});

test("should generate images in a workspace-write sandbox and adopt them", async (t) => {
  const { db, dataRoot } = setup(t);
  const jobId = createJob(db, { brief, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "carousel", text: "本文", images: [{ headline: "a" }, { headline: "b" }] });
  const rec = path.join(dataRoot, "rec.json");
  const r = await runImages({ db, dataRoot, appRoot, jobId, slots: null, entitlement: FULL, exec: fakeExec({ FAKE_CODEX_SLOTS: "1,2", FAKE_CODEX_RECORD: rec }) });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.result?.adopted.map((a) => a.slot), [1, 2]);
  const seen = JSON.parse(fs.readFileSync(rec, "utf8"));
  assert.ok(seen.args.join(" ").includes("-s workspace-write"));
  const cwd = seen.args[seen.args.indexOf("-C") + 1];
  assert.ok(cwd.startsWith(path.join(dataRoot, "work", jobId) + path.sep));
  assert.deepEqual(getJob(db, jobId)?.draft?.images?.map((i) => i.revision), [1, 1]);
});

test("should regenerate only the requested slot", async (t) => {
  const { db, dataRoot } = setup(t);
  const jobId = createJob(db, { brief, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "carousel", text: "本文", images: [{ headline: "a" }, { headline: "b" }] });
  await runImages({ db, dataRoot, appRoot, jobId, slots: null, entitlement: FULL, exec: fakeExec({ FAKE_CODEX_SLOTS: "1,2" }) });
  const r = await runImages({ db, dataRoot, appRoot, jobId, slots: [2], entitlement: FULL, exec: fakeExec({ FAKE_CODEX_SLOTS: "1,2" }) });
  assert.deepEqual(r.result?.adopted.map((a) => a.slot), [2]);
  assert.deepEqual(getJob(db, jobId)?.draft?.images?.map((i) => i.revision), [1, 2]);
});

test("should not adopt images from a timed out generation", async (t) => {
  const { db, dataRoot } = setup(t);
  const jobId = createJob(db, { brief, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "carousel", text: "本文", images: [{ headline: "a" }, { headline: "b" }] });
  const r = await runImages({ db, dataRoot, appRoot, jobId, slots: null, entitlement: FULL, timeoutMs: 200, exec: fakeExec({ FAKE_CODEX_MODE: "hang" }) });
  assert.equal(r.status, "timeout");
  assert.equal(getJob(db, jobId)?.images.length, 0);
  const gen = /** @type {any} */ (db.prepare("SELECT status FROM generations WHERE job_id = ?").get(jobId));
  assert.equal(gen.status, "timeout");
});

test("should refuse image generation for free users", async (t) => {
  const { db, dataRoot } = setup(t);
  const jobId = createJob(db, { brief, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "carousel", text: "本文", images: [{ headline: "a" }, { headline: "b" }] });
  await assert.rejects(runImages({ db, dataRoot, appRoot, jobId, slots: null, entitlement: FREE, exec: fakeExec({}) }), EntitlementError);
});

test("should refuse a second generation while one holds the gen lease", async (t) => {
  const { db, dataRoot } = setup(t);
  const jobId = createJob(db, { brief, source: "ui" });
  const held = acquireLease(db, `gen:${jobId}`, { purpose: "other" });
  assert.ok(!("busy" in held));
  await assert.rejects(runOutline({ db, dataRoot, appRoot, jobId, userMessage: null, entitlement: FULL, exec: fakeExec({}) }), LeaseBusyError);
});

test("should create a full draft job unattended, with images", async (t) => {
  const { db, dataRoot } = setup(t);
  const final = JSON.stringify({ reply: "ok", draft: { kind: "image", text: "本文", topicTag: "AI活用", selfReplyText: "", images: [{ headline: "a", body: "b", prompt: "c", altText: "d" }] } });
  const r = await runAutoDraft({ db, dataRoot, appRoot, theme: "テーマ", kind: "image", entitlement: FULL, exec: fakeExec({ FAKE_CODEX_FINAL: final, FAKE_CODEX_SLOTS: "1" }) });
  assert.equal(r.status, "completed");
  const j = getJob(db, r.jobId);
  assert.equal(j?.source, "cli");
  assert.deepEqual(j?.draft?.images?.map((i) => i.revision), [1]);
});

test("should mark running generations without a live lease as interrupted on boot", (t) => {
  const { db } = setup(t);
  db.prepare("INSERT INTO generations (gen_id, job_id, purpose, status, started_at) VALUES ('g1', 'j1', 'outline', 'running', ?)").run(new Date().toISOString());
  const n = recoverGenerations(db);
  assert.equal(n, 1);
  assert.equal(/** @type {any} */ (db.prepare("SELECT status FROM generations WHERE gen_id='g1'").get()).status, "interrupted");
});

test("should drop the self reply text from codex output for free users", async (t) => {
  const { db, dataRoot } = setup(t);
  const jobId = createJob(db, { brief: { theme: "x", kind: "text" }, source: "ui" });
  const final = JSON.stringify({ reply: "x", draft: { kind: "text", text: "本文", topicTag: "", selfReplyText: "宣伝です", images: [] } });
  await runOutline({ db, dataRoot, appRoot, jobId, userMessage: null, entitlement: FREE, exec: fakeExec({ FAKE_CODEX_FINAL: final }) });
  assert.equal(getJob(db, jobId)?.draft?.selfReplyText, undefined);
});

test("should give codex the photos and overlay the texts right after the outline", async (t) => {
  const { db, dataRoot } = setup(t);
  const { importPhoto } = await import("../../core/photos.mjs");
  const sharp = (await import("sharp")).default;
  const jobId = createJob(db, { brief: { theme: "写真の投稿", photoMode: true }, source: "ui" });
  const a = await importPhoto(db, { dataRoot, jobId, buffer: await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#a63" } }).jpeg().toBuffer() });
  const b = await importPhoto(db, { dataRoot, jobId, buffer: await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#36a" } }).jpeg().toBuffer() });
  const rec = path.join(dataRoot, "rec.json");
  const final = JSON.stringify({
    reply: "写真に合わせて書きました",
    draft: { kind: "carousel", text: "本文", topicTag: "", selfReplyText: "", images: [
      { photoId: a.photoId, headline: "一枚目の見出し", body: "補足", prompt: "", altText: "オレンジの写真" },
      { photoId: b.photoId, headline: "二枚目の見出し", body: "補足", prompt: "", altText: "青い写真" },
    ] },
  });
  const r = await runOutline({ db, dataRoot, appRoot, jobId, userMessage: null, entitlement: FULL, exec: fakeExec({ FAKE_CODEX_FINAL: final, FAKE_CODEX_RECORD: rec }) });
  assert.equal(r.status, "completed");
  const seen = JSON.parse(fs.readFileSync(rec, "utf8"));
  assert.equal(seen.args.filter((x) => x === "-i").length, 2, "photos are attached to codex");
  assert.match(seen.stdin, new RegExp(a.photoId));
  const j = getJob(db, jobId);
  assert.equal(j?.draft?.kind, "carousel");
  assert.deepEqual(j?.draft?.images?.map((i) => [i.photoId, i.revision]), [[a.photoId, 1], [b.photoId, 1]]);
});

test("should not send photo slots to AI image generation", async (t) => {
  const { db, dataRoot } = setup(t);
  const { importPhoto } = await import("../../core/photos.mjs");
  const sharp = (await import("sharp")).default;
  const jobId = createJob(db, { brief: { theme: "写真", photoMode: true }, source: "ui" });
  await importPhoto(db, { dataRoot, jobId, buffer: await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#a63" } }).jpeg().toBuffer() });
  adoptCodexDraft(db, jobId, { kind: "image", text: "本文", images: [{ headline: "a" }] });
  await assert.rejects(runImages({ db, dataRoot, appRoot, jobId, slots: null, entitlement: FULL, exec: fakeExec({}) }), /文字を入れ直す/);
});
