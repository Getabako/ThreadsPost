import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDraft,
  normalizeCodexDraft,
  buildFinalPayload,
  validateFinalPayload,
  validateUploadImage,
  draftReadiness,
} from "../../core/validate.mjs";

const base = { kind: "text", text: "本文です" };

test("should accept a minimal text draft", () => {
  const r = parseDraft(base);
  assert.equal(r.ok, true);
});

test("should reject mismatched kind and image counts", () => {
  const img = (slot) => ({ slot, revision: null });
  for (const [kind, images] of [
    ["text", [img(1)]],
    ["image", [img(1), img(2)]],
    ["image", []],
    ["carousel", [img(1)]],
    ["carousel", Array.from({ length: 11 }, (_, i) => img(i + 1))],
  ]) {
    const r = parseDraft({ kind, text: "x", images });
    assert.equal(r.ok, false, `${kind} with ${images.length}`);
  }
});

test("should reject unknown fields in a stored draft", () => {
  const r = parseDraft({ ...base, extra: 1 });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.issues.some((i) => i.code === "unknown_field"));
});

test("should drop unknown fields from codex output", () => {
  const n = normalizeCodexDraft({ ...base, extra: 1, topicTag: "AI活用", images: [] });
  assert.deepEqual(Object.keys(n).sort(), ["kind", "text", "topicTag"].sort());
  assert.equal(parseDraft(n).ok, true);
});

test("should normalize codex image plans into slots without revisions", () => {
  const n = normalizeCodexDraft({
    kind: "carousel",
    text: "x",
    images: [
      { headline: "見出し1", body: "補足", prompt: "絵", altText: "説明", path: "../../etc" },
      { headline: "見出し2", body: "補足", prompt: "絵" },
    ],
  });
  assert.deepEqual(n.images?.map((i) => [i.slot, i.revision]), [[1, null], [2, null]]);
  assert.equal(/** @type {any} */ (n.images?.[0]).path, undefined);
});

test("should reject image references that are not registered job_images revisions", () => {
  const draft = { kind: "image", text: "x", images: [{ slot: 1, revision: 3 }] };
  const r = parseDraft(draft, { registeredImages: [{ slot: 1, revision: 1 }] });
  assert.equal(r.ok, false);
  assert.equal(parseDraft(draft, { registeredImages: [{ slot: 1, revision: 3 }] }).ok, true);
});

test("should reject duplicate or out of range slots", () => {
  const r = parseDraft({ kind: "carousel", text: "x", images: [{ slot: 1, revision: null }, { slot: 1, revision: null }] });
  assert.equal(r.ok, false);
  const r2 = parseDraft({ kind: "image", text: "x", images: [{ slot: 0, revision: null }] });
  assert.equal(r2.ok, false);
});

test("should reject topic tags containing dot or ampersand", () => {
  assert.equal(parseDraft({ ...base, topicTag: "A.I" }).ok, false);
  assert.equal(parseDraft({ ...base, topicTag: "A&B" }).ok, false);
  assert.equal(parseDraft({ ...base, topicTag: "x".repeat(51) }).ok, false);
  assert.equal(parseDraft({ ...base, topicTag: "AI活用" }).ok, true);
});

test("should reject an invalid reply control and a non-http link", () => {
  assert.equal(parseDraft({ ...base, replyControl: "nobody" }).ok, false);
  assert.equal(parseDraft({ ...base, link: { url: "javascript:alert(1)", place: "body" } }).ok, false);
  assert.equal(parseDraft({ ...base, link: { url: "https://if-juku.net", place: "reply" } }).ok, true);
});

test("should validate the main text after appending credit and body link", () => {
  const draft = { kind: "text", text: "あ".repeat(495) };
  const p = buildFinalPayload(/** @type {any} */ (draft), { credit: { text: "#アシュラ秘奥義", place: "body" } });
  const issues = validateFinalPayload(p);
  assert.ok(issues.some((i) => i.field === "main.text" && i.code === "too_long"));
  const p2 = buildFinalPayload(/** @type {any} */ (draft), { credit: null });
  assert.equal(validateFinalPayload(p2).length, 0);
});

test("should validate the reply text after appending link and credit", () => {
  const draft = { kind: "text", text: "本文", selfReplyText: "い".repeat(490), link: { url: "https://if-juku.net/ashura", place: "reply" } };
  const p = buildFinalPayload(/** @type {any} */ (draft), { credit: null });
  assert.ok(p.reply && p.reply.text.includes("https://if-juku.net/ashura"));
  assert.ok(validateFinalPayload(p).some((i) => i.field === "reply.text" && i.code === "too_long"));
});

test("should create a system credit reply when credit place is reply", () => {
  const p = buildFinalPayload(/** @type {any} */ (base), { credit: { text: "Made with アシュラ", place: "reply" } });
  assert.equal(p.reply?.text, "Made with アシュラ");
  assert.equal(p.main.text, "本文です");
});

test("should count links after appending the body link", () => {
  const text = "www.a.com www.b.com www.c.com www.d.com www.e.com";
  const p = buildFinalPayload(/** @type {any} */ ({ kind: "text", text, link: { url: "https://f.com", place: "body" } }), { credit: null });
  assert.ok(validateFinalPayload(p).some((i) => i.code === "too_many_links"));
});

test("should reject upload images that are not jpeg, too large, too narrow or too wide", () => {
  const ok = { format: "jpeg", width: 1080, height: 1350, bytes: 500_000 };
  assert.equal(validateUploadImage(ok).length, 0);
  assert.ok(validateUploadImage({ ...ok, format: "png" }).length > 0);
  assert.ok(validateUploadImage({ ...ok, bytes: 8 * 1024 * 1024 + 1 }).length > 0);
  assert.ok(validateUploadImage({ ...ok, width: 300 }).length > 0);
  assert.ok(validateUploadImage({ ...ok, width: 1441 }).length > 0);
  assert.ok(validateUploadImage({ ...ok, width: 1440, height: 100 }).length > 0);
});

test("draftReadiness should require generated images for image kinds", () => {
  const d = { kind: "carousel", text: "x", images: [{ slot: 1, revision: 1 }, { slot: 2, revision: null }] };
  const issues = draftReadiness(/** @type {any} */ (d));
  assert.ok(issues.some((i) => i.code === "image_not_generated"));
});

test("should drop the user's self reply and move a reply link into the body when user replies are not allowed", () => {
  const draft = { kind: "text", text: "本文", selfReplyText: "宣伝", link: { url: "https://if-juku.net", place: "reply" } };
  const p = buildFinalPayload(/** @type {any} */ (draft), { credit: { text: "#c", place: "body" }, allowUserReply: false });
  assert.equal(p.reply, null);
  assert.equal(p.main.text, "本文\n\nhttps://if-juku.net\n\n#c");
  const full = buildFinalPayload(/** @type {any} */ (draft), { credit: null, allowUserReply: true });
  assert.equal(full.reply?.text, "宣伝\n\nhttps://if-juku.net");
});

test("should accept photo slots with layout, tone and focus and check the photo belongs to the job", () => {
  const d = { kind: "image", text: "本文", images: [{ slot: 1, revision: null, photoId: "p0123456789ab", layout: "center", tone: "light", focus: "top", headline: "見出し" }] };
  assert.equal(parseDraft(d).ok, true);
  assert.equal(parseDraft(d, { registeredPhotos: ["p0123456789ab"] }).ok, true);
  assert.equal(parseDraft(d, { registeredPhotos: [] }).ok, false);
  for (const bad of [{ photoId: "../x" }, { layout: "left" }, { tone: "red" }, { focus: "middle" }]) {
    assert.equal(parseDraft({ ...d, images: [{ ...d.images[0], ...bad }] }).ok, false, JSON.stringify(bad));
  }
});

test("should keep the photo id from codex output and say a photo slot still needs its text", () => {
  const n = normalizeCodexDraft({ kind: "image", text: "x", images: [{ photoId: "p0123456789ab", headline: "a" }, { photoId: "not-valid", headline: "b" }] });
  assert.equal(n.images?.[0].photoId, "p0123456789ab");
  assert.equal(n.images?.[1].photoId, undefined);
  const r = draftReadiness(/** @type {any} */ ({ kind: "image", text: "x", images: [{ slot: 1, revision: null, photoId: "p0123456789ab" }] }));
  assert.match(r[0].message, /文字入れ/);
});
