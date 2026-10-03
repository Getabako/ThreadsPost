// @ts-check
// 無人実行（下書きまで）。scripts/auto-post.mjs から呼ぶ。テストのため依存はすべて差し替えられる。
// 計画: データフロー「無人投稿（CLI）」・Task 27。投稿（--publish）は第一段階の後半で足す。

import { addAlert, acquireLease } from "./db.mjs";
import { assertAllowed, EntitlementError } from "./entitlement.mjs";
import { runAutoDraft, recoverGenerations } from "./generation.mjs";
import { getJob, createJob } from "./jobs.mjs";
import { buildFinalPayload, validateFinalPayload, draftReadiness } from "./validate.mjs";
import { buildPackage } from "./export.mjs";
import { checkDuplicate, openingOf, pickTheme } from "./history.mjs";

export const EXIT = /** @type {const} */ ({ OK: 0, ERROR: 1, UNSUPPORTED: 2, GUARD: 10, NEEDS_HUMAN: 11, BUSY: 12 });

const DEFAULT_THRESHOLD = 0.5;
const THEME_LOOKBACK = 20;
const DUPLICATE_LOOKBACK = 60;

/**
 * @param {string[]} argv
 * @returns {{ publish: boolean, theme: string | null, kind: "text"|"image"|"carousel" | null, slides: number | null, jitter: number }}
 */
export function parseArgs(argv) {
  /** @param {string} name */
  const val = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const kind = val("kind");
  return {
    publish: argv.includes("--publish"),
    theme: val("theme"),
    kind: kind === "text" || kind === "image" || kind === "carousel" ? kind : null,
    slides: val("slides") ? Number(val("slides")) : null,
    jitter: val("jitter") ? Math.max(0, Number(val("jitter")) || 0) : 0,
  };
}

/**
 * @typedef {{
 *   db: import("node:sqlite").DatabaseSync, dataRoot: string, appRoot: string,
 *   resolveEntitlement: () => Promise<import("./entitlement.mjs").Entitlement>,
 *   exec?: import("./generation.mjs").ExecFn,
 *   notify: (message: string) => void, sleep: (ms: number) => Promise<void>, random: () => number, now: () => Date,
 *   themes: string[], log: (m: string) => void, onPlannedKind?: (k: string) => void, similarityThreshold?: number,
 *   exportRoot: string
 * }} AutoDeps
 */

/**
 * @param {string[]} argv
 * @param {AutoDeps} d
 * @returns {Promise<number>} 終了コード
 */
export async function runAuto(argv, d) {
  const args = parseArgs(argv);
  recoverGenerations(d.db);

  /** @param {"warn"|"error"} level @param {string} code @param {string} message @param {string | null} [jobId] */
  const stop = (level, code, message, jobId = null) => {
    addAlert(d.db, { level, code, message, jobId });
    d.notify(message);
    d.log(`✗ ${message}`);
  };

  if (args.publish) {
    d.log("✗ 投稿（--publish）は第一段階の後半で対応します。今は下書きだけ作れます（--publish を外して実行してください）。");
    return EXIT.UNSUPPORTED;
  }

  const ent = await d.resolveEntitlement();
  try {
    assertAllowed(ent, "unattended");
  } catch (e) {
    stop("error", "entitlement", e instanceof EntitlementError ? e.message : String(e));
    return EXIT.ERROR;
  }

  // 形式: 指定があればそれ。無ければテキスト中心で、4 回に 1 回だけ画像（会員のみ）
  const cliCount = /** @type {any} */ (d.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source = 'cli'").get()).n;
  /** @type {"text"|"image"|"carousel"} */
  let kind = args.kind ?? (cliCount % 4 === 3 ? "image" : "text");
  if (kind !== "text" && !ent.limits.kinds.includes(kind)) kind = "text";
  d.onPlannedKind?.(kind);

  // テーマの選択と仕事の予約を、theme リースの中で一体に行う（同時に動いた 2 本が同じテーマを選ばないように）
  /** @param {string | null} preferred @returns {Promise<{ theme: string, jobId: string } | null | "busy">} */
  const reserve = async (preferred) => {
    for (let i = 0; i < 50; i++) {
      const lease = acquireLease(d.db, "theme", { purpose: "無人実行のテーマ選び" });
      if ("busy" in lease) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      try {
        const recentThemes = /** @type {any[]} */ (
          d.db.prepare("SELECT theme FROM jobs WHERE theme IS NOT NULL ORDER BY created_at DESC LIMIT ?").all(THEME_LOOKBACK)
        ).map((r) => r.theme);
        const theme = preferred ?? pickTheme(d.themes, recentThemes, d.now());
        if (!theme) return null;
        const jobId = createJob(d.db, { brief: { theme, kind, slideCount: kind === "carousel" ? args.slides ?? 5 : undefined }, source: "cli" });
        return { theme, jobId };
      } finally {
        lease.release();
      }
    }
    return "busy";
  };

  const first = await reserve(args.theme);
  if (first === "busy") {
    d.log("✗ ほかの無人実行がテーマを選んでいます。少し待ってからやり直してください。");
    return EXIT.BUSY;
  }
  if (!first) {
    stop("warn", "theme_exhausted", "テーマの候補を使い切りました。ops/themes.txt に新しいテーマを足してください。");
    return EXIT.NEEDS_HUMAN;
  }
  const theme = first.theme;

  if (args.jitter > 0) await d.sleep(Math.floor(d.random() * args.jitter * 60_000));

  const recentTexts = /** @type {any[]} */ (
    d.db.prepare("SELECT draft_json FROM jobs WHERE draft_json IS NOT NULL ORDER BY created_at DESC LIMIT ?").all(DUPLICATE_LOOKBACK)
  )
    .map((r) => JSON.parse(r.draft_json)?.text)
    .filter((t) => typeof t === "string");
  const strip = ent.limits.credit ? [ent.limits.credit.text] : [];
  const threshold = d.similarityThreshold ?? DEFAULT_THRESHOLD;

  /** 下書きを投稿パッケージとしてローカルに保存する @param {string} jobId */
  const savePackage = async (jobId) => {
    try {
      const p = await buildPackage({ db: d.db, dataRoot: d.dataRoot, exportRoot: d.exportRoot, jobId, entitlement: ent });
      d.log(`✓ ローカルに保存しました: ${p.dir}`);
      return EXIT.OK;
    } catch (e) {
      stop("warn", "export_failed", `下書きはできましたが、ローカルへの保存に失敗しました（${e instanceof Error ? e.message : String(e)}）`, jobId);
      return EXIT.NEEDS_HUMAN;
    }
  };

  d.log(`▶ 下書きを作ります（テーマ: ${theme} / 形式: ${kind}）`);
  /** @type {string | null} */
  let lastJobId = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const jobId = attempt === 1 ? first.jobId : createJob(d.db, { brief: { theme, kind, slideCount: kind === "carousel" ? args.slides ?? 5 : undefined }, source: "cli" });
    const r = await runAutoDraft({
      db: d.db,
      dataRoot: d.dataRoot,
      appRoot: d.appRoot,
      jobId,
      theme,
      kind,
      slideCount: kind === "carousel" ? args.slides ?? 5 : undefined,
      recentOpenings: recentTexts.slice(0, 10).map(openingOf),
      entitlement: ent,
      exec: d.exec,
    });
    lastJobId = r.jobId;
    if (r.status !== "completed") {
      stop("error", "generation_failed", `下書きを作れませんでした（${r.error ?? r.status}）`, r.jobId);
      return EXIT.ERROR;
    }
    const draft = getJob(d.db, r.jobId)?.draft;
    // 出来上がりの検査: 頼んだ形式か・画像がそろったか・Threads の決まり（文字数・リンク数）を満たすか
    const problems = [];
    if (!draft) problems.push("下書きが空です");
    else {
      if (draft.kind !== kind) problems.push(`形式が違います（頼んだのは ${kind}、できたのは ${draft.kind}）`);
      for (const i of draftReadiness(draft)) problems.push(i.message);
      const payload = buildFinalPayload(draft, { credit: ent.limits.credit, allowUserReply: ent.limits.selfReply });
      for (const i of validateFinalPayload(payload)) problems.push(i.message);
    }
    if (problems.length) {
      stop("warn", "incomplete_draft", `下書きが完成していません: ${problems.join(" / ")}。画面で直してください。`, r.jobId);
      return EXIT.NEEDS_HUMAN;
    }
    const text = draft?.text ?? "";
    const dup = checkDuplicate(text, recentTexts, { threshold, strip });
    if (!dup.kind) {
      d.log(`✓ 下書きを作りました: ${r.jobId}（類似度 ${dup.score.toFixed(2)}）`);
      return savePackage(r.jobId);
    }
    d.log(`… 最近の下書きと似ています（${dup.kind}・${dup.score.toFixed(2)}）。${attempt === 1 ? "作り直します" : ""}`);
    if (attempt === 2 && dup.kind !== "exact") {
      addAlert(d.db, { level: "warn", code: "similar", message: `最近の下書きと似ています（${dup.kind}・${dup.score.toFixed(2)}）。確かめてください。`, jobId: r.jobId });
      return savePackage(r.jobId);
    }
  }
  stop("warn", "duplicate", "2 回作り直しても、最近の下書きと同じ内容になりました。テーマを変えてください。", lastJobId);
  return EXIT.NEEDS_HUMAN;
}
