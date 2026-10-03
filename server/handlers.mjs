// @ts-check
// API の処理本体。app/api/**/route.ts はこれを呼ぶだけにする（テストから直接呼べるように）。
// 計画: Task 17・18（下書きまでの範囲）。投稿（preflight・publish）は第一段階の後半で足す。

import fs from "node:fs";
import path from "node:path";
import { checkRead, checkWrite, sessionResponse } from "./local-auth.mjs";
import { LeaseBusyError, acquireLease } from "../core/db.mjs";
import {
  createJob,
  getJob,
  listJobs,
  updateDraft,
  duplicateJob,
  assertSafeId,
  jobDir,
  JobStateError,
  RevisionConflictError,
  DraftInvalidError,
  NotFoundError,
} from "../core/jobs.mjs";
import { runOutline, runImages, isGenerating } from "../core/generation.mjs";
import { buildFinalPayload, validateFinalPayload, draftReadiness, CAROUSEL_MIN, CAROUSEL_MAX } from "../core/validate.mjs";
import { countThreadsChars, countLinks } from "../core/count.mjs";
import { EntitlementError } from "../core/entitlement.mjs";
import { CODEX_MODEL } from "../core/codex.mjs";
import { buildPackage, getExport, zipPackage, PackageNotReadyError } from "../core/export.mjs";
import { deleteJob } from "../core/jobs.mjs";
import { importPhoto, listPhotos, photoPath, renderPhotos, PhotoError, MAX_PHOTO_BYTES } from "../core/photos.mjs";

/**
 * @typedef {{
 *   db: import("node:sqlite").DatabaseSync, dataRoot: string, appRoot: string, sessionToken: string, port?: string,
 *   resolveEntitlement: () => Promise<import("../core/entitlement.mjs").Entitlement>,
 *   activate: (email: string) => Promise<{ activated: boolean, message: string }>,
 *   codexStatus: () => Promise<{ loggedIn: boolean, detail: string }>,
 *   exec?: import("../core/generation.mjs").ExecFn,
 *   running: Map<string, AbortController>,
 *   exportRoot: string,
 *   openPath: (p: string) => void
 * }} Ctx
 */

/** @param {unknown} body @param {number} [status] */
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** @param {string} message @param {number} status @param {object} [extra] */
const fail = (message, status, extra = {}) => json({ error: message, ...extra }, status);

/** @param {Request} req */
async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** 例外を HTTP の応答に変える @param {unknown} e */
function toResponse(e) {
  if (e instanceof NotFoundError) return fail("見つかりません", 404);
  if (e instanceof RevisionConflictError) return fail(e.message, 409, { code: "revision_conflict" });
  if (e instanceof JobStateError) return fail(e.message, 409, { code: "frozen" });
  if (e instanceof DraftInvalidError) return fail(e.message, 400, { code: "invalid_draft", issues: e.issues });
  if (e instanceof LeaseBusyError) return fail(e.message, 409, { code: "busy" });
  if (e instanceof EntitlementError) return fail(e.message, 403, { code: "entitlement" });
  if (e instanceof PackageNotReadyError) return fail(e.message, 400, { code: "not_ready", issues: e.issues });
  if (e instanceof PhotoError) return fail(e.message, 400, { code: "photo" });
  const msg = e instanceof Error ? e.message : String(e);
  return fail(msg, 500);
}

/** @param {string} id */
function safeJobId(id) {
  try {
    assertSafeId(id);
    return true;
  } catch {
    return false;
  }
}

// ---- セッション・状態 -------------------------------------------------------

/** @param {Request} req @param {Ctx} ctx */
export async function session(req, ctx) {
  return sessionResponse(req, { sessionToken: ctx.sessionToken, port: ctx.port });
}

/** @param {Request} req @param {Ctx} ctx */
export async function status(req, ctx) {
  const deny = checkRead(req, ctx);
  if (deny) return deny;
  const [ent, codex] = await Promise.all([ctx.resolveEntitlement(), ctx.codexStatus()]);
  return json({
    entitlement: { mode: ent.mode, message: ent.message, kinds: ent.limits.kinds, credit: ent.limits.credit },
    codex,
    model: CODEX_MODEL,
    stage: "draft",
  });
}

/** @param {Request} req @param {Ctx} ctx */
export async function activate(req, ctx) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  const body = await readJson(req);
  const r = await ctx.activate(String(body?.email ?? ""));
  return json(r, r.activated ? 200 : 400);
}

// ---- 仕事 -------------------------------------------------------------------

/**
 * ブリーフの検査
 * @param {any} b
 * @returns {{ ok: true, brief: import("../core/jobs.mjs").Brief } | { ok: false, message: string }}
 */
export function parseBrief(b) {
  if (!b || typeof b !== "object") return { ok: false, message: "ブリーフがありません" };
  const theme = typeof b.theme === "string" ? b.theme.trim() : "";
  if (!theme) return { ok: false, message: "テーマを入れてください" };
  if (theme.length > 400) return { ok: false, message: "テーマは 400 字以内にしてください" };
  const kind = b.kind ?? "text";
  if (!["text", "image", "carousel"].includes(kind)) return { ok: false, message: "形式が正しくありません" };
  const slideCount = kind === "carousel" ? Number(b.slideCount ?? 5) : undefined;
  if (slideCount !== undefined && (!Number.isInteger(slideCount) || slideCount < CAROUSEL_MIN || slideCount > CAROUSEL_MAX)) {
    return { ok: false, message: `カルーセルは ${CAROUSEL_MIN}〜${CAROUSEL_MAX} 枚です` };
  }
  /** @type {import("../core/jobs.mjs").Brief} */
  const brief = { theme, kind, slideCount };
  // 自分の写真を使う下書き（形式は取り込んだ写真の枚数で決まる）
  if (b.photoMode === true) {
    brief.photoMode = true;
    brief.kind = "image";
    delete brief.slideCount;
  }
  for (const k of /** @type {const} */ (["audience", "tone", "topicTagHint", "notes"])) {
    if (typeof b[k] === "string" && b[k].trim()) brief[k] = b[k].trim().slice(0, 1000);
  }
  if (b.link) {
    let ok = false;
    try {
      const u = new URL(String(b.link.url));
      ok = (u.protocol === "https:" || u.protocol === "http:") && (b.link.place === "body" || b.link.place === "reply");
    } catch {
      ok = false;
    }
    if (!ok) return { ok: false, message: "リンクは http(s) の URL と置き場所（本文／返信）を指定してください" };
    brief.link = { url: String(b.link.url), place: b.link.place };
  }
  return { ok: true, brief };
}

/** @param {Request} req @param {Ctx} ctx */
export async function jobsList(req, ctx) {
  const deny = checkRead(req, ctx);
  if (deny) return deny;
  return json({ jobs: listJobs(ctx.db, { limit: 100 }) });
}

/** @param {Request} req @param {Ctx} ctx */
export async function jobsCreate(req, ctx) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  const body = await readJson(req);
  const p = parseBrief(body?.brief);
  if (!p.ok) return fail(p.message, 400);
  const ent = await ctx.resolveEntitlement();
  if (p.brief.kind && p.brief.kind !== "text" && !ent.limits.kinds.includes(p.brief.kind)) {
    return fail("画像・カルーセルはアシュラ会員限定です。テキストで作るか、会員認証してください。", 403, { code: "entitlement" });
  }
  const jobId = createJob(ctx.db, { brief: p.brief, source: "ui" });
  return json({ jobId }, 201);
}

/**
 * 下書きの今の状態と、送る予定の内容・検査結果を返す。
 * @param {Ctx} ctx @param {string} jobId
 */
async function jobView(ctx, jobId) {
  const job = getJob(ctx.db, jobId);
  if (!job) throw new NotFoundError();
  const ent = await ctx.resolveEntitlement();
  const gen = /** @type {any} */ (
    ctx.db.prepare("SELECT gen_id, purpose, status, detail, started_at, ended_at FROM generations WHERE job_id = ? ORDER BY started_at DESC LIMIT 1").get(jobId)
  );
  const lastEvent = /** @type {any} */ (ctx.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM job_events WHERE job_id = ?").get(jobId));
  let final = null;
  /** @type {import("../core/validate.mjs").ValidationIssue[]} */
  let issues = [];
  /** @type {import("../core/validate.mjs").ValidationIssue[]} */
  let readiness = [];
  let counts = null;
  if (job.draft) {
    final = buildFinalPayload(job.draft, { credit: ent.limits.credit, allowUserReply: ent.limits.selfReply });
    issues = validateFinalPayload(final);
    readiness = draftReadiness(job.draft);
    counts = {
      main: countThreadsChars(final.main.text),
      mainLinks: countLinks(final.main.text),
      reply: final.reply ? countThreadsChars(final.reply.text) : 0,
      replyLinks: final.reply ? countLinks(final.reply.text) : 0,
    };
  }
  return {
    job,
    final,
    issues,
    readiness,
    counts,
    generation: gen ?? null,
    running: ctx.running.has(jobId) || isGenerating(ctx.db, jobId),
    lastEventId: lastEvent.id,
    export: getExport(ctx.db, jobId),
    photos: listPhotos(ctx.db, jobId),
  };
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobGet(req, ctx, jobId) {
  const deny = checkRead(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  try {
    return json(await jobView(ctx, jobId));
  } catch (e) {
    return toResponse(e);
  }
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobPut(req, ctx, jobId) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  const body = await readJson(req);
  if (!body || typeof body.expectedRevision !== "number") return fail("下書きの版がありません", 400);
  const ent = await ctx.resolveEntitlement();
  if (body.draft?.kind && !ent.limits.kinds.includes(body.draft.kind)) {
    return fail("画像・カルーセルはアシュラ会員限定です。", 403, { code: "entitlement" });
  }
  // 保存は生成と同じリースで排他する（ほかのプロセスの生成中も含めて、生成結果と保存が混ざらないように）
  const lease = acquireLease(ctx.db, `gen:${jobId}`, { purpose: "下書きの保存" });
  if ("busy" in lease) return fail("生成中は直せません。終わるまで待ってください。", 409, { code: "busy" });
  try {
    updateDraft(ctx.db, jobId, body.draft, { expectedRevision: body.expectedRevision });
  } catch (e) {
    return toResponse(e);
  } finally {
    lease.release();
  }
  try {
    return json(await jobView(ctx, jobId));
  } catch (e) {
    return toResponse(e);
  }
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobDuplicate(req, ctx, jobId) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  try {
    return json({ jobId: duplicateJob(ctx.db, jobId, { dataRoot: ctx.dataRoot }) }, 201);
  } catch (e) {
    return toResponse(e);
  }
}

/**
 * 生成を裏で始める。すぐ失敗するもの（実行中・会員限定）は 409/403 で返し、始まったら 202。
 * @param {Ctx} ctx @param {string} jobId
 * @param {(signal: AbortSignal) => Promise<unknown>} start
 */
async function startInBackground(ctx, jobId, start) {
  if (ctx.running.has(jobId)) return fail("この下書きは生成中です。終わるまで待ってください。", 409, { code: "busy" });
  const ac = new AbortController();
  ctx.running.set(jobId, ac);
  const p = start(ac.signal).finally(() => {
    if (ctx.running.get(jobId) === ac) ctx.running.delete(jobId);
  });
  const early = await Promise.race([
    p.then(
      () => /** @type {const} */ ("done"),
      (e) => e,
    ),
    new Promise((r) => setTimeout(() => r("running"), 150)),
  ]);
  if (early !== "running" && early !== "done") return toResponse(early);
  p.catch(() => {});
  return json({ started: true }, 202);
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobOutline(req, ctx, jobId) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  if (!getJob(ctx.db, jobId)) return fail("見つかりません", 404);
  const body = await readJson(req);
  const message = typeof body?.message === "string" ? body.message.slice(0, 4000) : null;
  const ent = await ctx.resolveEntitlement();
  return startInBackground(ctx, jobId, (signal) =>
    runOutline({ db: ctx.db, dataRoot: ctx.dataRoot, appRoot: ctx.appRoot, jobId, userMessage: message, entitlement: ent, exec: ctx.exec, signal }),
  );
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobImages(req, ctx, jobId) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  if (!getJob(ctx.db, jobId)) return fail("見つかりません", 404);
  const body = await readJson(req);
  const slots = Array.isArray(body?.slots) ? body.slots.filter((/** @type {unknown} */ s) => Number.isInteger(s)) : null;
  const ent = await ctx.resolveEntitlement();
  return startInBackground(ctx, jobId, (signal) =>
    runImages({ db: ctx.db, dataRoot: ctx.dataRoot, appRoot: ctx.appRoot, jobId, slots, entitlement: ent, exec: ctx.exec, signal }),
  );
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobCancel(req, ctx, jobId) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  const ac = ctx.running.get(jobId);
  if (!ac) return json({ cancelled: false });
  ac.abort();
  return json({ cancelled: true });
}

/**
 * 進み具合の SSE。job_events を 1 秒ごとに読んで送る（どのプロセスが書いても届く）。
 * @param {Request} req @param {Ctx} ctx @param {string} jobId
 */
export async function jobEvents(req, ctx, jobId) {
  const deny = checkRead(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  let after = Number(new URL(req.url).searchParams.get("after") ?? "0") || 0;
  const enc = new TextEncoder();
  const stmt = ctx.db.prepare("SELECT id, at, kind, message FROM job_events WHERE job_id = ? AND id > ? ORDER BY id LIMIT 200");
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* noop */
        }
      };
      const tick = () => {
        if (closed) return;
        try {
          const rows = /** @type {any[]} */ (stmt.all(jobId, after));
          let chunk = "";
          for (const r of rows) {
            after = r.id;
            chunk += `id: ${r.id}\nevent: job\ndata: ${JSON.stringify(r)}\n\n`;
          }
          chunk += `event: state\ndata: ${JSON.stringify({ running: ctx.running.has(jobId) || isGenerating(ctx.db, jobId) })}\n\n`;
          controller.enqueue(enc.encode(chunk));
        } catch {
          close();
        }
      };
      tick();
      timer = setInterval(tick, 1000);
      req.signal.addEventListener("abort", close);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}

// ---- 画像の配信 -------------------------------------------------------------

/** @param {Request} req @param {Ctx} ctx @param {string} jobId @param {string} slotS @param {string} revS */
export async function media(req, ctx, jobId, slotS, revS) {
  const deny = checkRead(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId) || !/^\d{1,2}$/.test(slotS) || !/^\d{1,3}$/.test(revS)) return fail("見つかりません", 404);
  const row = /** @type {any} */ (
    ctx.db.prepare("SELECT path FROM job_images WHERE job_id = ? AND slot = ? AND revision = ?").get(jobId, Number(slotS), Number(revS))
  );
  if (!row?.path) return fail("見つかりません", 404);
  try {
    const st = fs.lstatSync(row.path);
    if (!st.isFile()) return fail("見つかりません", 404);
    const base = fs.realpathSync(path.join(jobDir(ctx.dataRoot, jobId), "images"));
    const real = fs.realpathSync(row.path);
    if (!real.startsWith(base + path.sep)) return fail("見つかりません", 404);
    const data = fs.readFileSync(real);
    return new Response(data, {
      headers: {
        "content-type": "image/png",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return fail("見つかりません", 404);
  }
}

// ---- 投稿パッケージ（ローカル保存）と削除 ---------------------------------------

/** 保存先の中にある、この仕事のパッケージのフォルダ（それ以外は null） @param {Ctx} ctx @param {string} jobId */
function exportDirOf(ctx, jobId) {
  const e = getExport(ctx.db, jobId);
  if (!e) return null;
  try {
    const root = fs.realpathSync(ctx.exportRoot);
    const real = fs.realpathSync(e.dir);
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobExport(req, ctx, jobId) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  try {
    const ent = await ctx.resolveEntitlement();
    const r = await buildPackage({ db: ctx.db, dataRoot: ctx.dataRoot, exportRoot: ctx.exportRoot, jobId, entitlement: ent });
    return json({ export: getExport(ctx.db, jobId), dir: r.dir });
  } catch (e) {
    return toResponse(e);
  }
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobExportZip(req, ctx, jobId) {
  const deny = checkRead(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  const dir = exportDirOf(ctx, jobId);
  if (!dir) return fail("まだ保存していません", 404);
  try {
    const buf = await zipPackage(dir);
    const name = encodeURIComponent(path.basename(dir) + ".zip");
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="threads-${jobId}.zip"; filename*=UTF-8''${name}`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return toResponse(e);
  }
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobOpenFolder(req, ctx, jobId) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  const dir = exportDirOf(ctx, jobId);
  if (!dir) return fail("まだ保存していません", 404);
  ctx.openPath(dir);
  return json({ opened: true });
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobDelete(req, ctx, jobId) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  if (ctx.running.has(jobId)) return fail("生成中は消せません。止めてから消してください。", 409, { code: "busy" });
  try {
    deleteJob(ctx.db, { dataRoot: ctx.dataRoot, jobId });
    return json({ deleted: true });
  } catch (e) {
    return toResponse(e);
  }
}

// ---- 写真（取り込み・表示・文字入れ）-----------------------------------------

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobPhotoUpload(req, ctx, jobId) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_PHOTO_BYTES) return fail("写真が大きすぎます（25MB まで）", 413);
  try {
    const buf = Buffer.from(await req.arrayBuffer());
    const photo = await importPhoto(ctx.db, { dataRoot: ctx.dataRoot, jobId, buffer: buf });
    return json({ photo }, 201);
  } catch (e) {
    return toResponse(e);
  }
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId @param {string} photoId */
export async function jobPhoto(req, ctx, jobId, photoId) {
  const deny = checkRead(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId) || !/^p[0-9a-f]{12}$/.test(photoId)) return fail("見つかりません", 404);
  const row = ctx.db.prepare("SELECT 1 FROM job_photos WHERE job_id = ? AND photo_id = ?").get(jobId, photoId);
  if (!row) return fail("見つかりません", 404);
  try {
    const p = photoPath(ctx.dataRoot, jobId, photoId);
    const st = fs.lstatSync(p);
    if (!st.isFile()) return fail("見つかりません", 404);
    return new Response(new Uint8Array(fs.readFileSync(p)), {
      headers: { "content-type": "image/jpeg", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'", "cache-control": "private, max-age=31536000, immutable" },
    });
  } catch {
    return fail("見つかりません", 404);
  }
}

/** @param {Request} req @param {Ctx} ctx @param {string} jobId */
export async function jobRender(req, ctx, jobId) {
  const deny = checkWrite(req, ctx);
  if (deny) return deny;
  if (!safeJobId(jobId)) return fail("見つかりません", 404);
  if (ctx.running.has(jobId)) return fail("生成中です。終わってから文字を入れ直してください。", 409, { code: "busy" });
  const body = await readJson(req);
  const slots = Array.isArray(body?.slots) ? body.slots.filter((/** @type {unknown} */ s) => Number.isInteger(s)) : null;
  try {
    const r = await renderPhotos(ctx.db, { dataRoot: ctx.dataRoot, jobId, slots });
    return json(r);
  } catch (e) {
    return toResponse(e);
  }
}
