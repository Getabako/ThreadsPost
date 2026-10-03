// @ts-check
// Codex（codex exec）の起動・停止。1 回の生成ごとに専用のプロセスで動かす。
// 計画: 方針 10。M0 #9〜#11（2026-10-02 実測）で、次を確かめた:
//   - --ignore-user-config で ~/.codex/config.toml（MCP・プラグイン）を読まず、ログインだけ使える
//   - workspace-write + exclude_slash_tmp + exclude_tmpdir_env_var で、作業フォルダ以外・/tmp への書き込みは断られる
//   - その状態でも image_gen で画像を作り、作業フォルダに保存できる
//   - サンドボックスの中からキーチェーンは読めない

import { spawn } from "node:child_process";
import readline from "node:readline";

export const CODEX_MODEL = "gpt-6.1-sol";
export const CODEX_EFFORT = "medium";

const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "CODEX_HOME", "SHELL"];

/**
 * Codex に渡す環境変数を許可リストだけにする（親の秘密を子に渡さない）。
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} [extra] テストでだけ使う追加の名前
 * @returns {Record<string, string>}
 */
export function buildCodexEnv(env, extra = []) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of [...ENV_ALLOWLIST, ...extra]) {
    const v = env[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * @typedef {"read-only" | "workspace-write"} Sandbox
 * @param {{ cwd: string, sandbox: Sandbox, model?: string, effort?: string, outputSchemaPath?: string, images?: string[] }} o
 * @returns {string[]}
 */
export function buildExecArgs(o) {
  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "--color",
    "never",
    "-m",
    o.model ?? CODEX_MODEL,
    "-c",
    `model_reasoning_effort="${o.effort ?? CODEX_EFFORT}"`,
    "-s",
    o.sandbox,
  ];
  if (o.sandbox === "workspace-write") {
    args.push(
      "-c",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      "-c",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c",
      "sandbox_workspace_write.network_access=false",
    );
  }
  if (o.outputSchemaPath) args.push("--output-schema", o.outputSchemaPath);
  for (const img of o.images ?? []) args.push("-i", img);
  args.push("-C", o.cwd, "-");
  return args;
}

/**
 * @typedef {{ type: string, [k: string]: any }} CodexEvent
 * @typedef {{ status: "completed" | "failed" | "interrupted" | "timeout", lastMessage: string | null, threadId: string | null, exitCode: number | null, error: string | null, stderrTail: string }} ExecResult
 */

/**
 * codex exec を 1 回動かす。時間切れ・中断では、プロセスグループに SIGINT → SIGTERM → SIGKILL を送り、
 * 終了を確かめてから結果を返す（止まる前に結果を返さない）。
 * @param {{
 *   cwd: string, prompt: string, sandbox: Sandbox, model?: string, effort?: string,
 *   outputSchemaPath?: string, images?: string[],
 *   timeoutMs?: number, signal?: AbortSignal, onEvent?: (e: CodexEvent) => void,
 *   env?: NodeJS.ProcessEnv, passThroughForTests?: string[],
 *   command?: string, commandPrefix?: string[],
 *   graceMs?: { interrupt: number, terminate: number }
 * }} o
 * @returns {Promise<ExecResult>}
 */
export function runCodexExec(o) {
  const command = o.command ?? "codex";
  const args = [...(o.commandPrefix ?? []), ...buildExecArgs(o)];
  const env = buildCodexEnv(o.env ?? process.env, o.passThroughForTests ?? []);
  const grace = o.graceMs ?? { interrupt: 30_000, terminate: 10_000 };
  const timeoutMs = o.timeoutMs ?? 15 * 60_000;

  return new Promise((resolve) => {
    /** @type {ExecResult["status"] | null} */
    let forced = null;
    let lastMessage = /** @type {string|null} */ (null);
    let threadId = /** @type {string|null} */ (null);
    let turnCompleted = false;
    let turnError = /** @type {string|null} */ (null);
    let stderrTail = "";
    let settled = false;
    /** @type {NodeJS.Timeout[]} */
    const timers = [];

    /** @param {ExecResult} r */
    const finish = (r) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      o.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };

    /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */
    let child;
    try {
      child = spawn(command, args, { cwd: o.cwd, env: /** @type {NodeJS.ProcessEnv} */ (env), stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e) {
      finish({ status: "failed", lastMessage: null, threadId: null, exitCode: null, error: String(e), stderrTail: "" });
      return;
    }

    /** @param {NodeJS.Signals} sig */
    const killGroup = (sig) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* すでに終わっている */
      }
    };

    /** @param {"timeout" | "interrupted"} why */
    const stop = (why) => {
      if (forced || settled) return;
      forced = why;
      killGroup("SIGINT");
      timers.push(
        setTimeout(() => {
          killGroup("SIGTERM");
          timers.push(setTimeout(() => killGroup("SIGKILL"), grace.terminate));
        }, grace.interrupt),
      );
    };
    const onAbort = () => stop("interrupted");
    if (o.signal) {
      if (o.signal.aborted) stop("interrupted");
      else o.signal.addEventListener("abort", onAbort);
    }
    timers.push(setTimeout(() => stop("timeout"), timeoutMs));

    child.on("error", (e) => {
      finish({ status: "failed", lastMessage: null, threadId: null, exitCode: null, error: String(e), stderrTail });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(o.prompt);

    child.stderr.on("data", (b) => {
      stderrTail = (stderrTail + b.toString()).slice(-4000);
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      /** @type {CodexEvent} */
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        return; // 壊れた行は捨てる
      }
      if (ev.type === "thread.started") threadId = ev.thread_id ?? null;
      if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
        lastMessage = ev.item.text;
      }
      if (ev.type === "turn.completed") turnCompleted = true;
      if (ev.type === "turn.failed") turnError = ev.error?.message ?? "turn failed";
      if (ev.type === "error") turnError = ev.message ?? "error";
      if (!forced) {
        try {
          o.onEvent?.(ev);
        } catch {
          /* 表示側の失敗で止めない */
        }
      }
    });

    /** プロセスグループにまだ誰か残っているか */
    const groupAlive = () => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (e) {
        return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
      }
    };

    child.on("close", (code) => {
      if (forced) {
        // 親が先に終わっても、グループ全体が止まるまで停止の段取り（SIGTERM → SIGKILL）を続け、確かめてから返す
        const reason = forced === "timeout" ? "時間切れで止めました" : "中断しました";
        const deadline = Date.now() + grace.interrupt + grace.terminate + 5_000;
        const poll = () => {
          if (!groupAlive()) {
            finish({ status: /** @type {"timeout"|"interrupted"} */ (forced), lastMessage: null, threadId, exitCode: code, error: reason, stderrTail });
          } else if (Date.now() > deadline) {
            killGroup("SIGKILL");
            finish({ status: /** @type {"timeout"|"interrupted"} */ (forced), lastMessage: null, threadId, exitCode: code, error: `${reason}（一部のプロセスが止まりきらなかった可能性があります）`, stderrTail });
          } else {
            setTimeout(poll, 50);
          }
        };
        poll();
        return;
      }
      // 正常に終わっても、残った子プロセスがあれば片付ける
      if (groupAlive()) killGroup("SIGTERM");
      const ok = code === 0 && turnCompleted && !turnError;
      finish({
        status: ok ? "completed" : "failed",
        lastMessage: ok ? lastMessage : null,
        threadId,
        exitCode: code,
        error: ok ? null : turnError ?? `codex が終了コード ${code} で終わりました`,
        stderrTail,
      });
    });
  });
}

/**
 * Codex にログインしているか（`codex login status`）。
 * @param {{ command?: string }} [o]
 * @returns {Promise<{ loggedIn: boolean, detail: string }>}
 */
export function codexLoginStatus(o = {}) {
  return new Promise((resolve) => {
    let out = "";
    /** @type {import("node:child_process").ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable>} */
    let p;
    try {
      p = spawn(o.command ?? "codex", ["login", "status"], { env: /** @type {NodeJS.ProcessEnv} */ (buildCodexEnv(process.env)), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ loggedIn: false, detail: `codex が見つかりません: ${e}` });
      return;
    }
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("error", (e) => resolve({ loggedIn: false, detail: `codex が見つかりません: ${e.message}` }));
    p.on("close", (code) => resolve({ loggedIn: code === 0 && /logged in/i.test(out), detail: out.trim().split("\n")[0] ?? "" }));
  });
}
