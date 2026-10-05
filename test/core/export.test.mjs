import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { makeTempRoot } from "../helpers/temp-root.mjs";
import { openDb, acquireLease } from "../../core/db.mjs";
import { createJob, adoptCodexDraft, adoptImages, getJob, updateDraft, deleteJob, JobStateError } from "../../core/jobs.mjs";
import { buildPackage, getExport, exportFolderName, zipPackage, PackageNotReadyError, defaultExportRoot } from "../../core/export.mjs";
import { LeaseBusyError } from "../../core/db.mjs";

const FULL = { mode: "full", message: "", limits: { kinds: ["text", "image", "carousel"], unattended: true, selfReply: true, credit: null } };
const FREE = { mode: "free", message: "", limits: { kinds: ["text"], unattended: false, selfReply: false, credit: { text: "#アシュラ秘奥義", place: "body" } } };

function setup(t) {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  t.after(() => db.close());
  return { db, dataRoot: tmp.root, exportRoot: path.join(tmp.root, "Threads投稿") };
}

async function withImages(db, dataRoot, jobId, slots) {
  const gen = path.join(dataRoot, "gen-" + Math.random().toString(16).slice(2));
  fs.mkdirSync(path.join(gen, "images"), { recursive: true });
  const buf = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#58c" } }).png().toBuffer();
  for (const s of slots) fs.writeFileSync(path.join(gen, "images", `slide-${String(s).padStart(2, "0")}.png`), buf);
  await adoptImages(db, { dataRoot, jobId, genDir: gen, slots });
}

const now = () => new Date("2026-10-03T01:02:00Z");

test("should name the folder with the Japan time, a safe theme and the job id", () => {
  const name = exportFolderName({ jobId: "j20261003-010200-abcdef", theme: "議事録/AI: 40分?" }, now());
  assert.equal(name, "20261003-1002_議事録-AI- 40分-_abcdef");
});

test("should save a text draft as a local package with the final text", async (t) => {
  const { db, dataRoot, exportRoot } = setup(t);
  const jobId = createJob(db, { brief: { theme: "議事録", kind: "text", link: { url: "https://if-juku.net", place: "reply" } }, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "text", text: "本文です", topicTag: "AI活用", selfReplyText: "補足" });
  const r = await buildPackage({ db, dataRoot, exportRoot, jobId, entitlement: /** @type {any} */ (FULL), now });
  assert.ok(r.dir.startsWith(exportRoot + path.sep));
  assert.equal(fs.readFileSync(path.join(r.dir, "本文.txt"), "utf8"), "本文です\n");
  assert.equal(fs.readFileSync(path.join(r.dir, "返信.txt"), "utf8"), "補足\n\nhttps://if-juku.net\n");
  const m = JSON.parse(fs.readFileSync(path.join(r.dir, "投稿情報.json"), "utf8"));
  assert.equal(m.format, "threadspost-package/1");
  assert.equal(m.main.topicTag, "AI活用");
  assert.match(m.payloadSha256, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(r.dir, "手動で投稿するとき.txt")));
  assert.equal(getExport(db, jobId)?.dir, r.dir);
});

test("should apply the free plan rules to the saved text", async (t) => {
  const { db, dataRoot, exportRoot } = setup(t);
  const jobId = createJob(db, { brief: { theme: "x", kind: "text" }, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "text", text: "本文" });
  const r = await buildPackage({ db, dataRoot, exportRoot, jobId, entitlement: /** @type {any} */ (FREE), now });
  assert.equal(fs.readFileSync(path.join(r.dir, "本文.txt"), "utf8"), "本文\n\n#アシュラ秘奥義\n");
  assert.equal(fs.existsSync(path.join(r.dir, "返信.txt")), false);
});

test("should save carousel images as upload-ready jpegs with alt texts in the manifest", async (t) => {
  const { db, dataRoot, exportRoot } = setup(t);
  const jobId = createJob(db, { brief: { theme: "カルーセル", kind: "carousel", slideCount: 2 }, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "carousel", text: "本文", images: [{ headline: "a", altText: "一枚目" }, { headline: "b", altText: "二枚目" }] });
  await withImages(db, dataRoot, jobId, [1, 2]);
  const r = await buildPackage({ db, dataRoot, exportRoot, jobId, entitlement: /** @type {any} */ (FULL), now });
  const m = JSON.parse(fs.readFileSync(path.join(r.dir, "投稿情報.json"), "utf8"));
  assert.deepEqual(m.main.images.map((i) => [i.file, i.altText, i.width, i.height]), [
    ["画像/01.jpg", "一枚目", 1080, 1350],
    ["画像/02.jpg", "二枚目", 1080, 1350],
  ]);
  for (const i of m.main.images) {
    const meta = await sharp(path.join(r.dir, i.file)).metadata();
    assert.equal(meta.format, "jpeg");
  }
});

test("should refuse to save a draft that is not ready and explain why", async (t) => {
  const { db, dataRoot, exportRoot } = setup(t);
  const jobId = createJob(db, { brief: { theme: "x", kind: "carousel", slideCount: 2 }, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "carousel", text: "本文", images: [{ headline: "a" }, { headline: "b" }] });
  await assert.rejects(buildPackage({ db, dataRoot, exportRoot, jobId, entitlement: /** @type {any} */ (FULL), now }), PackageNotReadyError);
  const j2 = createJob(db, { brief: { theme: "y", kind: "text" }, source: "ui" });
  adoptCodexDraft(db, j2, { kind: "text", text: "あ".repeat(501) });
  await assert.rejects(buildPackage({ db, dataRoot, exportRoot, jobId: j2, entitlement: /** @type {any} */ (FULL), now }), PackageNotReadyError);
  assert.equal(fs.existsSync(exportRoot) ? fs.readdirSync(exportRoot).filter((f) => !f.startsWith(".")).length : 0, 0);
});

test("should overwrite the same folder when saving again and report it stale after an edit", async (t) => {
  const { db, dataRoot, exportRoot } = setup(t);
  const jobId = createJob(db, { brief: { theme: "x", kind: "text" }, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "text", text: "一" });
  const a = await buildPackage({ db, dataRoot, exportRoot, jobId, entitlement: /** @type {any} */ (FULL), now });
  updateDraft(db, jobId, { kind: "text", text: "二" }, { expectedRevision: getJob(db, jobId).draftRevision });
  assert.equal(getExport(db, jobId)?.stale, true);
  const b = await buildPackage({ db, dataRoot, exportRoot, jobId, entitlement: /** @type {any} */ (FULL), now: () => new Date("2026-10-04T00:00:00Z") });
  assert.equal(b.dir, a.dir);
  assert.equal(fs.readFileSync(path.join(b.dir, "本文.txt"), "utf8"), "二\n");
  assert.equal(getExport(db, jobId)?.stale, false);
  assert.equal(fs.readdirSync(exportRoot).filter((f) => !f.startsWith(".")).length, 1);
});

test("should not save while a generation holds the lease", async (t) => {
  const { db, dataRoot, exportRoot } = setup(t);
  const jobId = createJob(db, { brief: { theme: "x", kind: "text" }, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "text", text: "一" });
  const held = acquireLease(db, `gen:${jobId}`, { purpose: "生成" });
  assert.ok(!("busy" in held));
  await assert.rejects(buildPackage({ db, dataRoot, exportRoot, jobId, entitlement: /** @type {any} */ (FULL), now }), LeaseBusyError);
});

test("should zip the package folder", async (t) => {
  const { db, dataRoot, exportRoot } = setup(t);
  const jobId = createJob(db, { brief: { theme: "x", kind: "text" }, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "text", text: "一" });
  const r = await buildPackage({ db, dataRoot, exportRoot, jobId, entitlement: /** @type {any} */ (FULL), now });
  const zip = await zipPackage(r.dir);
  assert.equal(zip.subarray(0, 2).toString(), "PK");
  // ファイル名は UTF-8 の印（0x0800）つきで、Mac の余計なファイル（__MACOSX・._*）を入れない
  const names = [];
  for (let i = 0; i + 46 <= zip.length; i++) {
    if (zip.readUInt32LE(i) !== 0x02014b50) continue;
    assert.equal(zip.readUInt16LE(i + 8) & 0x0800, 0x0800);
    const n = zip.readUInt16LE(i + 28);
    names.push(zip.subarray(i + 46, i + 46 + n).toString("utf8"));
  }
  assert.ok(names.some((n) => n.endsWith("/本文.txt")));
  assert.ok(names.every((n) => !n.includes("__MACOSX") && !n.split("/").some((p) => p.startsWith("._"))));
  const out = path.join(dataRoot, "t.zip");
  fs.writeFileSync(out, zip);
  const { spawnSync } = await import("node:child_process");
  assert.equal(spawnSync("unzip", ["-tq", out]).status, 0, "zip must pass unzip -t");
});

test("should delete a draft job with its images and generations but keep the saved package", async (t) => {
  const { db, dataRoot, exportRoot } = setup(t);
  const jobId = createJob(db, { brief: { theme: "x", kind: "image" }, source: "ui" });
  adoptCodexDraft(db, jobId, { kind: "image", text: "本文", images: [{ headline: "a" }] });
  await withImages(db, dataRoot, jobId, [1]);
  const r = await buildPackage({ db, dataRoot, exportRoot, jobId, entitlement: /** @type {any} */ (FULL), now });
  deleteJob(db, { dataRoot, jobId });
  assert.equal(getJob(db, jobId), null);
  assert.equal(fs.existsSync(path.join(dataRoot, "jobs", jobId)), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_images WHERE job_id = ?").get(jobId).n, 0);
  assert.ok(fs.existsSync(r.dir), "the saved package is the user's file and is kept");
});

test("should refuse to delete a frozen job or one that is generating", async (t) => {
  const { db, dataRoot } = setup(t);
  const a = createJob(db, { brief: { theme: "x", kind: "text" }, source: "ui" });
  db.prepare("UPDATE jobs SET state='frozen' WHERE job_id=?").run(a);
  assert.throws(() => deleteJob(db, { dataRoot, jobId: a }), JobStateError);
  const b = createJob(db, { brief: { theme: "y", kind: "text" }, source: "ui" });
  const held = acquireLease(db, `gen:${b}`, { purpose: "生成" });
  assert.ok(!("busy" in held));
  assert.throws(() => deleteJob(db, { dataRoot, jobId: b }), LeaseBusyError);
});

test("should save packages inside the app folder by default, never on the desktop", () => {
  const saved = process.env.THREADSPOST_EXPORT_DIR;
  delete process.env.THREADSPOST_EXPORT_DIR;
  try {
    const root = defaultExportRoot("/apps/ThreadsPost");
    assert.equal(root, path.join("/apps/ThreadsPost", "Threads投稿"));
    assert.ok(!root.includes("Desktop"));
  } finally {
    if (saved !== undefined) process.env.THREADSPOST_EXPORT_DIR = saved;
  }
});
