// @ts-check
// 投稿パッケージ: 完成した下書きを、Threads にそのまま出せる形でローカルのフォルダに保存する。
// 送る本文（クレジット・リンク込み）・返信・送れる形に整えた画像（JPEG）・投稿情報・手で投稿する手順。
// 投稿（アップロード）の段階は、このパッケージの投稿情報（payloadSha256）を承認と送信の元にする予定。
// 人間の指示（2026-10-03）「画像や投稿文はローカルに保存される方式で」

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { withLease, nowIso, addJobEvent } from "./db.mjs";
import { getJob, imagePath, NotFoundError } from "./jobs.mjs";
import { buildFinalPayload, validateFinalPayload, draftReadiness } from "./validate.mjs";
import { normalizeImage } from "./media.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Db */
/** @typedef {import("./validate.mjs").ValidationIssue} ValidationIssue */

export const PACKAGE_FORMAT = "threadspost-package/1";

export class PackageNotReadyError extends Error {
  /** @param {ValidationIssue[]} issues */
  constructor(issues) {
    super(`まだ保存できません: ${issues.map((i) => i.message).join(" / ")}`);
    this.name = "PackageNotReadyError";
    this.issues = issues;
  }
}

/**
 * 既定の保存先: アプリのフォルダの中の「Threads投稿」（デスクトップには置かない。人間の指示 2026-10-05）
 * @param {string} appRoot アプリ（ThreadsPost）のフォルダ
 */
export function defaultExportRoot(appRoot) {
  return process.env.THREADSPOST_EXPORT_DIR || path.join(appRoot, "Threads投稿");
}

const JST = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * フォルダの名前: 日本時間の日時_テーマ_仕事 ID の末尾
 * @param {{ jobId: string, theme: string | null }} job
 * @param {Date} now
 */
export function exportFolderName(job, now) {
  const p = Object.fromEntries(JST.formatToParts(now).map((x) => [x.type, x.value]));
  const stamp = `${p.year}${p.month}${p.day}-${p.hour === "24" ? "00" : p.hour}${p.minute}`;
  const theme = (job.theme ?? "下書き")
    .replace(/[\/\\:*?"<>|\n\r\t]/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 30) || "下書き";
  return `${stamp}_${theme}_${job.jobId.slice(-6)}`;
}

/**
 * @param {Db} db
 * @param {string} jobId
 * @returns {{ dir: string, draftRevision: number, createdAt: string, payloadSha256: string, stale: boolean } | null}
 */
export function getExport(db, jobId) {
  const r = /** @type {any} */ (db.prepare("SELECT e.dir, e.draft_revision, e.created_at, e.payload_sha256, j.draft_revision AS current FROM exports e JOIN jobs j ON j.job_id = e.job_id WHERE e.job_id = ?").get(jobId));
  if (!r) return null;
  return { dir: r.dir, draftRevision: r.draft_revision, createdAt: r.created_at, payloadSha256: r.payload_sha256, stale: r.current !== r.draft_revision };
}

/** 正規化した JSON（キーの順を固定）でハッシュを取る @param {unknown} v */
function canonicalSha(v) {
  /** @param {any} x @returns {any} */
  const sort = (x) => (Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return crypto.createHash("sha256").update(JSON.stringify(sort(v))).digest("hex");
}

const REPLY_LABEL = {
  everyone: "だれでも",
  accounts_you_follow: "自分がフォローしている人",
  followers_only: "フォロワーだけ",
  mentioned_only: "メンションした人だけ",
  parent_post_author_only: "自分だけ",
};

/**
 * 下書きを投稿パッケージとして保存する（同じ下書きは同じフォルダを上書きする）。
 * 生成と同じ gen リースの中で行い、生成中は LeaseBusyError。
 * @param {{ db: Db, dataRoot: string, exportRoot: string, jobId: string, entitlement: import("./entitlement.mjs").Entitlement, now?: () => Date }} o
 * @returns {Promise<{ dir: string, manifest: any }>}
 */
export async function buildPackage(o) {
  const now = o.now ?? (() => new Date());
  return withLease(o.db, `gen:${o.jobId}`, "投稿パッケージの保存", async () => {
    const job = getJob(o.db, o.jobId);
    if (!job) throw new NotFoundError();
    if (!job.draft) throw new PackageNotReadyError([{ code: "no_draft", field: "draft", message: "下書きがありません" }]);
    const payload = buildFinalPayload(job.draft, { credit: o.entitlement.limits.credit, allowUserReply: o.entitlement.limits.selfReply });
    const issues = [...draftReadiness(job.draft), ...validateFinalPayload(payload)];
    if (!o.entitlement.limits.kinds.includes(job.draft.kind)) {
      issues.push({ code: "entitlement", field: "kind", message: "この形式はアシュラ会員限定です" });
    }
    if (issues.length) throw new PackageNotReadyError(issues);

    fs.mkdirSync(o.exportRoot, { recursive: true });
    const prev = getExport(o.db, o.jobId);
    const finalDir = prev && path.dirname(prev.dir) === o.exportRoot ? prev.dir : path.join(o.exportRoot, exportFolderName(job, now()));
    const tmp = path.join(o.exportRoot, `.tmp-${crypto.randomBytes(6).toString("hex")}`);
    fs.mkdirSync(tmp);
    try {
      // 画像を送れる形に整えて書く
      const images = [];
      if (payload.main.images.length) fs.mkdirSync(path.join(tmp, "画像"));
      for (const [idx, img] of payload.main.images.entries()) {
        const file = `画像/${String(idx + 1).padStart(2, "0")}.jpg`;
        const src = imagePath(o.dataRoot, o.jobId, img.slot, /** @type {number} */ (img.revision));
        const m = await normalizeImage(src, path.join(tmp, file));
        images.push({ file, slot: img.slot, revision: img.revision, altText: img.altText, width: m.width, height: m.height, bytes: m.bytes, sha256: m.sha256 });
      }
      const main = { kind: payload.main.kind, text: payload.main.text, topicTag: payload.main.topicTag, replyControl: payload.main.replyControl, images };
      const payloadSha256 = canonicalSha({ main, reply: payload.reply });
      const manifest = {
        format: PACKAGE_FORMAT,
        jobId: job.jobId,
        theme: job.theme,
        draftRevision: job.draftRevision,
        createdAt: now().toISOString(),
        plan: o.entitlement.mode,
        main,
        reply: payload.reply,
        payloadSha256,
      };
      fs.writeFileSync(path.join(tmp, "本文.txt"), payload.main.text + "\n");
      if (payload.reply) fs.writeFileSync(path.join(tmp, "返信.txt"), payload.reply.text + "\n");
      fs.writeFileSync(path.join(tmp, "投稿情報.json"), JSON.stringify(manifest, null, 2) + "\n");
      fs.writeFileSync(path.join(tmp, "手動で投稿するとき.txt"), manualGuide(manifest));

      // 前のパッケージと入れ替える（同じ下書きのフォルダだけ）
      if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(tmp, finalDir);
      o.db
        .prepare(
          "INSERT INTO exports (job_id, dir, draft_revision, payload_sha256, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET dir = excluded.dir, draft_revision = excluded.draft_revision, payload_sha256 = excluded.payload_sha256, created_at = excluded.created_at",
        )
        .run(o.jobId, finalDir, job.draftRevision, payloadSha256, nowIso());
      addJobEvent(o.db, o.jobId, "export", `投稿パッケージを保存しました: ${finalDir}`);
      return { dir: finalDir, manifest };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

/** @param {any} m */
function manualGuide(m) {
  const lines = [
    "このフォルダは Threads Post（アシュラ秘奥義）が作った、Threads の投稿の下書きです。",
    "",
    "■ 手で投稿するとき",
    "1. Threads のアプリで新しいスレッドを作る",
    "2. 「本文.txt」の中身をそのまま貼る",
  ];
  if (m.main.images.length) lines.push(`3. 「画像」フォルダの ${m.main.images.length} 枚を番号順に添付する（代替テキストは下の一覧）`);
  if (m.main.topicTag) lines.push(`・トピックタグ: ${m.main.topicTag}`);
  lines.push(`・返信できる人: ${/** @type {any} */ (REPLY_LABEL)[m.main.replyControl] ?? m.main.replyControl}`);
  if (m.reply) lines.push("・投稿したら、自分の投稿に「返信.txt」の中身を返信する");
  if (m.main.images.length) {
    lines.push("", "■ 画像の代替テキスト");
    for (const i of m.main.images) lines.push(`${i.file}: ${i.altText ?? "（なし）"}`);
  }
  lines.push("", "■ 自動で投稿するとき", "Threads Post の投稿機能（準備中）が、このフォルダの「投稿情報.json」をもとに投稿します。", "");
  return lines.join("\n");
}

/**
 * パッケージのフォルダを ZIP にする。ファイル名に UTF-8 の印（0x0800）を付け、どの OS でも日本語の名前が崩れないようにする。
 * 画像は JPEG で圧縮済みなので、無圧縮（stored）で格納する。Mac の余計なファイル（.DS_Store・._*）は入れない。
 * @param {string} dir
 * @returns {Promise<Buffer>}
 */
export async function zipPackage(dir) {
  const base = path.basename(dir);
  /** @type {Array<{ name: string, data: Buffer | null }>} */
  const entries = [{ name: `${base}/`, data: null }];
  /** @param {string} abs @param {string} rel */
  const walk = (abs, rel) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (d.name === ".DS_Store" || d.name.startsWith("._")) continue;
      const a = path.join(abs, d.name);
      const r = `${rel}/${d.name}`;
      if (d.isDirectory()) {
        entries.push({ name: `${r}/`, data: null });
        walk(a, r);
      } else if (d.isFile()) entries.push({ name: r, data: fs.readFileSync(a) });
    }
  };
  walk(dir, base);

  const { crc32 } = await import("node:zlib");
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  /** @type {Buffer[]} */
  const parts = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data ?? Buffer.alloc(0);
    const crc = e.data ? crc32(data) >>> 0 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 必要なバージョン
    local.writeUInt16LE(0x0800, 6); // ファイル名は UTF-8
    local.writeUInt16LE(0, 8); // 無圧縮
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x0314, 4); // 作成: UNIX・2.0
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE((e.data ? 0o100644 : 0o040755) * 0x10000, 38); // UNIX の権限
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, end]);
}
