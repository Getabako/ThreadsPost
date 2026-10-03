// @ts-check
// 文字数・リンク数の数え方。ブラウザでも使うので node: の機能を使わない。
// 計画: Task 7・8。数え方は暫定で、M0 #2・#12（Threads 側の実測）で確定する。

export const TEXT_LIMIT = 500;
export const TEXT_WARN = 480;
export const LINK_LIMIT = 5;

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
const encoder = new TextEncoder();
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

/**
 * 書記素ごとに、絵文字（RGI_Emoji）は UTF-8 のバイト数、それ以外はコードポイント数で数える。
 * 公式の「絵文字は UTF-8 のバイト数で数える」に合わせた、多めに数える側の暫定ルール。
 * @param {string} text
 */
export function countThreadsChars(text) {
  let n = 0;
  for (const { segment } of segmenter.segment(text)) {
    n += RGI_EMOJI.test(segment) ? encoder.encode(segment).length : [...segment].length;
  }
  return n;
}

// スキームなしのドメインとして数える TLD（多めに数える側に倒す）
const TLDS = "com|net|org|jp|io|co|dev|app|ai|me|info|biz|tv|xyz|site|online|shop|blog|link|page|tokyo";

const LINK_PATTERN = new RegExp(
  [
    "https?:\\/\\/[^\\s<>「」『』（）()]+",
    "(?<![\\w@.\\/-])www\\.[^\\s<>「」『』（）()]+",
    `(?<![\\w@.\\/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?![a-z0-9-])(?:\\/[^\\s<>「」『』（）()]*)?`,
  ].join("|"),
  "giu",
);

/**
 * リンクを比べるための形。スキームと先頭の www を落とし、ホスト名だけ小文字にする。
 * パス・クエリの大文字小文字と末尾の「/」は区別する（別の資源を指しうるため、多めに数える側に倒す）。
 * @param {string} raw
 */
function normalizeLink(raw) {
  const t = raw.replace(/[。、，．！？!?,]+$/u, "").replace(/\.$/, "");
  const noScheme = t.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const i = noScheme.search(/[/?#]/);
  const host = (i < 0 ? noScheme : noScheme.slice(0, i)).toLowerCase();
  const rest = i < 0 ? "" : noScheme.slice(i);
  return host + rest;
}

/**
 * 本文に含まれるリンクを、重複を除いて返す。
 * @param {string} text
 * @returns {string[]}
 */
export function extractLinks(text) {
  const seen = new Map();
  for (const m of text.matchAll(LINK_PATTERN)) {
    const key = normalizeLink(m[0]);
    if (key && !seen.has(key)) seen.set(key, m[0]);
  }
  return [...seen.values()];
}

/** @param {string} text */
export function countLinks(text) {
  return extractLinks(text).length;
}
