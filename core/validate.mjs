// @ts-check
// 下書きの検査・Codex 出力の正規化・最終的な送信内容の組み立てと検査。
// ブラウザでも使うので node: の機能を使わない。計画: 「下書きの決まり」・Task 7・8

import { countThreadsChars, countLinks, TEXT_LIMIT, LINK_LIMIT } from "./count.mjs";

export const KINDS = /** @type {const} */ (["text", "image", "carousel"]);
export const REPLY_CONTROLS = /** @type {const} */ ([
  "everyone",
  "accounts_you_follow",
  "mentioned_only",
  "parent_post_author_only",
  "followers_only",
]);
export const CAROUSEL_MIN = 2;
export const CAROUSEL_MAX = 10;
export const ALT_TEXT_MAX = 1000;
export const TOPIC_TAG_MAX = 50;
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
/** 写真の枠: 文字の置き場所・色・切り抜き（core/overlay.mjs と同じ値） */
export const LAYOUTS = /** @type {const} */ (["bottom", "top", "center", "none"]);
export const TONES = /** @type {const} */ (["dark", "light"]);
export const FOCUSES = /** @type {const} */ (["center", "top", "bottom"]);
export const PHOTO_ID = /^p[0-9a-f]{12}$/;

/**
 * @typedef {{
 *   slot: number, revision: number | null, altText?: string, headline?: string, body?: string, prompt?: string,
 *   photoId?: string, layout?: "bottom" | "top" | "center" | "none", tone?: "dark" | "light", focus?: "center" | "top" | "bottom"
 * }} DraftImage
 * @typedef {{ url: string, place: "body" | "reply" }} DraftLink
 * @typedef {{
 *   kind: "text" | "image" | "carousel",
 *   text: string,
 *   topicTag?: string,
 *   replyControl?: string,
 *   images?: DraftImage[],
 *   link?: DraftLink,
 *   selfReplyText?: string
 * }} Draft
 * @typedef {{ code: string, field: string, message: string }} ValidationIssue
 * @typedef {{ text: string, place: "body" | "reply" }} Credit
 * @typedef {{
 *   main: { kind: Draft["kind"], text: string, topicTag: string | null, replyControl: string, images: Array<{ slot: number, revision: number | null, altText: string | null }> },
 *   reply: { text: string } | null
 * }} FinalPayload
 */

const DRAFT_KEYS = ["kind", "text", "topicTag", "replyControl", "images", "link", "selfReplyText"];
const IMAGE_KEYS = ["slot", "revision", "altText", "headline", "body", "prompt", "photoId", "layout", "tone", "focus"];

/** @param {string} code @param {string} field @param {string} message @returns {ValidationIssue} */
const issue = (code, field, message) => ({ code, field, message });

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 画像の枚数の決まり
 * @param {Draft["kind"]} kind
 */
export function imageCountRange(kind) {
  if (kind === "text") return { min: 0, max: 0 };
  if (kind === "image") return { min: 1, max: 1 };
  return { min: CAROUSEL_MIN, max: CAROUSEL_MAX };
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * 保存済みの下書きを厳密に検査する。
 * @param {unknown} raw
 * @param {{ registeredImages?: Array<{ slot: number, revision: number }>, registeredPhotos?: string[] }} [opts]
 * @returns {{ ok: true, draft: Draft } | { ok: false, issues: ValidationIssue[] }}
 */
export function parseDraft(raw, opts = {}) {
  /** @type {ValidationIssue[]} */
  const issues = [];
  if (!isObj(raw)) return { ok: false, issues: [issue("invalid", "draft", "下書きの形が正しくありません")] };

  for (const k of Object.keys(raw)) {
    if (!DRAFT_KEYS.includes(k)) issues.push(issue("unknown_field", k, `知らない項目「${k}」があります`));
  }

  const kind = raw.kind;
  if (typeof kind !== "string" || !KINDS.includes(/** @type {any} */ (kind))) {
    issues.push(issue("invalid_kind", "kind", "形式は text / image / carousel のどれかです"));
  }
  if (typeof raw.text !== "string" || raw.text.trim() === "") {
    issues.push(issue("required", "text", "本文が空です"));
  }

  if (raw.topicTag !== undefined) {
    const t = raw.topicTag;
    if (typeof t !== "string") issues.push(issue("invalid_type", "topicTag", "トピックタグは文字で指定します"));
    else if (t !== "" && ([...t].length > TOPIC_TAG_MAX || /[.&]/.test(t))) {
      issues.push(issue("invalid_topic_tag", "topicTag", "トピックタグは 1〜50 字で、「.」と「&」は使えません"));
    }
  }

  if (raw.replyControl !== undefined && !REPLY_CONTROLS.includes(/** @type {any} */ (raw.replyControl))) {
    issues.push(issue("invalid_reply_control", "replyControl", "返信できる人の設定が正しくありません"));
  }

  if (raw.link !== undefined) {
    const l = raw.link;
    if (!isObj(l) || typeof l.url !== "string" || !isHttpUrl(l.url) || (l.place !== "body" && l.place !== "reply")) {
      issues.push(issue("invalid_link", "link", "リンクは http(s) の URL と、置き場所（本文／返信）を指定します"));
    } else if (Object.keys(l).some((k) => k !== "url" && k !== "place")) {
      issues.push(issue("unknown_field", "link", "リンクに知らない項目があります"));
    }
  }

  if (raw.selfReplyText !== undefined && typeof raw.selfReplyText !== "string") {
    issues.push(issue("invalid_type", "selfReplyText", "返信の本文は文字で指定します"));
  }

  const images = raw.images ?? [];
  if (!Array.isArray(images)) {
    issues.push(issue("invalid_type", "images", "画像は配列で指定します"));
  } else {
    if (typeof kind === "string" && KINDS.includes(/** @type {any} */ (kind))) {
      const { min, max } = imageCountRange(/** @type {Draft["kind"]} */ (kind));
      if (images.length < min || images.length > max) {
        issues.push(
          issue(
            "image_count",
            "images",
            kind === "text"
              ? "テキスト投稿に画像は付けられません"
              : `画像は ${min === max ? `${min} 枚` : `${min}〜${max} 枚`}にしてください（今は ${images.length} 枚）`,
          ),
        );
      }
    }
    const slots = new Set();
    images.forEach((img, i) => {
      const f = `images[${i}]`;
      if (!isObj(img)) {
        issues.push(issue("invalid_type", f, "画像の形が正しくありません"));
        return;
      }
      for (const k of Object.keys(img)) {
        if (!IMAGE_KEYS.includes(k)) issues.push(issue("unknown_field", `${f}.${k}`, `画像に知らない項目「${k}」があります`));
      }
      const slot = img.slot;
      if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > CAROUSEL_MAX) {
        issues.push(issue("invalid_slot", `${f}.slot`, "画像の番号が正しくありません"));
      } else if (slots.has(slot)) {
        issues.push(issue("duplicate_slot", `${f}.slot`, `画像の番号 ${slot} が重複しています`));
      } else slots.add(slot);
      const rev = img.revision;
      if (rev !== null && (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1)) {
        issues.push(issue("invalid_revision", `${f}.revision`, "画像の版が正しくありません"));
      } else if (rev !== null && opts.registeredImages) {
        const found = opts.registeredImages.some((r) => r.slot === slot && r.revision === rev);
        if (!found) issues.push(issue("unregistered_image", `${f}.revision`, "登録されていない画像の版を指しています"));
      }
      if (img.altText !== undefined && (typeof img.altText !== "string" || [...img.altText].length > ALT_TEXT_MAX)) {
        issues.push(issue("invalid_alt_text", `${f}.altText`, `代替テキストは ${ALT_TEXT_MAX} 字以内です`));
      }
      for (const k of ["headline", "body", "prompt"]) {
        if (img[k] !== undefined && typeof img[k] !== "string") issues.push(issue("invalid_type", `${f}.${k}`, "文字で指定します"));
      }
      if (img.photoId !== undefined) {
        if (typeof img.photoId !== "string" || !PHOTO_ID.test(img.photoId)) {
          issues.push(issue("invalid_photo", `${f}.photoId`, "写真の指定が正しくありません"));
        } else if (opts.registeredPhotos && !opts.registeredPhotos.includes(img.photoId)) {
          issues.push(issue("unregistered_photo", `${f}.photoId`, "この下書きに取り込んでいない写真を指しています"));
        }
      }
      if (img.layout !== undefined && !LAYOUTS.includes(/** @type {any} */ (img.layout))) issues.push(issue("invalid_layout", `${f}.layout`, "文字の置き場所が正しくありません"));
      if (img.tone !== undefined && !TONES.includes(/** @type {any} */ (img.tone))) issues.push(issue("invalid_tone", `${f}.tone`, "文字の色が正しくありません"));
      if (img.focus !== undefined && !FOCUSES.includes(/** @type {any} */ (img.focus))) issues.push(issue("invalid_focus", `${f}.focus`, "写真の切り抜きの位置が正しくありません"));
    });
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, draft: /** @type {Draft} */ (raw) };
}

/**
 * Codex の出力から、決まった項目だけを取り出して下書きの形にする（そのまま API に渡さない）。
 * 画像は 1 から番号を振り直し、版は null（まだ生成していない）にする。
 * @param {unknown} raw
 * @returns {Draft}
 */
export function normalizeCodexDraft(raw) {
  const r = isObj(raw) ? raw : {};
  const kind = KINDS.includes(/** @type {any} */ (r.kind)) ? /** @type {Draft["kind"]} */ (r.kind) : "text";
  /** @type {Draft} */
  const d = { kind, text: typeof r.text === "string" ? r.text.trim() : "" };
  if (typeof r.topicTag === "string" && r.topicTag.trim()) d.topicTag = r.topicTag.trim().replace(/^#/, "");
  if (typeof r.replyControl === "string" && REPLY_CONTROLS.includes(/** @type {any} */ (r.replyControl))) {
    d.replyControl = r.replyControl;
  }
  if (typeof r.selfReplyText === "string" && r.selfReplyText.trim()) d.selfReplyText = r.selfReplyText.trim();
  if (isObj(r.link) && typeof r.link.url === "string" && (r.link.place === "body" || r.link.place === "reply")) {
    d.link = { url: r.link.url, place: r.link.place };
  }
  if (kind !== "text" && Array.isArray(r.images)) {
    d.images = r.images.filter(isObj).map((img, i) => {
      /** @type {DraftImage} */
      const out = { slot: i + 1, revision: null };
      for (const k of /** @type {const} */ (["altText", "headline", "body", "prompt"])) {
        if (typeof img[k] === "string" && img[k].trim()) out[k] = img[k].trim();
      }
      if (typeof img.photoId === "string" && PHOTO_ID.test(img.photoId)) out.photoId = img.photoId;
      return out;
    });
  }
  return d;
}

/**
 * クレジットと本文・返信のリンクを付けた、最終的な送信内容を作る。
 * @param {Draft} draft
 * @param {{ credit: Credit | null, allowUserReply?: boolean }} opts
 * @returns {FinalPayload}
 */
export function buildFinalPayload(draft, { credit, allowUserReply = true }) {
  // 自分への返信が使えない（フリー版）ときは、利用者の返信文を使わず、返信に置くリンクは本文の最後に回す
  const linkPlace = draft.link ? (allowUserReply ? draft.link.place : "body") : null;
  const mainParts = [draft.text.trim()];
  if (draft.link && linkPlace === "body") mainParts.push(draft.link.url);
  if (credit?.place === "body") mainParts.push(credit.text);

  const replyParts = [];
  if (allowUserReply && draft.selfReplyText?.trim()) replyParts.push(draft.selfReplyText.trim());
  if (draft.link && linkPlace === "reply") replyParts.push(draft.link.url);
  if (credit?.place === "reply") replyParts.push(credit.text);

  return {
    main: {
      kind: draft.kind,
      text: mainParts.join("\n\n"),
      topicTag: draft.topicTag?.trim() ? draft.topicTag.trim() : null,
      replyControl: draft.replyControl ?? "everyone",
      images: (draft.images ?? []).map((i) => ({ slot: i.slot, revision: i.revision, altText: i.altText ?? null })),
    },
    reply: replyParts.length ? { text: replyParts.join("\n\n") } : null,
  };
}

/**
 * @param {string} text
 * @param {string} field
 * @returns {ValidationIssue[]}
 */
function checkText(text, field) {
  /** @type {ValidationIssue[]} */
  const out = [];
  const n = countThreadsChars(text);
  if (n > TEXT_LIMIT) out.push(issue("too_long", field, `${TEXT_LIMIT} 字を超えています（${n} 字）`));
  const links = countLinks(text);
  if (links > LINK_LIMIT) out.push(issue("too_many_links", field, `リンクは ${LINK_LIMIT} 個までです（${links} 個）`));
  return out;
}

/**
 * 最終的な送信内容（本体と返信）を検査する。
 * @param {FinalPayload} payload
 * @returns {ValidationIssue[]}
 */
export function validateFinalPayload(payload) {
  const out = checkText(payload.main.text, "main.text");
  if (payload.reply) out.push(...checkText(payload.reply.text, "reply.text"));
  return out;
}

/**
 * 投稿できる状態か（画像がすべて生成済みか、など）。下書きの保存とは別の判定。
 * @param {Draft} draft
 * @returns {ValidationIssue[]}
 */
export function draftReadiness(draft) {
  /** @type {ValidationIssue[]} */
  const out = [];
  for (const img of draft.images ?? []) {
    if (img.revision === null) {
      out.push(
        issue(
          "image_not_generated",
          `images.${img.slot}`,
          img.photoId ? `${img.slot} 枚目の写真の文字入れがまだです（「文字を入れ直す」を押してください）` : `${img.slot} 枚目の画像がまだありません`,
        ),
      );
    }
  }
  return out;
}

/**
 * 正規化した後の、送る画像の検査。
 * @param {{ format: string, width: number, height: number, bytes: number }} m
 * @returns {ValidationIssue[]}
 */
export function validateUploadImage(m) {
  /** @type {ValidationIssue[]} */
  const out = [];
  if (m.format !== "jpeg") out.push(issue("not_jpeg", "image", "JPEG ではありません"));
  if (m.bytes > UPLOAD_MAX_BYTES) out.push(issue("too_large", "image", "8MB を超えています"));
  if (m.width < 320 || m.width > 1440) out.push(issue("bad_width", "image", "幅は 320〜1440px にしてください"));
  const ratio = Math.max(m.width, m.height) / Math.max(1, Math.min(m.width, m.height));
  if (ratio > 10) out.push(issue("bad_ratio", "image", "縦横比が 10:1 を超えています"));
  return out;
}
