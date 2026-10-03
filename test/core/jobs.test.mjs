import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempRoot } from "../helpers/temp-root.mjs";
import { openDb } from "../../core/db.mjs";
import {
  createJob,
  getJob,
  listJobs,
  updateDraft,
  duplicateJob,
  addChatMessage,
  adoptCodexDraft,
  adoptImages,
  imagePath,
  JobStateError,
  RevisionConflictError,
} from "../../core/jobs.mjs";

import { VALID_PNG as PNG, BROKEN_PNG } from "../helpers/png.mjs";

function setup(t) {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  t.after(() => db.close());
  return { db, dataRoot: tmp.root };
}

const brief = { theme: "AIで議事録", audience: "社会人", tone: "やさしく", kind: "carousel", slideCount: 3 };

test("should create, read and list jobs", (t) => {
  const { db } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  const j = getJob(db, id);
  assert.equal(j?.state, "draft");
  assert.equal(j?.theme, "AIで議事録");
  assert.equal(listJobs(db).length, 1);
});

test("should keep chat messages in order", (t) => {
  const { db } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  addChatMessage(db, id, "user", "a");
  addChatMessage(db, id, "assistant", "b");
  assert.deepEqual(getJob(db, id)?.chat.map((m) => m.text), ["a", "b"]);
});

test("should update the draft with optimistic revision and reject a stale revision", (t) => {
  const { db } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  const r1 = updateDraft(db, id, { kind: "text", text: "一" }, { expectedRevision: 0 });
  assert.equal(r1.draftRevision, 1);
  assert.throws(() => updateDraft(db, id, { kind: "text", text: "二" }, { expectedRevision: 0 }), RevisionConflictError);
});

test("should refuse draft updates after the job is frozen and offer duplication", (t) => {
  const { db } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  updateDraft(db, id, { kind: "text", text: "一" }, { expectedRevision: 0 });
  db.prepare("UPDATE jobs SET state='frozen' WHERE job_id=?").run(id);
  assert.throws(() => updateDraft(db, id, { kind: "text", text: "二" }, { expectedRevision: 1 }), JobStateError);
  const copy = duplicateJob(db, id);
  const c = getJob(db, copy);
  assert.equal(c?.state, "draft");
  assert.equal(c?.draft?.text, "一");
  assert.equal(c?.copiedFromJobId, id);
});

test("should reject invalid drafts with issues", (t) => {
  const { db } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  assert.throws(() => updateDraft(db, id, { kind: "text", text: "" }, { expectedRevision: 0 }), /本文/);
});

test("should adopt a codex draft, dropping unknown fields and keeping the user's link", (t) => {
  const { db } = setup(t);
  const id = createJob(db, { brief: { ...brief, link: { url: "https://if-juku.net", place: "reply" } }, source: "ui" });
  const d = adoptCodexDraft(db, id, { kind: "carousel", text: "本文", topicTag: "#AI活用", hack: 1, images: [{ headline: "a", body: "b", prompt: "c" }, { headline: "d", body: "e", prompt: "f" }] });
  assert.equal(d.topicTag, "AI活用");
  assert.deepEqual(d.link, { url: "https://if-juku.net", place: "reply" });
  assert.equal(/** @type {any} */ (d).hack, undefined);
  assert.deepEqual(d.images?.map((i) => i.revision), [null, null]);
});

test("should keep image revisions when the image plan did not change", async (t) => {
  const { db, dataRoot } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  adoptCodexDraft(db, id, { kind: "carousel", text: "本文", images: [{ headline: "a", body: "b", prompt: "c" }, { headline: "d", body: "e", prompt: "f" }] });
  const gen = path.join(dataRoot, "gen");
  fs.mkdirSync(path.join(gen, "images"), { recursive: true });
  fs.writeFileSync(path.join(gen, "images", "slide-01.png"), PNG);
  fs.writeFileSync(path.join(gen, "images", "slide-02.png"), PNG);
  await adoptImages(db, { dataRoot, jobId: id, genDir: gen, slots: [1, 2] });
  const d = adoptCodexDraft(db, id, { kind: "carousel", text: "本文を直した", images: [{ headline: "a", body: "b", prompt: "c" }, { headline: "変更", body: "e", prompt: "f" }] });
  assert.deepEqual(d.images?.map((i) => i.revision), [1, null]);
});

test("should adopt only regular png files inside the generation folder and refuse symlinks", async (t) => {
  const { db, dataRoot } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  adoptCodexDraft(db, id, { kind: "carousel", text: "本文", images: [{ headline: "a" }, { headline: "b" }, { headline: "c" }] });
  const gen = path.join(dataRoot, "gen");
  fs.mkdirSync(path.join(gen, "images"), { recursive: true });
  fs.writeFileSync(path.join(gen, "images", "slide-01.png"), PNG);
  const outside = path.join(dataRoot, "secret.png");
  fs.writeFileSync(outside, PNG);
  fs.symlinkSync(outside, path.join(gen, "images", "slide-02.png"));
  fs.writeFileSync(path.join(gen, "images", "slide-03.png"), "not a png");
  const r = await adoptImages(db, { dataRoot, jobId: id, genDir: gen, slots: [1, 2, 3] });
  assert.deepEqual(r.adopted.map((a) => a.slot), [1]);
  assert.deepEqual(r.rejected.map((x) => x.slot).sort(), [2, 3]);
  const stored = imagePath(dataRoot, id, 1, 1);
  assert.ok(fs.existsSync(stored));
  assert.ok(!fs.lstatSync(stored).isSymbolicLink());
  const j = getJob(db, id);
  assert.deepEqual(j?.draft?.images?.map((i) => i.revision), [1, null, null]);
});

test("should make a new revision for a regenerated slot without touching others", async (t) => {
  const { db, dataRoot } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  adoptCodexDraft(db, id, { kind: "carousel", text: "本文", images: [{ headline: "a" }, { headline: "b" }] });
  const gen = path.join(dataRoot, "gen");
  fs.mkdirSync(path.join(gen, "images"), { recursive: true });
  fs.writeFileSync(path.join(gen, "images", "slide-01.png"), PNG);
  fs.writeFileSync(path.join(gen, "images", "slide-02.png"), PNG);
  await adoptImages(db, { dataRoot, jobId: id, genDir: gen, slots: [1, 2] });
  fs.writeFileSync(path.join(gen, "images", "slide-02.png"), PNG);
  await adoptImages(db, { dataRoot, jobId: id, genDir: gen, slots: [2] });
  const j = getJob(db, id);
  assert.deepEqual(j?.draft?.images?.map((i) => i.revision), [1, 2]);
  assert.equal(j?.images.filter((i) => i.isCurrent).length, 2);
});

test("should refuse to adopt into a frozen job", async (t) => {
  const { db, dataRoot } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  adoptCodexDraft(db, id, { kind: "text", text: "本文" });
  db.prepare("UPDATE jobs SET state='frozen' WHERE job_id=?").run(id);
  assert.throws(() => adoptCodexDraft(db, id, { kind: "text", text: "別" }), JobStateError);
  await assert.rejects(adoptImages(db, { dataRoot, jobId: id, genDir: dataRoot, slots: [1] }), JobStateError);
});

test("should reject a png that cannot be decoded", async (t) => {
  const { db, dataRoot } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  adoptCodexDraft(db, id, { kind: "image", text: "本文", images: [{ headline: "a" }] });
  const gen = path.join(dataRoot, "gen");
  fs.mkdirSync(path.join(gen, "images"), { recursive: true });
  fs.writeFileSync(path.join(gen, "images", "slide-01.png"), BROKEN_PNG);
  const r = await adoptImages(db, { dataRoot, jobId: id, genDir: gen, slots: [1] });
  assert.deepEqual(r.adopted, []);
  assert.equal(r.rejected[0]?.slot, 1);
});

test("should skip a revision whose file was left behind by an earlier failure", async (t) => {
  const { db, dataRoot } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  adoptCodexDraft(db, id, { kind: "image", text: "本文", images: [{ headline: "a" }] });
  const orphan = imagePath(dataRoot, id, 1, 1);
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.writeFileSync(orphan, PNG);
  const gen = path.join(dataRoot, "gen");
  fs.mkdirSync(path.join(gen, "images"), { recursive: true });
  fs.writeFileSync(path.join(gen, "images", "slide-01.png"), PNG);
  const r = await adoptImages(db, { dataRoot, jobId: id, genDir: gen, slots: [1] });
  assert.deepEqual(r.adopted, [{ slot: 1, revision: 2 }]);
});

test("should clear an image revision when its instructions are edited by hand, but not for alt text", async (t) => {
  const { db, dataRoot } = setup(t);
  const id = createJob(db, { brief, source: "ui" });
  adoptCodexDraft(db, id, { kind: "carousel", text: "本文", images: [{ headline: "a", prompt: "p" }, { headline: "b", prompt: "q" }] });
  const gen = path.join(dataRoot, "gen");
  fs.mkdirSync(path.join(gen, "images"), { recursive: true });
  fs.writeFileSync(path.join(gen, "images", "slide-01.png"), PNG);
  fs.writeFileSync(path.join(gen, "images", "slide-02.png"), PNG);
  await adoptImages(db, { dataRoot, jobId: id, genDir: gen, slots: [1, 2] });
  const j = getJob(db, id);
  const d = structuredClone(j.draft);
  d.images[0].headline = "変えた";
  d.images[1].altText = "説明だけ変えた";
  const r = updateDraft(db, id, d, { expectedRevision: j.draftRevision });
  assert.deepEqual(r.draft.images?.map((i) => i.revision), [null, 1]);
});

test("should keep the user's edited or removed link when codex revises the draft", (t) => {
  const { db } = setup(t);
  const id = createJob(db, { brief: { ...brief, kind: "text", link: { url: "https://old.example", place: "reply" } }, source: "ui" });
  const first = adoptCodexDraft(db, id, { kind: "text", text: "本文" });
  assert.equal(first.link?.url, "https://old.example");
  const rev = getJob(db, id).draftRevision;
  updateDraft(db, id, { kind: "text", text: "本文", link: { url: "https://new.example", place: "body" } }, { expectedRevision: rev });
  assert.deepEqual(adoptCodexDraft(db, id, { kind: "text", text: "直した" }).link, { url: "https://new.example", place: "body" });
  const rev2 = getJob(db, id).draftRevision;
  updateDraft(db, id, { kind: "text", text: "直した" }, { expectedRevision: rev2 });
  assert.equal(adoptCodexDraft(db, id, { kind: "text", text: "もう一度" }).link, undefined);
});

test("should refuse to adopt a codex draft when the draft changed since the generation started", (t) => {
  const { db } = setup(t);
  const id = createJob(db, { brief: { ...brief, kind: "text" }, source: "ui" });
  adoptCodexDraft(db, id, { kind: "text", text: "一" });
  const startRevision = getJob(db, id).draftRevision;
  updateDraft(db, id, { kind: "text", text: "人が直した" }, { expectedRevision: startRevision });
  assert.throws(() => adoptCodexDraft(db, id, { kind: "text", text: "古い生成" }, { expectedRevision: startRevision }), RevisionConflictError);
  assert.equal(getJob(db, id).draft.text, "人が直した");
});

test("should build photo slots from the job's photos in order, taking texts from codex by photo id", (t) => {
  const { db } = setup(t);
  const id = createJob(db, { brief: { theme: "写真", photoMode: true }, source: "ui" });
  for (const [pid, at] of [["p000000000001", "2026-10-03T00:00:01Z"], ["p000000000002", "2026-10-03T00:00:02Z"]]) {
    db.prepare("INSERT INTO job_photos (job_id, photo_id, path, width, height, created_at) VALUES (?, ?, 'x', 1000, 1000, ?)").run(id, pid, at);
  }
  const d = adoptCodexDraft(db, id, { kind: "text", text: "本文", images: [{ photoId: "p000000000002", headline: "二枚目" }, { headline: "番号だけ" }] });
  assert.equal(d.kind, "carousel");
  assert.deepEqual(d.images?.map((i) => [i.slot, i.photoId, i.headline, i.layout]), [
    [1, "p000000000001", "番号だけ", "bottom"],
    [2, "p000000000002", "二枚目", "bottom"],
  ]);
});

test("should keep the user's layout choices for a photo when codex revises the texts", (t) => {
  const { db } = setup(t);
  const id = createJob(db, { brief: { theme: "写真", photoMode: true }, source: "ui" });
  db.prepare("INSERT INTO job_photos (job_id, photo_id, path, width, height, created_at) VALUES (?, 'p000000000001', 'x', 1000, 1000, 'now')").run(id);
  const first = adoptCodexDraft(db, id, { kind: "image", text: "本文", images: [{ photoId: "p000000000001", headline: "a" }] });
  const changed = { ...first, images: first.images?.map((i) => ({ ...i, layout: "top", tone: "light", focus: "bottom" })) };
  updateDraft(db, id, changed, { expectedRevision: getJob(db, id).draftRevision });
  const again = adoptCodexDraft(db, id, { kind: "image", text: "直した", images: [{ photoId: "p000000000001", headline: "b" }] });
  assert.deepEqual([again.images?.[0].layout, again.images?.[0].tone, again.images?.[0].focus, again.images?.[0].kind === undefined], ["top", "light", "bottom", true]);
  assert.equal(again.kind, "image");
});

test("should clear a photo slot revision when its layout changes", async (t) => {
  const { db, dataRoot } = setup(t);
  const id = createJob(db, { brief: { theme: "写真", photoMode: true }, source: "ui" });
  db.prepare("INSERT INTO job_photos (job_id, photo_id, path, width, height, created_at) VALUES (?, 'p000000000001', 'x', 1000, 1000, 'now')").run(id);
  adoptCodexDraft(db, id, { kind: "image", text: "本文", images: [{ photoId: "p000000000001", headline: "a" }] });
  const gen = path.join(dataRoot, "gen");
  fs.mkdirSync(path.join(gen, "images"), { recursive: true });
  fs.writeFileSync(path.join(gen, "images", "slide-01.png"), PNG);
  await adoptImages(db, { dataRoot, jobId: id, genDir: gen, slots: [1] });
  const j = getJob(db, id);
  const d = structuredClone(j.draft);
  d.images[0].layout = "center";
  assert.equal(updateDraft(db, id, d, { expectedRevision: j.draftRevision }).draft.images?.[0].revision, null);
});
