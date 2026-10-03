// @ts-check
// アシュラ会員判定とフリー版の制限（UI・API・CLI 共通）。
// 移植元 InstagramPost の lib/ashura/license.ts の判定（会員キーの読み込み順・30 日キャッシュ・
// 障害時はキャッシュでフル・メールでの認証）を JS に移したもの。計画: 方針 14・Task 11・12
//
// フリー版の範囲は人間の決定待ち（計画 Task 0 決定 2）。決まるまでは計画の案
// 「テキストのみ・無人実行なし・本文の末尾に短いクレジット」で動かす。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const TOOL_NAME = "ThreadsPost";
export const CACHE_FILE = "threadspost-license-cache.json";
const DEFAULT_LICENSE_URL =
  "https://script.google.com/macros/s/AKfycbw3cuKZaSqCgqFTK3C-uVjCKaea3MKNQD_1zl0nZiaJ2AMV6xQzmmKrXNHZjaoIeXsE/exec";
const VERIFY_TIMEOUT_MS = 6000;
const CACHE_TTL_DAYS = 30;
const JOIN_URL = "https://service.if-juku.net/Ashura";

/** フリー版で本文に付けるクレジット（暫定。Task 0 決定 2） */
export const FREE_CREDIT = /** @type {const} */ ({ text: "#アシュラ秘奥義", place: "body" });
const FREE_NOTE = "フリー版で動いています（テキスト投稿の下書きのみ。画像・カルーセル・無人実行はアシュラ会員限定）。";

/**
 * @typedef {{ kinds: Array<"text"|"image"|"carousel">, unattended: boolean, selfReply: boolean, credit: { text: string, place: "body"|"reply" } | null }} Limits
 * @typedef {{ mode: "full"|"free", message: string, premiumPrompt?: string, limits: Limits }} Entitlement
 * @typedef {"generate_images"|"publish_kind:text"|"publish_kind:image"|"publish_kind:carousel"|"unattended"|"user_self_reply"|"system_credit_reply"} Action
 * @typedef {(url: string, init?: any) => Promise<{ ok: boolean, json(): Promise<any> }>} FetchLike
 */

/** @type {Limits} */
const FULL_LIMITS = { kinds: ["text", "image", "carousel"], unattended: true, selfReply: true, credit: null };
/** @type {Limits} */
const FREE_LIMITS = { kinds: ["text"], unattended: false, selfReply: false, credit: { ...FREE_CREDIT } };

/** @param {string} mode @param {string} message @param {string} [premiumPrompt] @returns {Entitlement} */
function make(mode, message, premiumPrompt) {
  return mode === "full"
    ? { mode: "full", message, premiumPrompt, limits: { ...FULL_LIMITS, kinds: [...FULL_LIMITS.kinds] } }
    : { mode: "free", message, limits: { ...FREE_LIMITS, kinds: [...FREE_LIMITS.kinds], credit: FREE_LIMITS.credit ? { ...FREE_LIMITS.credit } : null } };
}

/** @param {{ ashuraHome?: string, env?: NodeJS.ProcessEnv }} o */
function homeOf(o) {
  const env = o.env ?? process.env;
  return o.ashuraHome || env.ASHURA_HOME || path.join(os.homedir(), ".ashura");
}

/**
 * 会員キーを読む（優先順: 環境変数 → 作業フォルダの ashura-key.txt → ~/.ashura/member.json）。
 * @param {{ ashuraHome?: string, env?: NodeJS.ProcessEnv, cwd?: string }} o
 */
export function readMemberKey(o = {}) {
  const env = o.env ?? process.env;
  const k = (env.ASHURA_MEMBER_KEY || "").trim();
  if (k) return k;
  const candidates = [path.join(o.cwd ?? process.cwd(), "ashura-key.txt"), path.join(homeOf(o), "member.json")];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const key = p.endsWith(".json") ? String(JSON.parse(raw).key || "").trim() : raw.trim().split(/\s+/)[0] || "";
      if (key) return key;
    } catch {
      /* 読めないものは飛ばす */
    }
  }
  return "";
}

/** @param {string} url @param {FetchLike} fetchImpl */
async function getJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 会員判定。サーバーが明確に invalid と答えたときだけフリー版に下げる（フェイルオープン）。
 * @param {{ fetchImpl?: FetchLike, ashuraHome?: string, env?: NodeJS.ProcessEnv, cwd?: string, now?: () => number }} [o]
 * @returns {Promise<Entitlement>}
 */
export async function resolveEntitlement(o = {}) {
  const env = o.env ?? process.env;
  const fetchImpl = o.fetchImpl ?? /** @type {FetchLike} */ (/** @type {unknown} */ (fetch));
  const now = o.now ?? Date.now;
  const home = homeOf(o);
  const cachePath = path.join(home, CACHE_FILE);
  const key = readMemberKey(o);
  if (!key) return make("free", "会員キーが未設定です。" + FREE_NOTE);
  // キャッシュは、認証したキーに結び付ける（キーを変えたら使わない）
  const keyHash = crypto.createHash("sha256").update(key).digest("hex");
  const url = env.ASHURA_LICENSE_URL || DEFAULT_LICENSE_URL;
  try {
    const data = await getJson(`${url}?action=verify&key=${encodeURIComponent(key)}`, fetchImpl);
    if (data?.ok && data.status === "active") {
      const premiumPrompt = data.payload?.premiumPrompt || "";
      try {
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify({ verifiedAt: now(), keyHash, premiumPrompt }));
      } catch {
        /* キャッシュが書けなくても判定は使う */
      }
      return make("full", "アシュラ会員として認証しました（フル版）", premiumPrompt);
    }
    if (data?.ok && data.status === "invalid") {
      try {
        fs.rmSync(cachePath, { force: true });
      } catch {
        /* noop */
      }
      const why = data.reason === "membership_inactive" ? "会員契約が確認できませんでした。" : "会員キーが確認できませんでした。";
      return make("free", `${why}${FREE_NOTE} 入会・再入会: ${JOIN_URL}`);
    }
    throw new Error("unexpected response");
  } catch {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      const age = now() - Number(c.verifiedAt);
      if (c.keyHash === keyHash && Number.isFinite(age) && age >= 0 && age <= CACHE_TTL_DAYS * 86_400_000) {
        return make("full", "認証サーバーに接続できないため、前回の認証結果でフル版として動いています", c.premiumPrompt || "");
      }
    } catch {
      /* キャッシュなし */
    }
    return make("free", "認証サーバーに接続できません。" + FREE_NOTE);
  }
}

/**
 * メールアドレスで会員認証し、成功したら ~/.ashura/member.json に会員キーを保存する（全奥義共通）。
 * @param {string} email
 * @param {{ fetchImpl?: FetchLike, ashuraHome?: string, env?: NodeJS.ProcessEnv }} [o]
 * @returns {Promise<{ activated: boolean, message: string }>}
 */
export async function activateByEmail(email, o = {}) {
  const env = o.env ?? process.env;
  const fetchImpl = o.fetchImpl ?? /** @type {FetchLike} */ (/** @type {unknown} */ (fetch));
  const trimmed = String(email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return { activated: false, message: "メールアドレスの形式が正しくありません。" };
  const url = env.ASHURA_LICENSE_URL || DEFAULT_LICENSE_URL;
  try {
    const data = await getJson(`${url}?action=activate&email=${encodeURIComponent(trimmed)}`, fetchImpl);
    if (data?.ok && data.status === "active" && data.key) {
      const home = homeOf(o);
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, "member.json"), JSON.stringify({ key: data.key, email: trimmed }), { mode: 0o600 });
      return { activated: true, message: "会員認証が完了しました。すべての奥義がフル機能で使えます。" };
    }
    if (data?.ok && data.status === "invalid") {
      const why =
        data.reason === "membership_inactive"
          ? "会員契約が確認できませんでした（会費のお支払い状況をご確認ください）。"
          : "このメールアドレスは会員登録が見つかりませんでした。";
      return { activated: false, message: `${why} 入会・再入会: ${JOIN_URL}` };
    }
    throw new Error("server error");
  } catch {
    return { activated: false, message: "認証サーバーに接続できませんでした。時間をおいて再度お試しください。" };
  }
}

export class EntitlementError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "EntitlementError";
  }
}

/**
 * その操作が許されているか。許されていなければ EntitlementError。
 * @param {Entitlement} e
 * @param {Action} action
 */
export function assertAllowed(e, action) {
  const l = e.limits;
  const deny = (/** @type {string} */ what) => {
    throw new EntitlementError(`${what}はアシュラ会員限定です。画面のメール認証欄から会員認証してください（${JOIN_URL}）。`);
  };
  if (action === "generate_images" && !l.kinds.some((k) => k !== "text")) deny("画像の生成");
  if (action.startsWith("publish_kind:")) {
    const kind = /** @type {"text"|"image"|"carousel"} */ (action.slice("publish_kind:".length));
    if (!l.kinds.includes(kind)) deny(kind === "carousel" ? "カルーセル" : "画像付きの投稿");
  }
  if (action === "unattended" && !l.unattended) deny("無人実行");
  if (action === "user_self_reply" && !l.selfReply) deny("自分への返信");
  // system_credit_reply は常に許す（クレジットを返信に置く設定のフリー版のため）
}
