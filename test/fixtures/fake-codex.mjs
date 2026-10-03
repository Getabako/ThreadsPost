#!/usr/bin/env node
// 本物の `codex exec --json` の代わりに、台本どおりの JSONL を出す偽物。
// 動き方は環境変数 FAKE_CODEX_MODE で選ぶ。受け取った引数と環境変数は FAKE_CODEX_RECORD に書く。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { VALID_PNG, BROKEN_PNG } from "../helpers/png.mjs";

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || "ok";
const record = process.env.FAKE_CODEX_RECORD;
let stdin = "";
const cwdIdx = args.indexOf("-C");
const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : process.cwd();

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

process.stdin.on("data", (b) => (stdin += b));
process.stdin.on("end", () => {
  if (record) fs.writeFileSync(record, JSON.stringify({ args, env: process.env, stdin, pid: process.pid }));
  run();
});

function run() {
  emit({ type: "thread.started", thread_id: "fake-thread" });
  emit({ type: "turn.started" });
  if (mode === "badjson") {
    process.stdout.write("{not json\n");
  }
  if (mode === "crash") {
    process.exit(3);
  }
  if (mode === "fail") {
    emit({ type: "turn.failed", error: { message: "model error" } });
    process.exit(1);
  }
  if (mode === "orphan-child") {
    // SIGINT を無視して書き続ける孫プロセスを残し、親は SIGINT で標準出力を閉じて終わる
    const child = spawn(process.execPath, ["-e", `process.on("SIGINT",()=>{});setInterval(()=>{},1000)`], { stdio: "ignore" });
    if (process.env.FAKE_CODEX_CHILD_PID) fs.writeFileSync(process.env.FAKE_CODEX_CHILD_PID, String(child.pid));
    process.on("SIGINT", () => process.exit(130));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "hang" || mode === "hang-ignore-int") {
    if (mode === "hang-ignore-int") process.on("SIGINT", () => {});
    // 時間切れになるまで書き続ける（止められた後に書き込むと困ることを確かめる）
    setInterval(() => {
      try {
        fs.mkdirSync(path.join(cwd, "images"), { recursive: true });
        fs.writeFileSync(path.join(cwd, "images", "late.txt"), String(Date.now()));
      } catch {}
    }, 50);
    return;
  }
  emit({ type: "item.started", item: { id: "i1", type: "command_execution", command: "mkdir -p images", status: "in_progress" } });
  const slots = (process.env.FAKE_CODEX_SLOTS || "").split(",").filter(Boolean);
  for (const s of slots) {
    fs.mkdirSync(path.join(cwd, "images"), { recursive: true });
    const png = process.env.FAKE_CODEX_BROKEN_PNG ? BROKEN_PNG : VALID_PNG;
    fs.writeFileSync(path.join(cwd, "images", `slide-${String(s).padStart(2, "0")}.png`), png);
  }
  if (process.env.FAKE_CODEX_SYMLINK) {
    fs.mkdirSync(path.join(cwd, "images"), { recursive: true });
    fs.symlinkSync(process.env.FAKE_CODEX_SYMLINK, path.join(cwd, "images", "slide-09.png"));
  }
  emit({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "mkdir -p images", exit_code: 0, status: "completed" } });
  const finalText = process.env.FAKE_CODEX_FINAL ?? JSON.stringify({ reply: "作りました", draft: { kind: "text", text: "本文", topicTag: "AI活用", selfReplyText: "", images: [] } });
  emit({ type: "item.completed", item: { id: "i2", type: "agent_message", text: finalText } });
  emit({ type: "turn.completed", usage: {} });
  process.exit(0);
}
