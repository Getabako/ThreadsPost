import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { makeTempRoot } from "../helpers/temp-root.mjs";
import { normalizeImage } from "../../core/media.mjs";
import { validateUploadImage } from "../../core/validate.mjs";

/** @param {number} w @param {number} h */
async function png(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: "#3a7" } }).png().toBuffer();
}

test("should convert png to srgb jpeg within 1440px that passes the upload check", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const src = path.join(tmp.root, "a.png");
  fs.writeFileSync(src, await png(1080, 1350));
  const dest = path.join(tmp.root, "a.jpg");
  const m = await normalizeImage(src, dest);
  assert.equal(m.format, "jpeg");
  assert.equal(m.width, 1080);
  assert.equal(m.height, 1350);
  assert.equal(m.bytes, fs.statSync(dest).size);
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(validateUploadImage(m), []);
  const meta = await sharp(dest).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.space, "srgb");
});

test("should shrink images wider than 1440px", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const src = path.join(tmp.root, "b.png");
  fs.writeFileSync(src, await png(2000, 2500));
  const m = await normalizeImage(src, path.join(tmp.root, "b.jpg"));
  assert.equal(m.width, 1440);
  assert.equal(m.height, 1800);
});

test("should refuse images that cannot meet the upload rules", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const src = path.join(tmp.root, "c.png");
  fs.writeFileSync(src, await png(200, 300));
  await assert.rejects(normalizeImage(src, path.join(tmp.root, "c.jpg")), /幅/);
  assert.equal(fs.existsSync(path.join(tmp.root, "c.jpg")), false);
});
