#!/usr/bin/env node
// @ts-check
// 無人実行（第一段階は下書きまで）。
//   node scripts/auto-post.mjs                          # テーマを選んで下書きを 1 本作る（既定）
//   node scripts/auto-post.mjs --theme="…" --kind=text|image|carousel --slides=5 --jitter=20
//   node scripts/auto-post.mjs --publish                # 投稿は第一段階の後半で対応（今は終了コード 2）
// 下書きができたら、投稿パッケージ（本文・返信・画像・投稿情報）をアプリのフォルダの Threads投稿/ に保存する。
// 終了コード: 0 下書きを作って保存した / 1 失敗 / 2 未対応 / 11 人の確認が要る（テーマ切れ・重複・未完成）

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, defaultDataRoot } from "../core/db.mjs";
import { resolveEntitlement } from "../core/entitlement.mjs";
import { runAuto } from "../core/auto.mjs";
import { defaultExportRoot } from "../core/export.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** ops/themes.txt（1 行 1 テーマ。# で始まる行と空行は無視） */
function loadThemes() {
  try {
    return fs
      .readFileSync(path.join(APP_ROOT, "ops", "themes.txt"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/** macOS の通知（失敗しても止めない） @param {string} message */
function notify(message) {
  const script = `display notification ${JSON.stringify(message.slice(0, 200))} with title "Threads Post"`;
  spawnSync("osascript", ["-e", script], { stdio: "ignore" });
}

const log = (/** @type {string} */ m) => console.log(`[${new Date().toISOString()}] ${m}`);
const dataRoot = defaultDataRoot();
const db = openDb({ dataRoot });
try {
  const code = await runAuto(process.argv.slice(2), {
    db,
    dataRoot,
    appRoot: APP_ROOT,
    resolveEntitlement: () => resolveEntitlement({ cwd: APP_ROOT }),
    notify,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: Math.random,
    now: () => new Date(),
    themes: loadThemes(),
    log,
    exportRoot: defaultExportRoot(APP_ROOT),
  });
  if (code === 0) log("画面で確かめるには: bash ashura-start.sh を実行し、「下書きの一覧」から開いてください。保存したフォルダは上に表示したとおりです。");
  process.exitCode = code;
} catch (e) {
  log(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
