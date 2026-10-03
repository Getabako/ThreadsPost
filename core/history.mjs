// @ts-check
// 日本時間の日付・重複の判定・テーマ選び。計画: 方針 7（日付）・Task 27（重複とテーマ）

import { extractLinks } from "./count.mjs";

const JST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });

/** 日本時間の "YYYY-MM-DD"（日時は UTC で保存し、日付の判定だけ日本時間で行う） @param {Date} date */
export function jstDateKey(date) {
  return JST.format(date);
}

/**
 * 比べる前に、リンク・固定の文（クレジットや CTA）・空白を除く。
 * @param {string} text
 * @param {{ strip?: string[] }} [o]
 */
export function normalizeForCompare(text, o = {}) {
  let t = text;
  for (const l of extractLinks(t)) t = t.split(l).join(" ");
  for (const s of o.strip ?? []) if (s) t = t.split(s).join(" ");
  return t.replace(/\s+/g, " ").trim();
}

/** @param {string} s */
function trigrams(s) {
  const chars = [...s.replace(/\s+/g, "")];
  const set = new Set();
  for (let i = 0; i + 3 <= chars.length; i++) set.add(chars.slice(i, i + 3).join(""));
  if (set.size === 0 && chars.length) set.add(chars.join(""));
  return set;
}

/** 文字 3-gram の Jaccard 係数（0〜1） @param {string} a @param {string} b */
export function trigramJaccard(a, b) {
  const x = trigrams(a);
  const y = trigrams(b);
  if (!x.size && !y.size) return 1;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

/** 書き出し（最初の行） @param {string} text */
export function openingOf(text) {
  return (text.trim().split("\n")[0] ?? "").trim();
}

/**
 * 最近の投稿と比べた重複の判定。
 * exact: 本文が同じ / opening: 書き出しが同じ / similar: 3-gram の Jaccard が threshold 以上
 * @param {string} text
 * @param {string[]} recent
 * @param {{ threshold: number, strip?: string[] }} o
 * @returns {{ kind: "exact" | "opening" | "similar" | null, score: number }}
 */
export function checkDuplicate(text, recent, o) {
  const me = normalizeForCompare(text, o);
  const myOpening = openingOf(text);
  let best = 0;
  /** @type {"exact" | "opening" | "similar" | null} */
  let kind = null;
  for (const r of recent) {
    const other = normalizeForCompare(r, o);
    if (other === me) return { kind: "exact", score: 1 };
    if (myOpening && openingOf(r) === myOpening) kind = "opening";
    const s = trigramJaccard(me, other);
    if (s > best) best = s;
  }
  if (best >= o.threshold) return { kind: "similar", score: best };
  return { kind, score: best };
}

/**
 * 最近使っていないテーマを選ぶ。使い切ったら null（既出のテーマに戻らない）。
 * 同じ日に動かし直しても同じテーマになるよう、日本時間の日付で決める。
 * @param {string[]} pool
 * @param {string[]} recentThemes
 * @param {Date} now
 * @returns {string | null}
 */
export function pickTheme(pool, recentThemes, now) {
  const used = new Set(recentThemes);
  const fresh = pool.filter((t) => !used.has(t));
  if (!fresh.length) return null;
  const seed = Number(jstDateKey(now).replace(/-/g, ""));
  return fresh[seed % fresh.length];
}
