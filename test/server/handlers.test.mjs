import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempRoot } from "../helpers/temp-root.mjs";
import { openDb, acquireLease, addJobEvent } from "../../core/db.mjs";
import { runCodexExec } from "../../core/codex.mjs";
import { adoptCodexDraft, adoptImages } from "../../core/jobs.mjs";
import * as h from "../../server/handlers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(here, "../fixtures/fake-codex.mjs");
const appRoot = path.resolve(here, "../..");
const token = "s".repeat(64);
const base = "http://127.0.0.1:4593";
import { VALID_PNG as PNG } from "../helpers/png.mjs";

const FULL = { mode: "full", message: "full", limits: { kinds: ["text", "image", "carousel"], unattended: true, selfReply: true, credit: null } };

/** @type {string[]} */
const opened = [];

function setup(t, env = {}) {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  t.after(() => db.close());
  /** @type {import("../../server/handlers.mjs").Ctx} */
  const ctx = {
    db,
    dataRoot: tmp.root,
    appRoot,
    sessionToken: token,
    resolveEntitlement: async () => /** @type {any} */ (FULL),
    activate: async () => ({ activated: true, message: "ok" }),
    codexStatus: async () => ({ loggedIn: true, detail: "Logged in" }),
    exec: (o) => runCodexExec({ ...o, command: process.execPath, commandPrefix: [FAKE], env: { ...process.env, ...env }, passThroughForTests: Object.keys(env), graceMs: { interrupt: 100, terminate: 100 } }),
    running: new Map(),
    exportRoot: path.join(tmp.root, "Threads投稿"),
    openPath: (/** @type {string} */ p) => opened.push(p),
  };
  return ctx;
}

const auth = { host: "127.0.0.1:4593", cookie: `tp_session_4593=${token}` };
const write = { ...auth, origin: base, "x-threadspost-token": token, "content-type": "application/json" };
/** @param {string} p @param {object} [body] */
const post = (p, body) => new Request(base + p, { method: "POST", headers: write, body: JSON.stringify(body ?? {}) });
/** @param {string} p */
const get = (p) => new Request(base + p, { headers: auth });

/** 生成が終わるまで待つ */
async function waitIdle(ctx, jobId) {
  for (let i = 0; i < 200; i++) {
    if (!ctx.running.has(jobId)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("generation did not finish");
}

async function createJob(ctx, brief = { theme: "議事録をAIで", kind: "carousel", slideCount: 2 }) {
  const r = await h.jobsCreate(post("/api/jobs", { brief }), ctx);
  assert.equal(r.status, 201);
  return (await r.json()).jobId;
}

test("should reject requests without authentication", async (t) => {
  const ctx = setup(t);
  const r = await h.jobsList(new Request(base + "/api/jobs", { headers: { host: "127.0.0.1:4593" } }), ctx);
  assert.equal(r.status, 403);
  const w = await h.jobsCreate(new Request(base + "/api/jobs", { method: "POST", headers: auth, body: "{}" }), ctx);
  assert.equal(w.status, 403);
});

test("should validate the brief when creating a job", async (t) => {
  const ctx = setup(t);
  const r = await h.jobsCreate(post("/api/jobs", { brief: { theme: "" } }), ctx);
  assert.equal(r.status, 400);
  const r2 = await h.jobsCreate(post("/api/jobs", { brief: { theme: "x", kind: "carousel", slideCount: 11 } }), ctx);
  assert.equal(r2.status, 400);
  const r3 = await h.jobsCreate(post("/api/jobs", { brief: { theme: "x", link: { url: "javascript:x", place: "body" } } }), ctx);
  assert.equal(r3.status, 400);
});

test("should run the outline in the background and expose the draft with the final payload", async (t) => {
  const final = JSON.stringify({ reply: "作りました", draft: { kind: "carousel", text: "本文です", topicTag: "AI活用", selfReplyText: "", images: [{ headline: "a", body: "b", prompt: "c", altText: "d" }, { headline: "e", body: "f", prompt: "g", altText: "h" }] } });
  const ctx = setup(t, { FAKE_CODEX_FINAL: final });
  const jobId = await createJob(ctx);
  const r = await h.jobOutline(post(`/api/jobs/${jobId}/outline`, { message: null }), ctx, jobId);
  assert.equal(r.status, 202);
  await waitIdle(ctx, jobId);
  const g = await (await h.jobGet(get(`/api/jobs/${jobId}`), ctx, jobId)).json();
  assert.equal(g.job.draft.text, "本文です");
  assert.equal(g.final.main.text, "本文です");
  assert.ok(g.readiness.some((i) => i.code === "image_not_generated"));
  assert.equal(g.counts.main, 4);
});

test("should return 409 when a generation is already running for the job", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx);
  const held = acquireLease(ctx.db, `gen:${jobId}`, { purpose: "other" });
  assert.ok(!("busy" in held));
  const r = await h.jobOutline(post(`/api/jobs/${jobId}/outline`, {}), ctx, jobId);
  assert.equal(r.status, 409);
});

test("should update the draft with the expected revision and reject stale ones", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx, { theme: "x", kind: "text" });
  const put = (body) => new Request(base + `/api/jobs/${jobId}`, { method: "PUT", headers: write, body: JSON.stringify(body) });
  const ok = await h.jobPut(put({ draft: { kind: "text", text: "一" }, expectedRevision: 0 }), ctx, jobId);
  assert.equal(ok.status, 200);
  const stale = await h.jobPut(put({ draft: { kind: "text", text: "二" }, expectedRevision: 0 }), ctx, jobId);
  assert.equal(stale.status, 409);
  const bad = await h.jobPut(put({ draft: { kind: "text", text: "" }, expectedRevision: 1 }), ctx, jobId);
  assert.equal(bad.status, 400);
});

test("should refuse draft updates after the job is frozen and offer duplication", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx, { theme: "x", kind: "text" });
  adoptCodexDraft(ctx.db, jobId, { kind: "text", text: "一" });
  ctx.db.prepare("UPDATE jobs SET state='frozen' WHERE job_id=?").run(jobId);
  const r = await h.jobPut(new Request(base + `/api/jobs/${jobId}`, { method: "PUT", headers: write, body: JSON.stringify({ draft: { kind: "text", text: "二" }, expectedRevision: 1 }) }), ctx, jobId);
  assert.equal(r.status, 409);
  const d = await h.jobDuplicate(post(`/api/jobs/${jobId}/duplicate`), ctx, jobId);
  assert.equal(d.status, 201);
});

test("should generate images in the background and serve only registered job images", async (t) => {
  const ctx = setup(t, { FAKE_CODEX_SLOTS: "1,2" });
  const jobId = await createJob(ctx);
  adoptCodexDraft(ctx.db, jobId, { kind: "carousel", text: "本文", images: [{ headline: "a" }, { headline: "b" }] });
  const r = await h.jobImages(post(`/api/jobs/${jobId}/images`, { slots: null }), ctx, jobId);
  assert.equal(r.status, 202);
  await waitIdle(ctx, jobId);
  const img = await h.media(get(`/api/media/${jobId}/1/1`), ctx, jobId, "1", "1");
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(img.headers.get("x-content-type-options"), "nosniff");
  const missing = await h.media(get(`/api/media/${jobId}/1/9`), ctx, jobId, "1", "9");
  assert.equal(missing.status, 404);
  const traversal = await h.media(get(`/api/media/${jobId}/..%2F..%2Fstate.db/1`), ctx, jobId, "../../state.db", "1");
  assert.equal(traversal.status, 404);
});

test("should refuse to serve an image whose stored file was replaced by a symlink", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx);
  adoptCodexDraft(ctx.db, jobId, { kind: "carousel", text: "本文", images: [{ headline: "a" }, { headline: "b" }] });
  const gen = path.join(ctx.dataRoot, "gen");
  fs.mkdirSync(path.join(gen, "images"), { recursive: true });
  fs.writeFileSync(path.join(gen, "images", "slide-01.png"), PNG);
  await adoptImages(ctx.db, { dataRoot: ctx.dataRoot, jobId, genDir: gen, slots: [1] });
  const row = /** @type {any} */ (ctx.db.prepare("SELECT path FROM job_images WHERE job_id=?").get(jobId));
  fs.rmSync(row.path);
  fs.symlinkSync(path.join(ctx.dataRoot, "state.db"), row.path);
  const r = await h.media(get(`/api/media/${jobId}/1/1`), ctx, jobId, "1", "1");
  assert.equal(r.status, 404);
});

test("should stream job events from the database and resend after a given id", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx);
  addJobEvent(ctx.db, jobId, "step", "一");
  addJobEvent(ctx.db, jobId, "step", "二");
  const ac = new AbortController();
  const r = await h.jobEvents(new Request(base + `/api/jobs/${jobId}/events?after=0`, { headers: auth, signal: ac.signal }), ctx, jobId);
  assert.equal(r.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = /** @type {ReadableStream<Uint8Array>} */ (r.body).getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /一/);
  assert.match(text, /二/);
  ac.abort();
  await reader.cancel();
});

test("should never include tokens or secrets in job responses", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx);
  const body = await (await h.jobGet(get(`/api/jobs/${jobId}`), ctx, jobId)).text();
  assert.ok(!body.includes(token));
});

test("should report status including entitlement and codex login", async (t) => {
  const ctx = setup(t);
  const s = await (await h.status(get("/api/status"), ctx)).json();
  assert.equal(s.entitlement.mode, "full");
  assert.equal(s.codex.loggedIn, true);
  assert.equal(s.model, "gpt-6.1-sol");
});

test("should refuse to save the draft while another process holds the generation lease, and report it as running", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx, { theme: "x", kind: "text" });
  adoptCodexDraft(ctx.db, jobId, { kind: "text", text: "一" });
  const held = acquireLease(ctx.db, `gen:${jobId}`, { purpose: "別のサーバーの生成" });
  assert.ok(!("busy" in held));
  ctx.db.prepare("INSERT INTO generations (gen_id, job_id, purpose, status, started_at) VALUES ('gx', ?, 'outline', 'running', ?)").run(jobId, new Date().toISOString());
  const r = await h.jobPut(new Request(base + `/api/jobs/${jobId}`, { method: "PUT", headers: write, body: JSON.stringify({ draft: { kind: "text", text: "二" }, expectedRevision: 1 }) }), ctx, jobId);
  assert.equal(r.status, 409);
  const v = await (await h.jobGet(get(`/api/jobs/${jobId}`), ctx, jobId)).json();
  assert.equal(v.running, true);
});

test("should save a local package, report it, zip it and open its folder only", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx, { theme: "保存", kind: "text" });
  adoptCodexDraft(ctx.db, jobId, { kind: "text", text: "本文" });
  const r = await h.jobExport(post(`/api/jobs/${jobId}/export`), ctx, jobId);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.export.dir.startsWith(ctx.exportRoot));
  const v = await (await h.jobGet(get(`/api/jobs/${jobId}`), ctx, jobId)).json();
  assert.equal(v.export.stale, false);
  const z = await h.jobExportZip(get(`/api/jobs/${jobId}/export.zip`), ctx, jobId);
  assert.equal(z.status, 200);
  assert.equal(z.headers.get("content-type"), "application/zip");
  assert.match(z.headers.get("content-disposition") ?? "", /attachment/);
  opened.length = 0;
  const o = await h.jobOpenFolder(post(`/api/jobs/${jobId}/open-folder`), ctx, jobId);
  assert.equal(o.status, 200);
  assert.deepEqual(opened, [fs.realpathSync(body.export.dir)]);
});

test("should explain why a package cannot be saved yet", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx);
  adoptCodexDraft(ctx.db, jobId, { kind: "carousel", text: "本文", images: [{ headline: "a" }, { headline: "b" }] });
  const r = await h.jobExport(post(`/api/jobs/${jobId}/export`), ctx, jobId);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.code, "not_ready");
  assert.ok(body.issues.length >= 2);
  const z = await h.jobExportZip(get(`/api/jobs/${jobId}/export.zip`), ctx, jobId);
  assert.equal(z.status, 404);
});

test("should not open a folder outside the export root", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx, { theme: "x", kind: "text" });
  ctx.db.prepare("INSERT INTO exports (job_id, dir, draft_revision, payload_sha256, created_at) VALUES (?, '/etc', 0, 'x', 'now')").run(jobId);
  opened.length = 0;
  const o = await h.jobOpenFolder(post(`/api/jobs/${jobId}/open-folder`), ctx, jobId);
  assert.equal(o.status, 404);
  assert.deepEqual(opened, []);
});

test("should delete a draft job through the api", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx, { theme: "x", kind: "text" });
  const r = await h.jobDelete(post(`/api/jobs/${jobId}/delete`), ctx, jobId);
  assert.equal(r.status, 200);
  const g = await h.jobGet(get(`/api/jobs/${jobId}`), ctx, jobId);
  assert.equal(g.status, 404);
});

test("should import photos, serve them, overlay texts and include them in the view", async (t) => {
  const ctx = setup(t);
  const sharp = (await import("sharp")).default;
  const jobId = await createJob(ctx, { theme: "写真", photoMode: true });
  const jpg = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#a63" } }).jpeg().toBuffer();
  const up = await h.jobPhotoUpload(new Request(base + `/api/jobs/${jobId}/photos`, { method: "POST", headers: { ...write, "content-type": "image/jpeg" }, body: jpg }), ctx, jobId);
  assert.equal(up.status, 201);
  const { photo } = await up.json();
  const v = await (await h.jobGet(get(`/api/jobs/${jobId}`), ctx, jobId)).json();
  assert.deepEqual(v.photos.map((p) => p.photoId), [photo.photoId]);
  const img = await h.jobPhoto(get(`/api/jobs/${jobId}/photos/${photo.photoId}`), ctx, jobId, photo.photoId);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  adoptCodexDraft(ctx.db, jobId, { kind: "image", text: "本文", images: [{ photoId: photo.photoId, headline: "見出し" }] });
  const r = await h.jobRender(post(`/api/jobs/${jobId}/render`, { slots: null }), ctx, jobId);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.rendered, [{ slot: 1, revision: 1 }]);
});

test("should reject photo uploads that are not images or come from another site", async (t) => {
  const ctx = setup(t);
  const jobId = await createJob(ctx, { theme: "写真", photoMode: true });
  const bad = await h.jobPhotoUpload(new Request(base + `/api/jobs/${jobId}/photos`, { method: "POST", headers: { ...write, "content-type": "image/jpeg" }, body: "nope" }), ctx, jobId);
  assert.equal(bad.status, 400);
  const cross = await h.jobPhotoUpload(new Request(base + `/api/jobs/${jobId}/photos`, { method: "POST", headers: { ...write, origin: "http://evil.example", "content-type": "image/jpeg" }, body: "x" }), ctx, jobId);
  assert.equal(cross.status, 403);
  const missing = await h.jobPhoto(get(`/api/jobs/${jobId}/photos/p000000000000`), ctx, jobId, "p000000000000");
  assert.equal(missing.status, 404);
});
