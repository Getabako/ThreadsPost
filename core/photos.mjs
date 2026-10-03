// @ts-check
// 利用者の写真の取り込み。計画:「追加機能: 本物の写真に文字を入れる」方針 2・3
// 向きを直し、位置情報などのメタデータを消し、長い辺を 2560px までにした JPEG だけを保存する（元のファイルは残さない）。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { withImmediateTx, nowIso, withLease } from "./db.mjs";
import { jobDir, getJob, registerImages, JobStateError, NotFoundError } from "./jobs.mjs";
import { renderOverlay, OverlayError } from "./overlay.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Db */

export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export const MAX_PHOTOS = 10;
const MAX_EDGE = 2560;
const MIN_EDGE = 320;

export class PhotoError extends Error {
  /** @param {string} m */
  constructor(m) {
    super(m);
    this.name = "PhotoError";
  }
}

/** @param {string} dataRoot @param {string} jobId @param {string} photoId */
export function photoPath(dataRoot, jobId, photoId) {
  if (!/^p[0-9a-f]{12}$/.test(photoId)) throw new NotFoundError();
  return path.join(jobDir(dataRoot, jobId), "photos", `${photoId}.jpg`);
}

/**
 * @param {Db} db
 * @param {string} jobId
 * @returns {Array<{ photoId: string, width: number, height: number, createdAt: string }>}
 */
export function listPhotos(db, jobId) {
  return /** @type {any[]} */ (db.prepare("SELECT photo_id, width, height, created_at FROM job_photos WHERE job_id = ? ORDER BY created_at, rowid").all(jobId)).map((r) => ({
    photoId: r.photo_id,
    width: r.width,
    height: r.height,
    createdAt: r.created_at,
  }));
}

/**
 * sharp で読めない形式（HEIC など）は macOS の sips で JPEG に変えて読む。
 * @param {Buffer} buffer
 * @param {string} tmpDir
 * @returns {Promise<Buffer>} sharp で読める画像
 */
async function decodable(buffer, tmpDir) {
  try {
    await sharp(buffer, { limitInputPixels: 80_000_000 }).raw().toBuffer();
    return buffer;
  } catch {
    // 下で sips を試す
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  const id = crypto.randomBytes(6).toString("hex");
  const src = path.join(tmpDir, `in-${id}`);
  const out = path.join(tmpDir, `out-${id}.jpg`);
  try {
    fs.writeFileSync(src, buffer);
    const r = spawnSync("/usr/bin/sips", ["-s", "format", "jpeg", src, "--out", out], { stdio: "ignore", timeout: 60_000 });
    if (r.status !== 0 || !fs.existsSync(out)) throw new PhotoError("写真として読めませんでした（JPEG・PNG・HEIC・WebP に対応しています）");
    const converted = fs.readFileSync(out);
    await sharp(converted).raw().toBuffer();
    return converted;
  } catch (e) {
    if (e instanceof PhotoError) throw e;
    throw new PhotoError("写真として読めませんでした（JPEG・PNG・HEIC・WebP に対応しています）");
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(out, { force: true });
  }
}

/**
 * 写真を 1 枚取り込む。
 * @param {Db} db
 * @param {{ dataRoot: string, jobId: string, buffer: Buffer }} o
 * @returns {Promise<{ photoId: string, width: number, height: number }>}
 */
export async function importPhoto(db, { dataRoot, jobId, buffer }) {
  const job = /** @type {any} */ (db.prepare("SELECT state FROM jobs WHERE job_id = ?").get(jobId));
  if (!job) throw new NotFoundError();
  if (job.state !== "draft") throw new JobStateError("投稿を始めた下書きには写真を足せません。");
  if (buffer.length > MAX_PHOTO_BYTES) throw new PhotoError("写真が大きすぎます（25MB まで）");
  const count = /** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM job_photos WHERE job_id = ?").get(jobId)).n;
  if (count >= MAX_PHOTOS) throw new PhotoError(`写真は 1 つの下書きに ${MAX_PHOTOS} 枚までです`);

  const src = await decodable(buffer, path.join(dataRoot, "tmp"));
  // 向きを画素に反映し（rotate）、メタデータは付けない（sharp は既定で書き出しにメタデータを付けない）
  const { data, info } = await sharp(src, { limitInputPixels: 80_000_000 })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .toColorspace("srgb")
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  if (Math.min(info.width, info.height) < MIN_EDGE) throw new PhotoError(`写真が小さすぎます（短い辺が ${MIN_EDGE}px 以上の写真を使ってください）`);

  const photoId = "p" + crypto.randomBytes(6).toString("hex");
  const dest = photoPath(dataRoot, jobId, photoId);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data, { flag: "wx" });
  try {
    withImmediateTx(db, () => {
      const n = /** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM job_photos WHERE job_id = ?").get(jobId)).n;
      if (n >= MAX_PHOTOS) throw new PhotoError(`写真は 1 つの下書きに ${MAX_PHOTOS} 枚までです`);
      db.prepare("INSERT INTO job_photos (job_id, photo_id, path, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        jobId,
        photoId,
        dest,
        info.width,
        info.height,
        nowIso(),
      );
      db.prepare("UPDATE jobs SET updated_at = ? WHERE job_id = ?").run(nowIso(), jobId);
    });
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  return { photoId, width: info.width, height: info.height };
}

/**
 * 写真の枠に文字を重ね、画像の版として登録する（リースは呼び出し側が持つ。生成の取り込み中から呼ぶ）。
 * slots が null なら、まだ版の無い写真の枠すべて。文字が収まらない枠は errors に入れて、ほかの枠は続ける。
 * @param {Db} db
 * @param {{ dataRoot: string, jobId: string, slots: number[] | null }} o
 * @returns {Promise<{ rendered: Array<{ slot: number, revision: number }>, errors: Array<{ slot: number, reason: string }> }>}
 */
export async function renderPhotoSlotsUnlocked(db, { dataRoot, jobId, slots }) {
  const job = getJob(db, jobId);
  if (!job) throw new NotFoundError();
  if (job.state !== "draft") throw new JobStateError("投稿を始めた下書きの画像は差し替えられません。");
  const targets = (job.draft?.images ?? []).filter((i) => i.photoId && (slots ? slots.includes(i.slot) : i.revision === null));
  /** @type {Array<{ slot: number, buf: Buffer }>} */
  const items = [];
  /** @type {Array<{ slot: number, reason: string }>} */
  const errors = [];
  for (const img of targets) {
    try {
      const buf = await renderOverlay({
        photoPath: photoPath(dataRoot, jobId, /** @type {string} */ (img.photoId)),
        headline: img.headline ?? "",
        body: img.body ?? "",
        layout: img.layout ?? "bottom",
        tone: img.tone ?? "dark",
        focus: img.focus ?? "center",
      });
      items.push({ slot: img.slot, buf });
    } catch (e) {
      errors.push({ slot: img.slot, reason: e instanceof OverlayError ? e.message : `文字を入れられませんでした（${e instanceof Error ? e.message : String(e)}）` });
    }
  }
  const rendered = items.length ? registerImages(db, { dataRoot, jobId, items, expectedRevision: job.draftRevision }) : [];
  return { rendered, errors };
}

/**
 * 写真の枠に文字を重ねる（生成と同じ gen リースの中で行う）。
 * @param {Db} db
 * @param {{ dataRoot: string, jobId: string, slots: number[] | null }} o
 */
export function renderPhotos(db, o) {
  return withLease(db, `gen:${o.jobId}`, "写真への文字入れ", () => renderPhotoSlotsUnlocked(db, o));
}
