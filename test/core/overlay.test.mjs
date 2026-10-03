import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { makeTempRoot } from "../helpers/temp-root.mjs";
import { renderOverlay, OverlayError, OUT_WIDTH, OUT_HEIGHT } from "../../core/overlay.mjs";

/** 真ん中が灰色の写真（明るさを比べやすい） */
async function photo(dir, w = 1600, h = 1200) {
  const p = path.join(dir, "photo.jpg");
  fs.writeFileSync(p, await sharp({ create: { width: w, height: h, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toBuffer());
  return p;
}

/** 指定した帯（上からの割合）の平均の明るさ */
async function brightness(buf, fromRatio, toRatio) {
  const top = Math.floor(OUT_HEIGHT * fromRatio);
  const height = Math.floor(OUT_HEIGHT * (toRatio - fromRatio));
  // stats() は extract などの途中の処理を無視するので、切り出した画像を作ってから測る
  const part = await sharp(buf).extract({ left: 0, top, width: OUT_WIDTH, height }).png().toBuffer();
  const s = await sharp(part).stats();
  return (s.channels[0].mean + s.channels[1].mean + s.channels[2].mean) / 3;
}

test("should output a 1080x1350 png cropped from the photo", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const buf = await renderOverlay({ photoPath: await photo(tmp.root), headline: "見出し", body: "補足です", layout: "bottom", tone: "dark", focus: "center" });
  const m = await sharp(buf).metadata();
  assert.deepEqual([m.format, m.width, m.height], ["png", OUT_WIDTH, OUT_HEIGHT]);
});

test("should leave the photo untouched when the layout is none", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const buf = await renderOverlay({ photoPath: await photo(tmp.root), headline: "見出し", body: "", layout: "none", tone: "dark", focus: "center" });
  assert.ok(Math.abs((await brightness(buf, 0.85, 1)) - 128) < 3);
});

test("should darken the bottom band for a dark bottom layout and keep the top as the photo", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const buf = await renderOverlay({ photoPath: await photo(tmp.root), headline: "見出し", body: "補足", layout: "bottom", tone: "dark", focus: "center" });
  assert.ok((await brightness(buf, 0.92, 1)) < 80, "bottom band should be dark");
  assert.ok(Math.abs((await brightness(buf, 0, 0.3)) - 128) < 3, "top should be the photo");
});

test("should lighten the top band for a light top layout", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const buf = await renderOverlay({ photoPath: await photo(tmp.root), headline: "見出し", body: "補足", layout: "top", tone: "light", focus: "center" });
  assert.ok((await brightness(buf, 0, 0.06)) > 200, "top band should be light");
  assert.ok(Math.abs((await brightness(buf, 0.7, 1)) - 128) < 3, "bottom should be the photo");
});

test("should put a panel in the middle for the center layout", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const buf = await renderOverlay({ photoPath: await photo(tmp.root), headline: "見出し", body: "補足", layout: "center", tone: "dark", focus: "center" });
  assert.ok((await brightness(buf, 0.47, 0.53)) < 90);
  assert.ok(Math.abs((await brightness(buf, 0, 0.1)) - 128) < 3);
});

test("should shrink long text to fit and refuse text that cannot fit", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const p = await photo(tmp.root);
  const ok = await renderOverlay({ photoPath: p, headline: "とても長い見出しでも小さくして収める", body: "補足の文。".repeat(12), layout: "bottom", tone: "dark", focus: "center" });
  assert.equal((await sharp(ok).metadata()).height, OUT_HEIGHT);
  await assert.rejects(renderOverlay({ photoPath: p, headline: "見出し", body: "長すぎる補足。".repeat(200), layout: "bottom", tone: "dark", focus: "center" }), OverlayError);
});

test("should escape markup characters in the text", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const buf = await renderOverlay({ photoPath: await photo(tmp.root), headline: "A < B & C > D", body: "<b>太字じゃない</b>", layout: "bottom", tone: "dark", focus: "center" });
  assert.equal((await sharp(buf).metadata()).width, OUT_WIDTH);
});
