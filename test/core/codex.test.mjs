import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempRoot } from "../helpers/temp-root.mjs";
import { buildCodexEnv, buildExecArgs, runCodexExec, CODEX_MODEL } from "../../core/codex.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(here, "../fixtures/fake-codex.mjs");
const fake = { command: process.execPath, commandPrefix: [FAKE] };

test("should use gpt-6.1-sol", () => {
  assert.equal(CODEX_MODEL, "gpt-6.1-sol");
});

test("should pass only allowlisted environment variables", () => {
  const env = buildCodexEnv({
    PATH: "/bin",
    HOME: "/h",
    LANG: "ja_JP.UTF-8",
    TMPDIR: "/t",
    THREADSPOST_TOKEN: "secret",
    GH_TOKEN: "gh",
    OPENAI_API_KEY: "sk",
    ASHURA_MEMBER_KEY: "m",
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
});

test("should build workspace-write args with empty writable roots, tmp exclusions, no user config and the model", () => {
  const a = buildExecArgs({ cwd: "/w", sandbox: "workspace-write", model: "gpt-6.1-sol", effort: "medium" });
  const s = a.join(" ");
  for (const part of [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "-m gpt-6.1-sol",
    "-s workspace-write",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "sandbox_workspace_write.network_access=false",
    "-C /w",
  ]) {
    assert.ok(s.includes(part), `missing ${part} in ${s}`);
  }
  assert.ok(!s.includes("--add-dir"));
  assert.equal(a.at(-1), "-");
  const r = buildExecArgs({ cwd: "/w", sandbox: "read-only", model: "gpt-6.1-sol", effort: "medium" }).join(" ");
  assert.ok(r.includes("-s read-only") && !r.includes("exclude_slash_tmp"));
});

test("should run to completion, stream events and return the last agent message", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const rec = path.join(tmp.root, "rec.json");
  const events = [];
  const r = await runCodexExec({
    ...fake,
    cwd: tmp.root,
    prompt: "hello",
    sandbox: "workspace-write",
    env: { ...process.env, FAKE_CODEX_MODE: "ok", FAKE_CODEX_RECORD: rec },
    passThroughForTests: ["FAKE_CODEX_MODE", "FAKE_CODEX_RECORD"],
    onEvent: (e) => events.push(e),
    timeoutMs: 10_000,
  });
  assert.equal(r.status, "completed");
  assert.match(r.lastMessage ?? "", /draft/);
  assert.ok(events.some((e) => e.type === "turn.completed"));
  const seen = JSON.parse(fs.readFileSync(rec, "utf8"));
  assert.equal(seen.stdin, "hello");
});

test("should not pass secrets from the parent environment to the child", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const rec = path.join(tmp.root, "rec.json");
  await runCodexExec({
    ...fake,
    cwd: tmp.root,
    prompt: "x",
    sandbox: "read-only",
    env: { ...process.env, GH_TOKEN: "gh-secret", OPENAI_API_KEY: "sk-secret", FAKE_CODEX_RECORD: rec },
    passThroughForTests: ["FAKE_CODEX_RECORD"],
    timeoutMs: 10_000,
  });
  const seen = JSON.parse(fs.readFileSync(rec, "utf8"));
  assert.equal(seen.env.GH_TOKEN, undefined);
  assert.equal(seen.env.OPENAI_API_KEY, undefined);
});

test("should report failed on turn failure, crash and spawn failure", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  for (const mode of ["fail", "crash"]) {
    const r = await runCodexExec({ ...fake, cwd: tmp.root, prompt: "x", sandbox: "read-only", env: { ...process.env, FAKE_CODEX_MODE: mode }, passThroughForTests: ["FAKE_CODEX_MODE"], timeoutMs: 10_000 });
    assert.equal(r.status, "failed", mode);
  }
  const r = await runCodexExec({ command: "/nonexistent/codex", commandPrefix: [], cwd: tmp.root, prompt: "x", sandbox: "read-only", timeoutMs: 5_000 });
  assert.equal(r.status, "failed");
});

test("should ignore malformed json lines and still complete", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const r = await runCodexExec({ ...fake, cwd: tmp.root, prompt: "x", sandbox: "read-only", env: { ...process.env, FAKE_CODEX_MODE: "badjson" }, passThroughForTests: ["FAKE_CODEX_MODE"], timeoutMs: 10_000 });
  assert.equal(r.status, "completed");
});

test("should stop the process group on timeout, escalating past an ignored SIGINT, and nothing is written afterwards", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const started = Date.now();
  const r = await runCodexExec({
    ...fake,
    cwd: tmp.root,
    prompt: "x",
    sandbox: "workspace-write",
    env: { ...process.env, FAKE_CODEX_MODE: "hang-ignore-int" },
    passThroughForTests: ["FAKE_CODEX_MODE"],
    timeoutMs: 300,
    graceMs: { interrupt: 200, terminate: 200 },
  });
  assert.equal(r.status, "timeout");
  assert.ok(Date.now() - started < 5_000);
  const late = path.join(tmp.root, "images", "late.txt");
  const before = fs.existsSync(late) ? fs.readFileSync(late, "utf8") : "";
  await new Promise((res) => setTimeout(res, 300));
  const after = fs.existsSync(late) ? fs.readFileSync(late, "utf8") : "";
  assert.equal(after, before, "child kept writing after it was stopped");
});

test("should stop when the abort signal fires and report interrupted", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const r = await runCodexExec({
    ...fake,
    cwd: tmp.root,
    prompt: "x",
    sandbox: "read-only",
    env: { ...process.env, FAKE_CODEX_MODE: "hang" },
    passThroughForTests: ["FAKE_CODEX_MODE"],
    timeoutMs: 10_000,
    signal: ac.signal,
    graceMs: { interrupt: 200, terminate: 200 },
  });
  assert.equal(r.status, "interrupted");
});

test("should keep stopping the process group until children are gone after the parent exits", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const pidFile = path.join(tmp.root, "child.pid");
  const r = await runCodexExec({
    ...fake,
    cwd: tmp.root,
    prompt: "x",
    sandbox: "read-only",
    env: { ...process.env, FAKE_CODEX_MODE: "orphan-child", FAKE_CODEX_CHILD_PID: pidFile },
    passThroughForTests: ["FAKE_CODEX_MODE", "FAKE_CODEX_CHILD_PID"],
    timeoutMs: 300,
    graceMs: { interrupt: 200, terminate: 200 },
  });
  assert.equal(r.status, "timeout");
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  let alive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "child process survived the timeout");
});
