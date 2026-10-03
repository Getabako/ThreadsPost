import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { getExport } from "../../core/export.mjs";
import { fileURLToPath } from "node:url";
import { makeTempRoot } from "../helpers/temp-root.mjs";
import { openDb } from "../../core/db.mjs";
import { runCodexExec } from "../../core/codex.mjs";
import { listJobs, getJob } from "../../core/jobs.mjs";
import { runAuto, parseArgs, EXIT } from "../../core/auto.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(here, "../fixtures/fake-codex.mjs");
const appRoot = path.resolve(here, "../..");
const FULL = { mode: "full", message: "", limits: { kinds: ["text", "image", "carousel"], unattended: true, selfReply: true, credit: null } };
const FREE = { mode: "free", message: "", limits: { kinds: ["text"], unattended: false, selfReply: false, credit: { text: "#c", place: "body" } } };

/** @param {Record<string, string>} env */
const fakeExec = (env) => (o) =>
  runCodexExec({ ...o, command: process.execPath, commandPrefix: [FAKE], env: { ...process.env, ...env }, passThroughForTests: Object.keys(env), graceMs: { interrupt: 100, terminate: 100 } });

/** 下書きの本文を変えながら返す偽の exec */
const textExec = (texts) => {
  let i = 0;
  return (o) => fakeExec({ FAKE_CODEX_FINAL: JSON.stringify({ reply: "", draft: { kind: "text", text: texts[Math.min(i++, texts.length - 1)], topicTag: "AI活用", selfReplyText: "", images: [] } }) })(o);
};

function setup(t, over = {}) {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  t.after(() => db.close());
  const notes = [];
  const sleeps = [];
  const deps = {
    db,
    dataRoot: tmp.root,
    appRoot,
    resolveEntitlement: async () => /** @type {any} */ (FULL),
    exec: textExec(["議事録の清書に毎回40分。AIで一瞬に"]),
    notify: (/** @type {string} */ m) => notes.push(m),
    sleep: async (/** @type {number} */ ms) => void sleeps.push(ms),
    random: () => 0.5,
    now: () => new Date("2026-10-02T03:00:00Z"),
    themes: ["テーマA", "テーマB"],
    log: () => {},
    exportRoot: path.join(tmp.root, "Threads投稿"),
    ...over,
  };
  return { db, deps, notes, sleeps };
}

test("should parse arguments", () => {
  const a = parseArgs(["--theme=議事録", "--kind=carousel", "--slides=3", "--jitter=20"]);
  assert.deepEqual(a, { publish: false, theme: "議事録", kind: "carousel", slides: 3, jitter: 20 });
});

test("should only create a draft without --publish, save the local package and exit 0", async (t) => {
  const { db, deps } = setup(t);
  const code = await runAuto([], deps);
  assert.equal(code, EXIT.OK);
  const jobs = listJobs(db);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source, "cli");
  assert.equal(getJob(db, jobs[0].jobId)?.state, "draft");
  const e = getExport(db, jobs[0].jobId);
  assert.ok(e && fs.existsSync(path.join(e.dir, "本文.txt")));
});

test("should refuse --publish in the draft stage", async (t) => {
  const { db, deps } = setup(t);
  assert.equal(await runAuto(["--publish"], deps), EXIT.UNSUPPORTED);
  assert.equal(listJobs(db).length, 0);
});

test("should apply free limits from the shared entitlement", async (t) => {
  const { db, deps, notes } = setup(t, { resolveEntitlement: async () => FREE });
  assert.equal(await runAuto([], deps), EXIT.ERROR);
  assert.equal(listJobs(db).length, 0);
  assert.equal(notes.length, 1);
});

test("should stop with exit 11, an alert and a notification when the theme pool is exhausted", async (t) => {
  const { db, deps, notes } = setup(t, { themes: ["テーマA"] });
  assert.equal(await runAuto([], deps), EXIT.OK);
  assert.equal(await runAuto([], deps), EXIT.NEEDS_HUMAN);
  const alerts = /** @type {any[]} */ (db.prepare("SELECT code FROM alerts").all());
  assert.ok(alerts.some((a) => a.code === "theme_exhausted"));
  assert.equal(notes.length, 1);
});

test("should regenerate once on a similar draft and stop on a repeated exact duplicate", async (t) => {
  const same = "議事録の清書に毎回40分。AIで一瞬に";
  const { db, deps } = setup(t, { exec: textExec([same]) });
  assert.equal(await runAuto(["--theme=一回目"], deps), EXIT.OK);
  const code = await runAuto(["--theme=二回目"], deps);
  assert.equal(code, EXIT.NEEDS_HUMAN);
  assert.ok(/** @type {any[]} */ (db.prepare("SELECT code FROM alerts").all()).some((a) => a.code === "duplicate"));
});

test("should keep the regenerated draft when the second attempt is fresh", async (t) => {
  const { db, deps } = setup(t, { exec: textExec(["同じ書き出しです\n一", "同じ書き出しです\n二", "まったく別の新しい話題を書きました"]) });
  assert.equal(await runAuto(["--theme=一回目"], deps), EXIT.OK);
  assert.equal(await runAuto(["--theme=二回目"], deps), EXIT.OK);
  const texts = listJobs(db).map((j) => getJob(db, j.jobId)?.draft?.text);
  assert.ok(texts.includes("まったく別の新しい話題を書きました"));
});

test("should delay start by 0 to jitter minutes", async (t) => {
  const { deps, sleeps } = setup(t);
  await runAuto(["--jitter=20"], deps);
  assert.deepEqual(sleeps, [10 * 60_000]);
});

test("should honor --kind=image for members and save a complete image draft", async (t) => {
  const { db, deps } = setup(t, {
    exec: (o) => fakeExec({ FAKE_CODEX_FINAL: JSON.stringify({ reply: "", draft: { kind: "image", text: "画像の本文" + Math.random(), topicTag: "", selfReplyText: "", images: [{ headline: "a", body: "b", prompt: "c", altText: "d" }] } }), FAKE_CODEX_SLOTS: "1" })(o),
  });
  assert.equal(await runAuto(["--theme=T0", "--kind=image"], deps), EXIT.OK);
  const job = getJob(db, listJobs(db)[0].jobId);
  assert.equal(job?.draft?.kind, "image");
  assert.deepEqual(job?.draft?.images?.map((i) => i.revision), [1]);
});

test("should not report success when codex returns a different kind than requested", async (t) => {
  const { db, deps } = setup(t);
  assert.equal(await runAuto(["--theme=T0", "--kind=image"], deps), EXIT.NEEDS_HUMAN);
  assert.ok(/** @type {any[]} */ (db.prepare("SELECT code FROM alerts").all()).some((a) => a.code === "incomplete_draft"));
});

test("should not report success when the draft breaks Threads limits", async (t) => {
  const { deps } = setup(t, { exec: textExec(["あ".repeat(501)]) });
  assert.equal(await runAuto(["--theme=T0"], deps), EXIT.NEEDS_HUMAN);
});

test("should not report success when an image could not be made", async (t) => {
  const { deps } = setup(t, {
    exec: (o) => fakeExec({ FAKE_CODEX_FINAL: JSON.stringify({ reply: "", draft: { kind: "image", text: "本文", topicTag: "", selfReplyText: "", images: [{ headline: "a", body: "b", prompt: "c", altText: "d" }] } }) })(o),
  });
  assert.equal(await runAuto(["--theme=T0", "--kind=image"], deps), EXIT.NEEDS_HUMAN);
});

test("should give different themes to two runs started at the same time", async (t) => {
  const { db, deps } = setup(t, { themes: ["テーマA", "テーマB", "テーマC"] });
  const codes = await Promise.all([runAuto([], deps), runAuto([], deps)]);
  assert.deepEqual(codes, [EXIT.OK, EXIT.OK]);
  const themes = listJobs(db).map((j) => j.theme);
  assert.equal(new Set(themes).size, 2);
});

test("should default to text and use an image every fourth run for members", async (t) => {
  const { deps } = setup(t, {
    exec: (o) => fakeExec({ FAKE_CODEX_FINAL: JSON.stringify({ reply: "", draft: { kind: "text", text: "本文" + Math.random(), topicTag: "", selfReplyText: "", images: [] } }) })(o),
  });
  const kinds = [];
  for (let i = 0; i < 4; i++) {
    await runAuto([`--theme=R${i}`], { ...deps, onPlannedKind: (k) => kinds.push(k) });
  }
  assert.deepEqual(kinds, ["text", "text", "text", "image"]);
});
