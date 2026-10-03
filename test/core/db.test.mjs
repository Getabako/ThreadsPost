import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempRoot } from "../helpers/temp-root.mjs";
import { openDb, withImmediateTx, acquireLease, heartbeat } from "../../core/db.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbModule = path.resolve(here, "../../core/db.mjs");

test("should refuse a data root under the temp directory unless allowed for tests", (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  assert.throws(() => openDb({ dataRoot: tmp.root }), /一時フォルダ/);
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  db.close();
});

test("should create all tables and record the schema version", (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const n of [
    "accounts", "alerts", "approvals", "attempts", "chat_messages", "exports", "generations",
    "hosting_objects", "job_events", "job_images", "job_photos", "jobs", "leases", "meta", "resolutions",
  ]) {
    assert.ok(names.includes(n), `missing table ${n}`);
  }
  const v = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(v?.value, "3");
  assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  db.close();
});

test("withImmediateTx should roll back when the callback throws", (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  assert.throws(() =>
    withImmediateTx(db, () => {
      db.prepare("INSERT INTO meta (key, value) VALUES ('x', '1')").run();
      throw new Error("boom");
    }),
  );
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='x'").get(), undefined);
  db.close();
});

/** 子プロセスで古いリースの回収を同時に試み、成功したかを返す */
function reclaimInChild(root, startAt) {
  const code = `
    import { openDb, acquireLease } from ${JSON.stringify(dbModule)};
    const db = openDb({ dataRoot: ${JSON.stringify(root)}, allowTempRootForTests: true });
    while (Date.now() < ${startAt}) {}
    const r = acquireLease(db, "job:x", { purpose: "test", isPidAlive: () => false });
    console.log(JSON.stringify("busy" in r ? { ok: false } : { ok: true, ownerId: r.ownerId }));
    db.close();
  `;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.on("error", reject);
    p.on("close", () => resolve(JSON.parse(out.trim())));
  });
}

test("should give the lease to exactly one of two processes reclaiming the same stale lease", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  db.prepare(
    "INSERT INTO leases (name, owner_id, host, pid, purpose, acquired_at, heartbeat_at) VALUES ('job:x', 'dead-owner', ?, 999999, 'old', ?, ?)",
  ).run((await import("node:os")).hostname(), old, old);
  const startAt = Date.now() + 400;
  const results = await Promise.all([reclaimInChild(tmp.root, startAt), reclaimInChild(tmp.root, startAt)]);
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1);
  const row = db.prepare("SELECT owner_id FROM leases WHERE name='job:x'").get();
  assert.equal(row?.owner_id, winners[0].ownerId);
  db.close();
});

test("should not reclaim when the owner pid is alive, the heartbeat is fresh, or the host differs", (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  const now = Date.now();
  const old = new Date(now - 10 * 60_000).toISOString();
  const fresh = new Date(now).toISOString();
  const host = "this-host";
  const ins = db.prepare(
    "INSERT INTO leases (name, owner_id, host, pid, purpose, acquired_at, heartbeat_at) VALUES (?, 'o', ?, 1, 'p', ?, ?)",
  );
  ins.run("a", host, old, old);
  ins.run("b", host, fresh, fresh);
  ins.run("c", "other-host", old, old);
  const opts = { purpose: "t", host, now: () => now };
  assert.ok("busy" in acquireLease(db, "a", { ...opts, isPidAlive: () => true }));
  assert.ok("busy" in acquireLease(db, "b", { ...opts, isPidAlive: () => false }));
  assert.ok("busy" in acquireLease(db, "c", { ...opts, isPidAlive: () => false }));
  assert.ok(!("busy" in acquireLease(db, "a", { ...opts, isPidAlive: () => false })));
  db.close();
});

test("should not release or heartbeat a lease owned by a different owner_id", (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  const a = acquireLease(db, "gen:1", { purpose: "t" });
  assert.ok(!("busy" in a));
  assert.equal(heartbeat(db, "gen:1", "someone-else"), false);
  assert.equal(heartbeat(db, "gen:1", a.ownerId), true);
  db.prepare("UPDATE leases SET owner_id='intruder' WHERE name='gen:1'").run();
  a.release();
  assert.equal(db.prepare("SELECT owner_id FROM leases WHERE name='gen:1'").get()?.owner_id, "intruder");
  db.close();
});

test("should make assertHeld throw after the lease was taken over", (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  const a = acquireLease(db, "job:1", { purpose: "t" });
  assert.ok(!("busy" in a));
  a.assertHeld();
  db.prepare("UPDATE leases SET owner_id='other' WHERE name='job:1'").run();
  assert.throws(() => a.assertHeld(), /リース/);
  db.close();
});

test("should keep committed rows after the process is killed right after commit", async (t) => {
  const tmp = makeTempRoot();
  t.after(() => tmp.cleanup());
  const code = `
    import { openDb } from ${JSON.stringify(dbModule)};
    const db = openDb({ dataRoot: ${JSON.stringify(tmp.root)}, allowTempRootForTests: true });
    db.prepare("INSERT INTO meta (key, value) VALUES ('committed', 'yes')").run();
    process.kill(process.pid, "SIGKILL");
  `;
  await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
    p.on("close", resolve);
  });
  const db = openDb({ dataRoot: tmp.root, allowTempRootForTests: true });
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='committed'").get()?.value, "yes");
  db.close();
});
