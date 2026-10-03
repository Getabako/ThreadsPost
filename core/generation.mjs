// @ts-check
// 生成の流れ: リースを取り → 生成ごとの作業フォルダで codex exec を 1 回動かし → 完了したときだけ取り込む。
// 計画: 方針 3・方針 10・方針 12（進み具合は job_events に書き、画面は DB から読む）

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { withLease, nowIso, addJobEvent, acquireLease } from "./db.mjs";
import { runCodexExec, CODEX_MODEL } from "./codex.mjs";
import { getJob, createJob, addChatMessage, adoptCodexDraft, adoptImages, assertSafeId, NotFoundError } from "./jobs.mjs";
import { loadDocs, characterRefs, buildOutlinePrompt, buildImagePrompt, buildAutoDraftPrompt, OUTLINE_SCHEMA } from "./prompts.mjs";
import { assertAllowed } from "./entitlement.mjs";
import { listPhotos, photoPath, renderPhotoSlotsUnlocked } from "./photos.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Db */
/** @typedef {import("./entitlement.mjs").Entitlement} Entitlement */
/** @typedef {import("./codex.mjs").ExecResult} ExecResult */
/** @typedef {(o: Parameters<typeof runCodexExec>[0]) => Promise<ExecResult>} ExecFn */
/**
 * @template R
 * @typedef {{ status: ExecResult["status"], genId: string, error: string | null, result: R | null }} GenOutcome
 */

export const OUTLINE_TIMEOUT_MS = 6 * 60_000;
export const IMAGE_TIMEOUT_MS = 25 * 60_000;

const PURPOSE_LABEL = { outline: "下書きづくり", images: "画像づくり", auto_draft: "無人の下書きづくり" };

/**
 * Codex の出来事を、画面に出す短い進み具合に変える。
 * @param {Db} db @param {string} jobId @param {any} ev
 */
function relayEvent(db, jobId, ev) {
  const it = ev.item;
  if (ev.type === "item.started" && it?.type === "command_execution") {
    const cmd = String(it.command ?? "").replace(/^\/bin\/zsh -lc /, "").slice(0, 140);
    addJobEvent(db, jobId, "step", `作業中: ${cmd}`);
  } else if (ev.type === "item.completed" && it?.type === "agent_message" && typeof it.text === "string" && !it.text.trim().startsWith("{")) {
    addJobEvent(db, jobId, "message", it.text.slice(0, 400));
  } else if (ev.type === "item.started" && it?.type === "reasoning") {
    addJobEvent(db, jobId, "thinking", "考えています…");
  }
}

/**
 * 生成 1 回分。gen:<jobId> のリースを取り、作業フォルダを作り、codex exec を動かし、
 * 完了してリースをまだ持っているときだけ adopt を呼ぶ。
 * @template R
 * @param {{
 *   db: Db, dataRoot: string, jobId: string, purpose: "outline"|"images"|"auto_draft",
 *   build: (genDir: string) => { prompt: string, sandbox: "read-only"|"workspace-write", outputSchema?: object, images?: string[] },
 *   adopt: (genDir: string, r: ExecResult) => R | Promise<R>,
 *   exec?: ExecFn, timeoutMs: number, signal?: AbortSignal
 * }} o
 * @returns {Promise<GenOutcome<R>>}
 */
export async function runGeneration(o) {
  assertSafeId(o.jobId);
  const exec = o.exec ?? runCodexExec;
  return withLease(o.db, `gen:${o.jobId}`, PURPOSE_LABEL[o.purpose], async (lease) => {
    const genId = "g" + crypto.randomBytes(6).toString("hex");
    const genDir = path.join(o.dataRoot, "work", o.jobId, `gen-${genId}`);
    fs.mkdirSync(path.join(genDir, ".tmp"), { recursive: true });
    o.db.prepare("INSERT INTO generations (gen_id, job_id, purpose, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(genId, o.jobId, o.purpose, nowIso());
    addJobEvent(o.db, o.jobId, "start", `${PURPOSE_LABEL[o.purpose]}を始めました（${CODEX_MODEL}）`);

    /** @param {ExecResult["status"]} status @param {string | null} detail */
    const end = (status, detail) => {
      o.db.prepare("UPDATE generations SET status = ?, detail = ?, ended_at = ? WHERE gen_id = ?").run(status, detail, nowIso(), genId);
    };

    try {
      const b = o.build(genDir);
      let outputSchemaPath;
      if (b.outputSchema) {
        outputSchemaPath = path.join(o.dataRoot, "work", o.jobId, `schema-${genId}.json`);
        fs.writeFileSync(outputSchemaPath, JSON.stringify(b.outputSchema));
      }
      const r = await exec({
        cwd: genDir,
        prompt: b.prompt,
        sandbox: b.sandbox,
        outputSchemaPath,
        images: b.images,
        timeoutMs: o.timeoutMs,
        signal: o.signal,
        onEvent: (ev) => relayEvent(o.db, o.jobId, ev),
      });
      if (r.status !== "completed") {
        end(r.status, r.error);
        addJobEvent(o.db, o.jobId, "error", `${PURPOSE_LABEL[o.purpose]}が終わりませんでした: ${r.error ?? r.status}`);
        return { status: r.status, genId, error: r.error, result: null };
      }
      lease.assertHeld();
      const result = await o.adopt(genDir, r);
      end("completed", null);
      addJobEvent(o.db, o.jobId, "done", `${PURPOSE_LABEL[o.purpose]}が終わりました`);
      return { status: "completed", genId, error: null, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      end("failed", msg);
      addJobEvent(o.db, o.jobId, "error", `${PURPOSE_LABEL[o.purpose]}に失敗しました: ${msg}`);
      return { status: "failed", genId, error: msg, result: null };
    }
  });
}

/**
 * Codex の最終応答（JSON）を読む。
 * @param {string | null} text
 * @returns {{ reply: string, draft: any }}
 */
export function parseFinalJson(text) {
  if (!text) throw new Error("Codex の応答が空でした");
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    throw new Error("Codex の応答が JSON ではありませんでした");
  }
  if (!v || typeof v !== "object" || typeof v.draft !== "object") throw new Error("Codex の応答に下書きがありませんでした");
  return { reply: typeof v.reply === "string" ? v.reply : "", draft: v.draft };
}

/**
 * フリー版で作れない形式ならテキストに直し、使えない自分への返信文を外す。
 * @param {any} draft @param {Entitlement} ent
 */
function fitToEntitlement(draft, ent) {
  let d = draft && typeof draft === "object" ? { ...draft } : draft;
  if (d && !ent.limits.kinds.includes(d.kind)) d = { ...d, kind: "text", images: [] };
  if (d && !ent.limits.selfReply) delete d.selfReplyText;
  return d;
}

/**
 * 構成チャット 1 往復。下書き全体を作り直して取り込み、会話に記録する。
 * @param {{ db: Db, dataRoot: string, appRoot: string, jobId: string, userMessage: string | null, entitlement: Entitlement, exec?: ExecFn, timeoutMs?: number, signal?: AbortSignal }} o
 */
export async function runOutline(o) {
  if (!getJob(o.db, o.jobId)) throw new NotFoundError();
  /** @type {number} 生成を始めたときの下書きの版（取り込むときに変わっていないことを確かめる） */
  let startRevision = 0;
  return runGeneration({
    db: o.db,
    dataRoot: o.dataRoot,
    jobId: o.jobId,
    purpose: "outline",
    exec: o.exec,
    timeoutMs: o.timeoutMs ?? OUTLINE_TIMEOUT_MS,
    signal: o.signal,
    // リースを取った後で読む（生成の入力と、ほかの保存が混ざらないように）
    build: () => {
      const job = /** @type {import("./jobs.mjs").Job} */ (getJob(o.db, o.jobId));
      // 今回の依頼より前の会話だけを履歴として渡す（今回の依頼は userMessage として別に渡す）
      const history = job.chat;
      if (o.userMessage?.trim()) addChatMessage(o.db, o.jobId, "user", o.userMessage.trim());
      startRevision = job.draftRevision;
      const photos = job.brief.photoMode ? listPhotos(o.db, o.jobId) : [];
      return {
        sandbox: "read-only",
        outputSchema: OUTLINE_SCHEMA,
        // 利用者の写真は添付して見せる（写真は加工しない。文字はあとで別の仕組みで重ねる）
        images: photos.map((p) => photoPath(o.dataRoot, o.jobId, p.photoId)),
        prompt: buildOutlinePrompt({
          photos,
          brief: job.brief,
          docs: loadDocs({ appRoot: o.appRoot }),
          history,
          currentDraft: job.draft,
          userMessage: o.userMessage,
          limits: o.entitlement.limits,
          premiumPrompt: o.entitlement.premiumPrompt,
        }),
      };
    },
    adopt: async (_dir, r) => {
      const { reply, draft } = parseFinalJson(r.lastMessage);
      const adopted = adoptCodexDraft(o.db, o.jobId, fitToEntitlement(draft, o.entitlement), { expectedRevision: startRevision });
      addChatMessage(o.db, o.jobId, "assistant", reply || "下書きを更新しました");
      // 写真の枠は、その場で文字を重ねる（数秒。Codex は使わない）
      if (adopted.images?.some((i) => i.photoId && i.revision === null)) {
        const pr = await renderPhotoSlotsUnlocked(o.db, { dataRoot: o.dataRoot, jobId: o.jobId, slots: null });
        for (const e of pr.errors) addJobEvent(o.db, o.jobId, "warn", `${e.slot} 枚目: ${e.reason}`);
      }
      return adopted;
    },
  });
}

/**
 * 画像を作る（slots が null なら、まだ画像の無い枠すべて）。
 * @param {{ db: Db, dataRoot: string, appRoot: string, jobId: string, slots: number[] | null, entitlement: Entitlement, exec?: ExecFn, timeoutMs?: number, signal?: AbortSignal }} o
 */
export async function runImages(o) {
  assertAllowed(o.entitlement, "generate_images");
  const job = getJob(o.db, o.jobId);
  if (!job) throw new NotFoundError();
  const draft = job.draft;
  if (!draft || draft.kind === "text" || !draft.images?.length) throw new Error("画像を使う下書きではありません。先に構成を作ってください。");
  /** AI が描く枠だけ（写真の枠は「文字を入れ直す」で作る） @param {import("./validate.mjs").Draft} d */
  const pickSlots = (d) => {
    const ai = (d.images ?? []).filter((i) => !i.photoId);
    const all = ai.map((i) => i.slot);
    return o.slots ? o.slots.filter((s) => all.includes(s)) : ai.filter((i) => i.revision === null).map((i) => i.slot);
  };
  if (!pickSlots(draft).length) {
    if (draft.images.some((i) => i.photoId)) throw new Error("写真の枠は AI では作りません。「文字を入れ直す」で作ってください。");
    throw new Error("作る画像がありません（すべて作成済みです）。作り直す画像を選んでください。");
  }
  let startRevision = 0;
  /** @type {number[]} */
  let slots = [];
  return runGeneration({
    db: o.db,
    dataRoot: o.dataRoot,
    jobId: o.jobId,
    purpose: "images",
    exec: o.exec,
    timeoutMs: o.timeoutMs ?? IMAGE_TIMEOUT_MS,
    signal: o.signal,
    // リースを取った後で読み直す
    build: () => {
      const job = /** @type {import("./jobs.mjs").Job} */ (getJob(o.db, o.jobId));
      const d = /** @type {import("./validate.mjs").Draft} */ (job.draft);
      startRevision = job.draftRevision;
      slots = pickSlots(d);
      if (!slots.length) throw new Error("作る画像がありません");
      return {
        sandbox: "workspace-write",
        prompt: buildImagePrompt({ draft: d, slots, docs: loadDocs({ appRoot: o.appRoot }), characterRefs: characterRefs({ appRoot: o.appRoot }) }),
      };
    },
    adopt: async (genDir) => {
      const r = await adoptImages(o.db, { dataRoot: o.dataRoot, jobId: o.jobId, genDir, slots, expectedRevision: startRevision });
      if (r.missing.length || r.rejected.length) {
        addJobEvent(
          o.db,
          o.jobId,
          "warn",
          [r.missing.length ? `できなかった画像: ${r.missing.join(", ")} 枚目` : "", ...r.rejected.map((x) => `${x.slot} 枚目: ${x.reason}`)].filter(Boolean).join(" / "),
        );
      }
      return r;
    },
  });
}

/**
 * 無人の下書き作成（CLI）。仕事を作り、本文と画像を 1 回の生成で作って取り込む。投稿はしない。
 * jobId を渡すと、その仕事（呼び出し側が予約したもの）に作る。
 * @param {{ db: Db, dataRoot: string, appRoot: string, theme: string, kind: "text"|"image"|"carousel", slideCount?: number, recentOpenings?: string[], entitlement: Entitlement, exec?: ExecFn, timeoutMs?: number, signal?: AbortSignal, jobId?: string }} o
 * @returns {Promise<GenOutcome<any> & { jobId: string }>}
 */
export async function runAutoDraft(o) {
  if (o.kind !== "text") assertAllowed(o.entitlement, "generate_images");
  const jobId = o.jobId ?? createJob(o.db, { brief: { theme: o.theme, kind: o.kind, slideCount: o.slideCount }, source: "cli" });
  const out = await runGeneration({
    db: o.db,
    dataRoot: o.dataRoot,
    jobId,
    purpose: "auto_draft",
    exec: o.exec,
    timeoutMs: o.timeoutMs ?? IMAGE_TIMEOUT_MS,
    signal: o.signal,
    build: () => ({
      sandbox: o.kind === "text" ? "read-only" : "workspace-write",
      outputSchema: OUTLINE_SCHEMA,
      prompt: buildAutoDraftPrompt({
        theme: o.theme,
        kind: o.kind,
        slideCount: o.slideCount,
        docs: loadDocs({ appRoot: o.appRoot }),
        characterRefs: o.kind === "text" ? [] : characterRefs({ appRoot: o.appRoot }),
        recentOpenings: o.recentOpenings ?? [],
        premiumPrompt: o.entitlement.premiumPrompt,
      }),
    }),
    adopt: async (genDir, r) => {
      const { draft } = parseFinalJson(r.lastMessage);
      const adopted = adoptCodexDraft(o.db, jobId, fitToEntitlement(draft, o.entitlement));
      const slots = (adopted.images ?? []).map((i) => i.slot);
      const images = slots.length ? await adoptImages(o.db, { dataRoot: o.dataRoot, jobId, genDir, slots }) : null;
      return { draft: adopted, images };
    },
  });
  return { ...out, jobId };
}

/**
 * 起動時: running のままで、リースが生きていない生成を interrupted にする。
 * @param {Db} db
 * @returns {number} 直した件数
 */
export function recoverGenerations(db) {
  const rows = /** @type {any[]} */ (db.prepare("SELECT gen_id, job_id FROM generations WHERE status = 'running'").all());
  let n = 0;
  for (const r of rows) {
    const probe = acquireLease(db, `gen:${r.job_id}`, { purpose: "起動時の確認" });
    if ("busy" in probe) continue;
    probe.release();
    db.prepare("UPDATE generations SET status = 'interrupted', detail = '前回の起動中に止まりました', ended_at = ? WHERE gen_id = ?").run(nowIso(), r.gen_id);
    n++;
  }
  return n;
}

/**
 * この仕事の生成が（どのプロセスでも）走っているか。generations が running で、gen リースが残っているとき。
 * @param {Db} db
 * @param {string} jobId
 */
export function isGenerating(db, jobId) {
  const g = db.prepare("SELECT 1 FROM generations WHERE job_id = ? AND status = 'running' LIMIT 1").get(jobId);
  if (!g) return false;
  return !!db.prepare("SELECT 1 FROM leases WHERE name = ?").get(`gen:${jobId}`);
}
