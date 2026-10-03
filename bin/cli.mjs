#!/usr/bin/env node
// @ts-check
// Threads Post — ローカルの画面（Next.js standalone）を起動する。
// 127.0.0.1 だけで待ち受け、投稿の作法（public/docs）はリポジトリの場所から読ませる。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STANDALONE = path.join(PKG_ROOT, ".next", "standalone", "server.js");
const MIN_CODEX = [0, 160];

/** @param {string} text */
function codexVersion(text) {
  const m = text.match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** @param {number} start @returns {Promise<number>} */
function pickPort(start) {
  return new Promise((resolve) => {
    /** @param {number} p */
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.listen(p, "127.0.0.1", () => srv.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(`✗ Node.js 24 以上が必要です（今は ${process.version}）。`);
  process.exit(1);
}

const cv = spawnSync("codex", ["--version"], { encoding: "utf8" });
if (cv.error || cv.status !== 0) {
  console.error("✗ codex CLI が見つかりません。先に入れてから `codex login` で ChatGPT アカウントにログインしてください。");
  process.exit(1);
}
const v = codexVersion(cv.stdout);
if (!v || v[0] < MIN_CODEX[0] || (v[0] === MIN_CODEX[0] && v[1] < MIN_CODEX[1])) {
  console.error(`✗ codex 0.${MIN_CODEX[1]} 以上が必要です（今は ${cv.stdout.trim()}）。更新してください。`);
  process.exit(1);
}

if (!fs.existsSync(STANDALONE)) {
  console.error(`✗ ビルド成果物がありません: ${STANDALONE}\n  このフォルダで npm run build を実行してください。`);
  process.exit(1);
}

// ビルドし直すたびに static と public を standalone に写す
const standaloneDir = path.dirname(STANDALONE);
for (const [src, dst] of [
  [path.join(PKG_ROOT, ".next", "static"), path.join(standaloneDir, ".next", "static")],
  [path.join(PKG_ROOT, "public"), path.join(standaloneDir, "public")],
]) {
  if (!fs.existsSync(src)) continue;
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

const port = await pickPort(Number(process.env.PORT) || 4593);
const url = `http://127.0.0.1:${port}`;
console.log("");
console.log("=".repeat(56));
console.log("  ▶ Threads Post 起動完了");
console.log(`  ▶ ブラウザで開く:  ${url}`);
console.log("  ▶ 終了するには:    Ctrl+C");
console.log("=".repeat(56));
console.log("");

const child = spawn(process.execPath, [STANDALONE], {
  env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", THREADSPOST_APP_ROOT: PKG_ROOT, NODE_ENV: "production" },
  stdio: "inherit",
});
const shutdown = () => {
  try {
    child.kill("SIGTERM");
  } catch {
    /* noop */
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => process.exit(code ?? 0));
