// @ts-check
// 状態の正本（SQLite）と、世代 ID つきのリース（排他）。
// 計画: plans/20261002-threads-post-phase1.md 方針 2・方針 5

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = "3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS accounts (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  credential_generation INTEGER NOT NULL,
  token_fingerprint TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_refreshed_at TEXT,
  connected INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('ui', 'cli')),
  theme TEXT,
  brief_json TEXT NOT NULL,
  draft_json TEXT,
  draft_revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('draft', 'frozen')),
  copied_from_job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE IF NOT EXISTS job_images (
  job_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  is_current INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, slot, revision)
);

CREATE TABLE IF NOT EXISTS generations (
  gen_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  approval_hash TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('main', 'reply')),
  parent_attempt_id TEXT,
  policy TEXT NOT NULL CHECK (policy IN ('manual', 'unattended')),
  approval_hash TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  account_user_id TEXT NOT NULL,
  credential_generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  failure_code TEXT,
  retryable INTEGER,
  containers_json TEXT NOT NULL DEFAULT '[]',
  main_container_id TEXT,
  reserved_at TEXT NOT NULL,
  publish_requested_at TEXT,
  published_at TEXT,
  media_id TEXT,
  permalink TEXT,
  permalink_status TEXT NOT NULL DEFAULT 'pending',
  cleanup_status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS attempts_one_live ON attempts (job_id, role)
  WHERE status NOT IN ('failed_before_publish', 'released', 'resolved_not_published');

CREATE TABLE IF NOT EXISTS resolutions (
  id INTEGER PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  action TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  host TEXT NOT NULL,
  pid INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hosting_objects (
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  git_blob_sha TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, branch, path)
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_events_job ON job_events (job_id, id);

CREATE TABLE IF NOT EXISTS job_photos (
  job_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, photo_id)
);

CREATE TABLE IF NOT EXISTS exports (
  job_id TEXT PRIMARY KEY,
  dir TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  job_id TEXT,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);
`;

/** 一時フォルダとみなす場所（実際の場所で比べる） */
function tempRoots() {
  const roots = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", os.tmpdir()];
  /** @type {string[]} */
  const out = [];
  for (const r of roots) {
    out.push(r);
    try {
      out.push(fs.realpathSync(r));
    } catch {
      /* 無い場所は無視 */
    }
  }
  return [...new Set(out)];
}

/**
 * データ置き場が一時フォルダの下なら投げる（Codex のサンドボックスが一時フォルダに書けるため）。
 * @param {string} dataRoot
 */
export function assertSafeDataRoot(dataRoot) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const real = fs.realpathSync(dataRoot);
  for (const t of tempRoots()) {
    if (real === t || real.startsWith(t.endsWith(path.sep) ? t : t + path.sep)) {
      throw new Error(
        `データ置き場（${real}）が一時フォルダの下にあります。Codex が書き込めてしまうため使えません。THREADSPOST_DATA_ROOT を変えてください。`,
      );
    }
  }
}

/** 既定のデータ置き場 */
export function defaultDataRoot() {
  return process.env.THREADSPOST_DATA_ROOT || path.join(os.homedir(), ".threadspost-data");
}

/**
 * DB を開き、表を作る。
 * @param {{ dataRoot: string, allowTempRootForTests?: boolean }} opts
 * @returns {DatabaseSync}
 */
export function openDb({ dataRoot, allowTempRootForTests = false }) {
  if (allowTempRootForTests) fs.mkdirSync(dataRoot, { recursive: true });
  else assertSafeDataRoot(dataRoot);
  const db = new DatabaseSync(path.join(dataRoot, "state.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  withImmediateTx(db, () => {
    db.exec(SCHEMA);
    // 版 1 → 2 は表 exports、2 → 3 は表 job_photos を足しただけ（CREATE TABLE IF NOT EXISTS で足りる）
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SCHEMA_VERSION);
  });
  return db;
}

/**
 * BEGIN IMMEDIATE で fn を実行する。例外ならロールバックして投げ直す。
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withImmediateTx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* すでに終わっている */
    }
    throw e;
  }
}

/** @param {number} pid */
export function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code !== "ESRCH";
  }
}

/**
 * @typedef {{ name: string, owner_id: string, host: string, pid: number, purpose: string, acquired_at: string, heartbeat_at: string }} LeaseRow
 * @typedef {{ ownerId: string, name: string, release(): void, assertHeld(): void, heartbeat(): boolean }} Lease
 */

/**
 * リースを取る。取れなければ { busy: true, holder } を返す。
 * 古いとみなすのは「同じホスト・pid が死んでいる・心拍が staleMs より古い」をすべて満たすときだけ。
 * @param {DatabaseSync} db
 * @param {string} name
 * @param {{ purpose: string, now?: () => number, isPidAlive?: (pid: number) => boolean, host?: string, pid?: number, staleMs?: number }} opts
 * @returns {Lease | { busy: true, holder: LeaseRow }}
 */
export function acquireLease(db, name, opts) {
  const now = opts.now ?? Date.now;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const host = opts.host ?? os.hostname();
  const pid = opts.pid ?? process.pid;
  const staleMs = opts.staleMs ?? 120_000;
  const ownerId = crypto.randomUUID();
  const at = new Date(now()).toISOString();

  const result = withImmediateTx(db, () => {
    const row = /** @type {LeaseRow | undefined} */ (
      db.prepare("SELECT * FROM leases WHERE name = ?").get(name)
    );
    if (!row) {
      db.prepare(
        "INSERT INTO leases (name, owner_id, host, pid, purpose, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(name, ownerId, host, pid, opts.purpose, at, at);
      return { ok: true };
    }
    const stale =
      row.host === host &&
      !isPidAlive(row.pid) &&
      now() - Date.parse(row.heartbeat_at) > staleMs;
    if (!stale) return { ok: false, holder: row };
    const changed = db
      .prepare(
        "UPDATE leases SET owner_id = ?, host = ?, pid = ?, purpose = ?, acquired_at = ?, heartbeat_at = ? WHERE name = ? AND owner_id = ?",
      )
      .run(ownerId, host, pid, opts.purpose, at, at, name, row.owner_id);
    return changed.changes === 1 ? { ok: true } : { ok: false, holder: row };
  });

  if (!result.ok) return { busy: true, holder: /** @type {LeaseRow} */ (result.holder) };
  return {
    ownerId,
    name,
    release() {
      db.prepare("DELETE FROM leases WHERE name = ? AND owner_id = ?").run(name, ownerId);
    },
    assertHeld() {
      const r = db.prepare("SELECT owner_id FROM leases WHERE name = ?").get(name);
      if (!r || r.owner_id !== ownerId) {
        throw new LeaseLostError(name);
      }
    },
    heartbeat() {
      return heartbeat(db, name, ownerId, { now });
    },
  };
}

export class LeaseLostError extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`リース（${name}）を失いました。ほかの処理に引き継がれたため止めます。`);
    this.name = "LeaseLostError";
  }
}

/**
 * @param {DatabaseSync} db
 * @param {string} name
 * @param {string} ownerId
 * @param {{ now?: () => number }} [opts]
 * @returns {boolean} 自分のリースを更新できたら true
 */
export function heartbeat(db, name, ownerId, opts = {}) {
  const now = opts.now ?? Date.now;
  const r = db
    .prepare("UPDATE leases SET heartbeat_at = ? WHERE name = ? AND owner_id = ?")
    .run(new Date(now()).toISOString(), name, ownerId);
  return r.changes === 1;
}

/**
 * リースを取り、fn の間だけ心拍を打ち、最後に解く。取れなければ LeaseBusyError。
 * @template T
 * @param {DatabaseSync} db
 * @param {string} name
 * @param {string} purpose
 * @param {(lease: Lease) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLease(db, name, purpose, fn) {
  const lease = acquireLease(db, name, { purpose });
  if ("busy" in lease) throw new LeaseBusyError(name, lease.holder);
  const timer = setInterval(() => lease.heartbeat(), 15_000);
  timer.unref?.();
  try {
    return await fn(lease);
  } finally {
    clearInterval(timer);
    lease.release();
  }
}

export class LeaseBusyError extends Error {
  /** @param {string} name @param {LeaseRow} holder */
  constructor(name, holder) {
    super(`ほかの処理（${holder.purpose}）が実行中です。終わるまで待ってください。`);
    this.name = "LeaseBusyError";
    this.leaseName = name;
    this.holder = holder;
  }
}

/** UTC の ISO 文字列 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * 進み具合を記録する（画面は job_events を読む）。
 * @param {DatabaseSync} db
 * @param {string} jobId
 * @param {string} kind
 * @param {string} message
 */
export function addJobEvent(db, jobId, kind, message) {
  db.prepare("INSERT INTO job_events (job_id, at, kind, message) VALUES (?, ?, ?, ?)").run(
    jobId,
    nowIso(),
    kind,
    message.slice(0, 2000),
  );
}

/**
 * 知らせを残す。
 * @param {DatabaseSync} db
 * @param {{ level: "info"|"warn"|"error", code: string, message: string, jobId?: string | null }} a
 */
export function addAlert(db, a) {
  db.prepare("INSERT INTO alerts (level, code, message, job_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
    a.level,
    a.code,
    a.message,
    a.jobId ?? null,
    nowIso(),
  );
}
