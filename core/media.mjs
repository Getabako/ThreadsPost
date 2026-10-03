// @ts-check
// 画像を Threads に送れる形（JPEG・sRGB・幅 320〜1440px・8MB 未満）に整える。計画: Task 21・22
// 元の画像（取り込んだ PNG）は書き換えず、整えた JPEG を別に書く。

import fs from "node:fs";
import crypto from "node:crypto";
import sharp from "sharp";
import { validateUploadImage, UPLOAD_MAX_BYTES } from "./validate.mjs";

const MAX_WIDTH = 1440;

/**
 * @param {string} srcPath 取り込んだ画像
 * @param {string} destPath 書き出す JPEG
 * @returns {Promise<{ format: "jpeg", width: number, height: number, bytes: number, sha256: string }>}
 */
export async function normalizeImage(srcPath, destPath) {
  const meta = await sharp(srcPath).metadata();
  const width = Math.min(meta.width ?? 0, MAX_WIDTH);
  /** @type {Buffer | null} */
  let out = null;
  let info = /** @type {{ width: number, height: number } | null} */ (null);
  for (const quality of [90, 82, 74, 66, 58]) {
    const r = await sharp(srcPath)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .toColorspace("srgb")
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    out = r.data;
    info = r.info;
    if (out.length < UPLOAD_MAX_BYTES) break;
  }
  if (!out || !info) throw new Error("画像を変換できませんでした");
  const m = { format: /** @type {const} */ ("jpeg"), width: info.width, height: info.height, bytes: out.length, sha256: crypto.createHash("sha256").update(out).digest("hex") };
  const issues = validateUploadImage(m);
  if (issues.length) throw new Error(`Threads に送れる画像にできませんでした: ${issues.map((i) => i.message).join(" / ")}`);
  fs.writeFileSync(destPath, out);
  return m;
}
