// @ts-check
// サーバープロセスで 1 つだけ持つ実行の文脈（DB・起動ごとの鍵・会員判定のキャッシュ）。
// Next.js は route ごとにモジュールを分けることがあるので、globalThis に置く。

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { defaultExportRoot } from "../core/export.mjs";
import { openDb, defaultDataRoot } from "../core/db.mjs";
import { resolveEntitlement, activateByEmail } from "../core/entitlement.mjs";
import { codexLoginStatus } from "../core/codex.mjs";
import { recoverGenerations } from "../core/generation.mjs";

const ENTITLEMENT_TTL_MS = 5 * 60_000;

/** @returns {import("./handlers.mjs").Ctx} */
export function getContext() {
  const g = /** @type {any} */ (globalThis);
  if (g.__threadspostCtx) return g.__threadspostCtx;
  const dataRoot = defaultDataRoot();
  const db = openDb({ dataRoot });
  const appRoot = process.env.THREADSPOST_APP_ROOT || process.cwd();
  /** @type {{ at: number, value: import("../core/entitlement.mjs").Entitlement } | null} */
  let cache = null;
  /** @type {import("./handlers.mjs").Ctx} */
  const ctx = {
    db,
    dataRoot,
    appRoot,
    sessionToken: crypto.randomBytes(32).toString("hex"),
    port: process.env.PORT || undefined,
    async resolveEntitlement() {
      if (cache && Date.now() - cache.at < ENTITLEMENT_TTL_MS) return cache.value;
      const value = await resolveEntitlement({ cwd: appRoot });
      cache = { at: Date.now(), value };
      return value;
    },
    async activate(email) {
      const r = await activateByEmail(email);
      cache = null;
      return r;
    },
    codexStatus: () => codexLoginStatus(),
    running: new Map(),
    exportRoot: defaultExportRoot(),
    // 保存したフォルダを Finder で開く（パスは呼び出し側で保存先の中に限ってある）
    openPath: (p) => {
      spawn("open", [p], { stdio: "ignore", detached: true }).unref();
    },
  };
  g.__threadspostCtx = ctx;
  return ctx;
}

/** 起動時に 1 回だけ（instrumentation.ts から）呼ぶ */
export function bootRecover() {
  const ctx = getContext();
  const n = recoverGenerations(ctx.db);
  if (n) console.log(`[threadspost] 前回止まった生成 ${n} 件を「中断」にしました`);
}
