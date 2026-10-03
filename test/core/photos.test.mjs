import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { makeTempRoot } from "../helpers/temp-root.mjs";
import { openDb } from "../../core/db.mjs";
import { createJob, JobStateError } from "../../core/jobs.mjs";
import { importPhoto, listPhotos, photoPath, PhotoError, MAX_PHOTOS } from "../../core/photos.mjs";

function setup(t) {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  t.after(() => db.close());
  const jobId = createJob(db, { brief: { theme: "写真", kind: "image", photoMode: true }, source: "ui" });
  return { db, dataRoot: tmp.root, jobId };
}

/** 横長 600×400 の JPEG に、向き（右に 90 度）と著作者の情報を入れる */
async function jpegWithMetadata() {
  return sharp({ create: { width: 600, height: 400, channels: 3, background: "#c84" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Artist: "secret-person", Copyright: "secret" } })
    .toBuffer();
}

test("should import a jpeg, apply its orientation and drop all metadata", async (t) => {
  const { db, dataRoot, jobId } = setup(t);
  const src = await jpegWithMetadata();
  assert.ok((await sharp(src).metadata()).exif, "the test photo must carry exif");
  const p = await importPhoto(db, { dataRoot, jobId, buffer: src });
  assert.match(p.photoId, /^p[0-9a-f]{12}$/);
  assert.deepEqual([p.width, p.height], [400, 600]);
  const stored = fs.readFileSync(photoPath(dataRoot, jobId, p.photoId));
  const meta = await sharp(stored).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.exif, undefined);
  assert.equal(meta.orientation, undefined);
  assert.ok(!stored.includes(Buffer.from("secret-person")));
  assert.deepEqual(listPhotos(db, jobId).map((x) => x.photoId), [p.photoId]);
});

test("should shrink large photos to 2560px on the long side", async (t) => {
  const { db, dataRoot, jobId } = setup(t);
  const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#468" } }).png().toBuffer();
  const p = await importPhoto(db, { dataRoot, jobId, buffer: big });
  assert.deepEqual([p.width, p.height], [2560, 1920]);
});

test("should import a heic photo by converting it with sips", async (t) => {
  const { db, dataRoot, jobId } = setup(t);
  const jpg = path.join(dataRoot, "x.jpg");
  fs.writeFileSync(jpg, await sharp({ create: { width: 500, height: 700, channels: 3, background: "#5a5" } }).jpeg().toBuffer());
  const heic = path.join(dataRoot, "x.heic");
  const r = spawnSync("sips", ["-s", "format", "heic", jpg, "--out", heic]);
  if (r.status !== 0) {
    t.skip("sips cannot write heic on this machine");
    return;
  }
  const p = await importPhoto(db, { dataRoot, jobId, buffer: fs.readFileSync(heic) });
  assert.deepEqual([p.width, p.height], [500, 700]);
  assert.equal((await sharp(photoPath(dataRoot, jobId, p.photoId)).metadata()).format, "jpeg");
});

test("should reject files that are not images, too large or too many", async (t) => {
  const { db, dataRoot, jobId } = setup(t);
  await assert.rejects(importPhoto(db, { dataRoot, jobId, buffer: Buffer.from("hello, not an image") }), PhotoError);
  await assert.rejects(importPhoto(db, { dataRoot, jobId, buffer: Buffer.alloc(26 * 1024 * 1024) }), /大きすぎ/);
  const small = await sharp({ create: { width: 320, height: 400, channels: 3, background: "#888" } }).png().toBuffer();
  for (let i = 0; i < MAX_PHOTOS; i++) await importPhoto(db, { dataRoot, jobId, buffer: small });
  await assert.rejects(importPhoto(db, { dataRoot, jobId, buffer: small }), /10 枚/);
});

test("should reject tiny photos that cannot become a Threads image", async (t) => {
  const { db, dataRoot, jobId } = setup(t);
  const tiny = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#888" } }).png().toBuffer();
  await assert.rejects(importPhoto(db, { dataRoot, jobId, buffer: tiny }), /小さすぎ/);
});

test("should refuse to import into a frozen job", async (t) => {
  const { db, dataRoot, jobId } = setup(t);
  db.prepare("UPDATE jobs SET state='frozen' WHERE job_id=?").run(jobId);
  const small = await sharp({ create: { width: 320, height: 400, channels: 3, background: "#888" } }).png().toBuffer();
  await assert.rejects(importPhoto(db, { dataRoot, jobId, buffer: small }), JobStateError);
});

test("should render text onto photo slots and register them as image revisions", async (t) => {
  const { db, dataRoot, jobId } = setup(t);
  const { adoptCodexDraft, getJob } = await import("../../core/jobs.mjs");
  const { renderPhotos } = await import("../../core/photos.mjs");
  const p = await importPhoto(db, { dataRoot, jobId, buffer: await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#a63" } }).jpeg().toBuffer() });
  adoptCodexDraft(db, jobId, { kind: "image", text: "本文", images: [{ photoId: p.photoId, headline: "見出し", body: "補足" }] });
  const r = await renderPhotos(db, { dataRoot, jobId, slots: null });
  assert.deepEqual(r.rendered, [{ slot: 1, revision: 1 }]);
  const j = getJob(db, jobId);
  assert.equal(j?.draft?.images?.[0].revision, 1);
  const m = await sharp(j.images[0] && (await import("../../core/jobs.mjs")).imagePath(dataRoot, jobId, 1, 1)).metadata();
  assert.deepEqual([m.width, m.height], [1080, 1350]);
  const again = await renderPhotos(db, { dataRoot, jobId, slots: [1] });
  assert.deepEqual(again.rendered, [{ slot: 1, revision: 2 }]);
});

test("should report a slot whose text does not fit instead of failing all", async (t) => {
  const { db, dataRoot, jobId } = setup(t);
  const { adoptCodexDraft } = await import("../../core/jobs.mjs");
  const { renderPhotos } = await import("../../core/photos.mjs");
  const p = await importPhoto(db, { dataRoot, jobId, buffer: await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#a63" } }).jpeg().toBuffer() });
  adoptCodexDraft(db, jobId, { kind: "image", text: "本文", images: [{ photoId: p.photoId, headline: "見出し", body: "長すぎる。".repeat(300) }] });
  const r = await renderPhotos(db, { dataRoot, jobId, slots: null });
  assert.deepEqual(r.rendered, []);
  assert.equal(r.errors[0].slot, 1);
  assert.match(r.errors[0].reason, /収まりません/);
});
