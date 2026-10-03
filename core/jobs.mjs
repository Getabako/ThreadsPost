// @ts-check
// 仕事（投稿 1 本分）・下書き・会話・画像の取り込み。
// 計画: 方針 3（承認した内容を Node の管理領域に取り込む）・「下書きの決まり」

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { withImmediateTx, nowIso, acquireLease, LeaseBusyError } from "./db.mjs";
import { parseDraft, normalizeCodexDraft } from "./validate.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Db */
/** @typedef {import("./validate.mjs").Draft} Draft */
/** @typedef {import("./validate.mjs").ValidationIssue} ValidationIssue */

/**
 * @typedef {{
 *   theme: string, audience?: string, tone?: string, kind?: "text"|"image"|"carousel",
 *   slideCount?: number, topicTagHint?: string, notes?: string,
 *   link?: { url: string, place: "body"|"reply" },
 *   photoMode?: boolean
 * }} Brief
 * @typedef {{ slot: number, revision: number, sha256: string, isCurrent: boolean, createdAt: string }} JobImage
 * @typedef {{
 *   jobId: string, source: "ui"|"cli", theme: string | null, brief: Brief, draft: Draft | null,
 *   draftRevision: number, state: "draft"|"frozen", copiedFromJobId: string | null,
 *   createdAt: string, updatedAt: string, images: JobImage[], chat: Array<{ role: "user"|"assistant", text: string, createdAt: string }>
 * }} Job
 */

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class JobStateError extends Error {
  /** @param {string} m */
  constructor(m) {
    super(m);
    this.name = "JobStateError";
  }
}
export class RevisionConflictError extends Error {
  constructor() {
    super("ほかの画面で下書きが更新されました。読み込み直してから直してください。");
    this.name = "RevisionConflictError";
  }
}
export class DraftInvalidError extends Error {
  /** @param {ValidationIssue[]} issues */
  constructor(issues) {
    super(issues.map((i) => i.message).join(" / "));
    this.name = "DraftInvalidError";
    this.issues = issues;
  }
}
export class NotFoundError extends Error {
  constructor() {
    super("見つかりません");
    this.name = "NotFoundError";
  }
}

/** 読み取り専用の短い ID（UTC の日時 + 乱数） */
export function newId(prefix = "j") {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${prefix}${ts}-${crypto.randomBytes(3).toString("hex")}`;
}

/** @param {string} id */
export function assertSafeId(id) {
  if (!/^[a-z]\d{8}-\d{6}-[0-9a-f]{6}$/.test(id)) throw new NotFoundError();
}

/** @param {string} dataRoot @param {string} jobId */
export function jobDir(dataRoot, jobId) {
  assertSafeId(jobId);
  return path.join(dataRoot, "jobs", jobId);
}
/** @param {string} dataRoot @param {string} jobId @param {number} slot @param {number} revision */
export function imagePath(dataRoot, jobId, slot, revision) {
  return path.join(jobDir(dataRoot, jobId), "images", `slot-${String(slot).padStart(2, "0")}-r${String(revision).padStart(2, "0")}.png`);
}

/**
 * @param {Db} db
 * @param {{ brief: Brief, source: "ui"|"cli", theme?: string }} o
 * @returns {string}
 */
export function createJob(db, { brief, source }) {
  const id = newId("j");
  const at = nowIso();
  db.prepare(
    "INSERT INTO jobs (job_id, source, theme, brief_json, draft_json, draft_revision, state, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, 'draft', ?, ?)",
  ).run(id, source, brief.theme ?? null, JSON.stringify(brief), at, at);
  return id;
}

/**
 * @param {Db} db
 * @param {string} jobId
 * @returns {Job | null}
 */
export function getJob(db, jobId) {
  const r = /** @type {any} */ (db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId));
  if (!r) return null;
  const images = /** @type {any[]} */ (
    db.prepare("SELECT slot, revision, sha256, is_current, created_at FROM job_images WHERE job_id = ? ORDER BY slot, revision").all(jobId)
  ).map((i) => ({ slot: i.slot, revision: i.revision, sha256: i.sha256, isCurrent: i.is_current === 1, createdAt: i.created_at }));
  const chat = /** @type {any[]} */ (
    db.prepare("SELECT role, text, created_at FROM chat_messages WHERE job_id = ? ORDER BY seq").all(jobId)
  ).map((m) => ({ role: m.role, text: m.text, createdAt: m.created_at }));
  return {
    jobId: r.job_id,
    source: r.source,
    theme: r.theme,
    brief: JSON.parse(r.brief_json),
    draft: r.draft_json ? JSON.parse(r.draft_json) : null,
    draftRevision: r.draft_revision,
    state: r.state,
    copiedFromJobId: r.copied_from_job_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    images,
    chat,
  };
}

/**
 * @param {Db} db
 * @param {{ limit?: number }} [o]
 */
export function listJobs(db, o = {}) {
  const rows = /** @type {any[]} */ (
    db.prepare("SELECT job_id, source, theme, draft_json, draft_revision, state, created_at, updated_at FROM jobs ORDER BY updated_at DESC LIMIT ?").all(o.limit ?? 100)
  );
  return rows.map((r) => {
    const d = r.draft_json ? JSON.parse(r.draft_json) : null;
    return {
      jobId: r.job_id,
      source: r.source,
      theme: r.theme,
      kind: d?.kind ?? null,
      preview: d?.text ? String(d.text).slice(0, 80) : null,
      draftRevision: r.draft_revision,
      state: r.state,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

/** @param {Db} db @param {string} jobId */
function currentRow(db, jobId) {
  const r = /** @type {any} */ (db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId));
  if (!r) throw new NotFoundError();
  return r;
}

/** @param {Db} db @param {string} jobId */
function registeredPhotos(db, jobId) {
  return /** @type {any[]} */ (db.prepare("SELECT photo_id FROM job_photos WHERE job_id = ? ORDER BY created_at, rowid").all(jobId)).map((r) => /** @type {string} */ (r.photo_id));
}

/** @param {Db} db @param {string} jobId */
function registeredImages(db, jobId) {
  return /** @type {Array<{ slot: number, revision: number }>} */ (
    db.prepare("SELECT slot, revision FROM job_images WHERE job_id = ?").all(jobId)
  );
}

/**
 * 画面からの下書きの更新（版が一致するときだけ）。
 * @param {Db} db
 * @param {string} jobId
 * @param {unknown} draft
 * @param {{ expectedRevision: number }} o
 * @returns {{ draft: Draft, draftRevision: number }}
 */
export function updateDraft(db, jobId, draft, { expectedRevision }) {
  return withImmediateTx(db, () => {
    const r = currentRow(db, jobId);
    if (r.state !== "draft") throw new JobStateError("投稿を始めた下書きは直せません。「複製して直す」を使ってください。");
    if (r.draft_revision !== expectedRevision) throw new RevisionConflictError();
    const parsed = parseDraft(draft, { registeredImages: registeredImages(db, jobId), registeredPhotos: registeredPhotos(db, jobId) });
    if (!parsed.ok) throw new DraftInvalidError(parsed.issues);
    // 手で画像の指示（見出し・補足・絵柄）を変えた枠は、古い画像を外す（代替テキストだけの変更は外さない）
    const prev = /** @type {Draft | null} */ (r.draft_json ? JSON.parse(r.draft_json) : null);
    if (parsed.draft.images && prev?.images && prev.kind === parsed.draft.kind) {
      const prevBySlot = new Map(prev.images.map((i) => [i.slot, i]));
      parsed.draft.images = parsed.draft.images.map((img) => {
        const p = prevBySlot.get(img.slot);
        return p && img.revision !== null && planKey(p) !== planKey(img) ? { ...img, revision: null } : img;
      });
    }
    const next = r.draft_revision + 1;
    db.prepare("UPDATE jobs SET draft_json = ?, draft_revision = ?, updated_at = ? WHERE job_id = ?").run(
      JSON.stringify(parsed.draft),
      next,
      nowIso(),
      jobId,
    );
    return { draft: parsed.draft, draftRevision: next };
  });
}

/**
 * 複製して新しい下書きにする（画像の実体も複製する）。
 * @param {Db} db
 * @param {string} jobId
 * @param {{ dataRoot?: string }} [o]
 */
export function duplicateJob(db, jobId, o = {}) {
  const src = getJob(db, jobId);
  if (!src) throw new NotFoundError();
  const id = newId("j");
  const at = nowIso();
  withImmediateTx(db, () => {
    db.prepare(
      "INSERT INTO jobs (job_id, source, theme, brief_json, draft_json, draft_revision, state, copied_from_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 'draft', ?, ?, ?)",
    ).run(id, src.source, src.theme, JSON.stringify(src.brief), src.draft ? JSON.stringify(src.draft) : null, jobId, at, at);
    for (const img of src.images) {
      if (o.dataRoot) {
        const from = imagePath(o.dataRoot, jobId, img.slot, img.revision);
        const to = imagePath(o.dataRoot, id, img.slot, img.revision);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (fs.existsSync(from)) fs.copyFileSync(from, to);
      }
      db.prepare("INSERT INTO job_images (job_id, slot, revision, path, sha256, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id,
        img.slot,
        img.revision,
        o.dataRoot ? imagePath(o.dataRoot, id, img.slot, img.revision) : "",
        img.sha256,
        img.isCurrent ? 1 : 0,
        at,
      );
    }
  });
  return id;
}

/**
 * @param {Db} db
 * @param {string} jobId
 * @param {"user"|"assistant"} role
 * @param {string} text
 */
export function addChatMessage(db, jobId, role, text) {
  withImmediateTx(db, () => {
    const r = /** @type {any} */ (db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM chat_messages WHERE job_id = ?").get(jobId));
    db.prepare("INSERT INTO chat_messages (job_id, seq, role, text, created_at) VALUES (?, ?, ?, ?, ?)").run(
      jobId,
      r.m + 1,
      role,
      text,
      nowIso(),
    );
    db.prepare("UPDATE jobs SET updated_at = ? WHERE job_id = ?").run(nowIso(), jobId);
  });
}

/** @param {import("./validate.mjs").DraftImage} i */
const planKey = (i) =>
  JSON.stringify([i.headline ?? "", i.body ?? "", i.prompt ?? "", i.photoId ?? "", i.layout ?? "", i.tone ?? "", i.focus ?? ""]);

/**
 * Codex が出した投稿案を、決まった項目だけ取り出して下書きにする。
 * 利用者が決めたリンク・返信できる人は引き継ぎ、絵の指示が変わっていない画像の版は残す。
 * 生成を始めたときの版（expectedRevision）から下書きが変わっていたら、取り込まずに RevisionConflictError。
 * @param {Db} db
 * @param {string} jobId
 * @param {unknown} raw
 * @param {{ expectedRevision?: number }} [o]
 * @returns {Draft}
 */
export function adoptCodexDraft(db, jobId, raw, o = {}) {
  return withImmediateTx(db, () => {
    const r = currentRow(db, jobId);
    if (r.state !== "draft") throw new JobStateError("投稿を始めた下書きは書き換えられません。");
    if (o.expectedRevision !== undefined && r.draft_revision !== o.expectedRevision) throw new RevisionConflictError();
    const brief = /** @type {Brief} */ (JSON.parse(r.brief_json));
    const prev = /** @type {Draft | null} */ (r.draft_json ? JSON.parse(r.draft_json) : null);
    const d = normalizeCodexDraft(raw);
    // リンクは利用者が決めるもの。下書きがあれば今の下書き（削除も含む）、まだ無ければブリーフのものを使う
    if (prev) {
      if (prev.link) d.link = { ...prev.link };
    } else if (brief.link) d.link = { ...brief.link };
    if (prev?.replyControl) d.replyControl = prev.replyControl;
    if (brief.photoMode) {
      // 写真の下書き: 取り込んだ写真の順に枠を作る。文字は Codex の出力から photoId で（無ければ順番で）拾う。
      // 置き場所・色・切り抜きは、前の下書きで利用者が選んだものを引き継ぐ
      const photos = registeredPhotos(db, jobId);
      // Codex が形式を text と答えても、写真ごとの文字は拾う（形式は写真の枚数で決める）
      const raw0 = raw && typeof raw === "object" ? raw : {};
      const out = normalizeCodexDraft({ .../** @type {object} */ (raw0), kind: "carousel" }).images ?? [];
      const prevByPhoto = new Map((prev?.images ?? []).filter((i) => i.photoId).map((i) => [i.photoId, i]));
      const unmatched = out.filter((i) => !i.photoId || !photos.includes(i.photoId));
      let u = 0;
      d.images = photos.map((photoId, idx) => {
        const fromCodex = out.find((i) => i.photoId === photoId) ?? unmatched[u++] ?? {};
        const p = prevByPhoto.get(photoId);
        /** @type {import("./validate.mjs").DraftImage} */
        const img = {
          slot: idx + 1,
          revision: null,
          photoId,
          layout: p?.layout ?? "bottom",
          tone: p?.tone ?? "dark",
          focus: p?.focus ?? "center",
        };
        for (const k of /** @type {const} */ (["headline", "body", "altText"])) {
          const v = fromCodex[k];
          if (typeof v === "string" && v) img[k] = v;
        }
        return img;
      });
      d.kind = photos.length >= 2 ? "carousel" : "image";
      if (!photos.length) {
        d.kind = "text";
        delete d.images;
      }
    }
    if (d.images && prev?.images && prev.kind === d.kind) {
      const prevBySlot = new Map(prev.images.map((i) => [i.slot, i]));
      d.images = d.images.map((img) => {
        const p = prevBySlot.get(img.slot);
        return p && p.revision !== null && planKey(p) === planKey(img) ? { ...img, revision: p.revision } : img;
      });
    }
    const parsed = parseDraft(d, { registeredImages: registeredImages(db, jobId), registeredPhotos: registeredPhotos(db, jobId) });
    if (!parsed.ok) throw new DraftInvalidError(parsed.issues);
    db.prepare("UPDATE jobs SET draft_json = ?, draft_revision = draft_revision + 1, updated_at = ? WHERE job_id = ?").run(
      JSON.stringify(parsed.draft),
      nowIso(),
      jobId,
    );
    return parsed.draft;
  });
}

/**
 * 生成の作業フォルダの images/slide-NN.png を検査して取り込む。
 * 通常ファイル（シンボリックリンク不可）・作業フォルダの中・PNG として読める・大きさの上限、を満たすものだけ。
 * 書き込みは「一時ファイル → DB に登録 → 名前を変える」の順にし、途中で止まって残ったファイルの版は使わない。
 * @param {Db} db
 * @param {{ dataRoot: string, jobId: string, genDir: string, slots: number[], expectedRevision?: number }} o
 * @returns {Promise<{ adopted: Array<{ slot: number, revision: number }>, missing: number[], rejected: Array<{ slot: number, reason: string }> }>}
 */
export async function adoptImages(db, { dataRoot, jobId, genDir, slots, expectedRevision }) {
  const r = currentRow(db, jobId);
  if (r.state !== "draft") throw new JobStateError("投稿を始めた下書きの画像は差し替えられません。");
  const realGen = fs.realpathSync(genDir);
  /** @type {Array<{ slot: number, revision: number }>} */
  const adopted = [];
  /** @type {number[]} */
  const missing = [];
  /** @type {Array<{ slot: number, reason: string }>} */
  const rejected = [];
  /** @type {Array<{ slot: number, buf: Buffer }>} */
  const accepted = [];

  for (const slot of slots) {
    const p = path.join(genDir, "images", `slide-${String(slot).padStart(2, "0")}.png`);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      missing.push(slot);
      continue;
    }
    if (!st.isFile()) {
      rejected.push({ slot, reason: st.isSymbolicLink() ? "シンボリックリンクは使えません" : "通常のファイルではありません" });
      continue;
    }
    const real = fs.realpathSync(p);
    if (!real.startsWith(realGen + path.sep)) {
      rejected.push({ slot, reason: "作業フォルダの外のファイルです" });
      continue;
    }
    if (st.size > MAX_IMAGE_BYTES) {
      rejected.push({ slot, reason: "ファイルが大きすぎます" });
      continue;
    }
    const buf = fs.readFileSync(p);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
      rejected.push({ slot, reason: "PNG 画像ではありません" });
      continue;
    }
    const bad = await decodeProblem(buf);
    if (bad) {
      rejected.push({ slot, reason: bad });
      continue;
    }
    accepted.push({ slot, buf });
  }

  const r2 = registerImages(db, { dataRoot, jobId, items: accepted, expectedRevision });
  adopted.push(...r2);
  return { adopted, missing, rejected };
}

/**
 * 検査済みの画像（PNG のバッファ）を、各枠の新しい版として登録し、下書きの版を進める。
 * 「一時ファイル → DB に登録 → 名前を変える」の順にし、途中で止まって残ったファイルの版は飛ばす。
 * @param {Db} db
 * @param {{ dataRoot: string, jobId: string, items: Array<{ slot: number, buf: Buffer }>, expectedRevision?: number }} o
 * @returns {Array<{ slot: number, revision: number }>}
 */
export function registerImages(db, { dataRoot, jobId, items, expectedRevision }) {
  /** @type {Array<{ slot: number, revision: number }>} */
  const adopted = [];
  const dir = path.join(jobDir(dataRoot, jobId), "images");
  fs.mkdirSync(dir, { recursive: true });
  /** @type {Array<{ slot: number, buf: Buffer, tmp: string }>} */
  const staged = items.map((a) => {
    const tmp = path.join(dir, `.tmp-${crypto.randomBytes(6).toString("hex")}.png`);
    fs.writeFileSync(tmp, a.buf, { flag: "wx" });
    return { ...a, tmp };
  });
  try {
    withImmediateTx(db, () => {
      const row = currentRow(db, jobId);
      if (row.state !== "draft") throw new JobStateError("投稿を始めた下書きの画像は差し替えられません。");
      if (expectedRevision !== undefined && row.draft_revision !== expectedRevision) throw new RevisionConflictError();
      const draft = /** @type {Draft | null} */ (row.draft_json ? JSON.parse(row.draft_json) : null);
      for (const { slot, buf, tmp } of staged) {
        const m = /** @type {any} */ (db.prepare("SELECT COALESCE(MAX(revision), 0) AS m FROM job_images WHERE job_id = ? AND slot = ?").get(jobId, slot));
        let revision = m.m + 1;
        // 前に途中で止まって残ったファイルの版は飛ばす
        while (fs.existsSync(imagePath(dataRoot, jobId, slot, revision))) revision++;
        const dest = imagePath(dataRoot, jobId, slot, revision);
        const sha = crypto.createHash("sha256").update(buf).digest("hex");
        db.prepare("UPDATE job_images SET is_current = 0 WHERE job_id = ? AND slot = ?").run(jobId, slot);
        db.prepare("INSERT INTO job_images (job_id, slot, revision, path, sha256, is_current, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)").run(
          jobId,
          slot,
          revision,
          dest,
          sha,
          nowIso(),
        );
        fs.renameSync(tmp, dest);
        adopted.push({ slot, revision });
        if (draft?.images) {
          const target = draft.images.find((i) => i.slot === slot);
          if (target) target.revision = revision;
        }
      }
      if (draft && adopted.length) {
        db.prepare("UPDATE jobs SET draft_json = ?, draft_revision = draft_revision + 1, updated_at = ? WHERE job_id = ?").run(
          JSON.stringify(draft),
          nowIso(),
          jobId,
        );
      }
    });
  } finally {
    for (const { tmp } of staged) fs.rmSync(tmp, { force: true });
  }
  return adopted;
}

/**
 * PNG として最後まで読めるか（壊れた画像を完成扱いにしない）。問題があれば理由、無ければ null。
 * @param {Buffer} buf
 */
async function decodeProblem(buf) {
  try {
    const { default: sharp } = await import("sharp");
    const { info } = await sharp(buf, { limitInputPixels: 4096 * 4096 }).raw().toBuffer({ resolveWithObject: true });
    if (info.width < 1 || info.height < 1) return "画像の大きさが読めません";
    return null;
  } catch {
    return "画像として読めません（壊れています）";
  }
}

/**
 * 下書きを消す（DB の記録・取り込んだ画像・作業フォルダ）。保存した投稿パッケージは利用者のファイルなので残す。
 * 投稿を始めた仕事と、生成中の仕事は消せない。
 * @param {Db} db
 * @param {{ dataRoot: string, jobId: string }} o
 */
export function deleteJob(db, { dataRoot, jobId }) {
  const lease = acquireLease(db, `gen:${jobId}`, { purpose: "下書きの削除" });
  if ("busy" in lease) throw new LeaseBusyError(`gen:${jobId}`, lease.holder);
  try {
    withImmediateTx(db, () => {
      const r = currentRow(db, jobId);
      if (r.state !== "draft") throw new JobStateError("投稿を始めた下書きは消せません。");
      for (const t of ["chat_messages", "job_images", "job_photos", "generations", "job_events", "exports", "approvals"]) {
        db.prepare(`DELETE FROM ${t} WHERE job_id = ?`).run(jobId);
      }
      db.prepare("DELETE FROM jobs WHERE job_id = ?").run(jobId);
    });
    fs.rmSync(jobDir(dataRoot, jobId), { recursive: true, force: true });
    fs.rmSync(path.join(dataRoot, "work", jobId), { recursive: true, force: true });
  } finally {
    lease.release();
  }
}
