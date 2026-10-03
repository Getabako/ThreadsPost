import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDocs,
  characterRefs,
  buildOutlinePrompt,
  buildImagePrompt,
  buildAutoDraftPrompt,
  OUTLINE_SCHEMA,
} from "../../core/prompts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../..");

test("should load brand.md and threads-format.md from the app root", () => {
  const docs = loadDocs({ appRoot });
  assert.match(docs, /ブランドとキャラクター/);
  assert.match(docs, /Threads 投稿の作法/);
});

test("should pick one reference image per character with absolute paths", () => {
  const refs = characterRefs({ appRoot });
  assert.ok(refs.length >= 2);
  assert.ok(refs.every((p) => path.isAbsolute(p) && p.endsWith(".png")));
  const bases = refs.map((p) => path.basename(p).split("_")[0]);
  assert.equal(new Set(bases).size, bases.length);
});

test("should include the docs in every prompt", () => {
  const docs = "DOCS-MARKER";
  const brief = { theme: "議事録", audience: "社会人", tone: "やさしく", kind: "carousel", slideCount: 3 };
  const draft = { kind: "carousel", text: "本文", images: [{ slot: 1, revision: null, headline: "h", body: "b", prompt: "p" }, { slot: 2, revision: null }] };
  assert.match(buildOutlinePrompt({ brief, docs, history: [], currentDraft: null, userMessage: null, limits: { kinds: ["text", "image", "carousel"] } }), /DOCS-MARKER/);
  assert.match(buildImagePrompt({ draft: /** @type {any} */ (draft), slots: [1], docs, characterRefs: [] }), /DOCS-MARKER/);
  assert.match(buildAutoDraftPrompt({ theme: "t", kind: "text", docs, characterRefs: [], recentOpenings: [] }), /DOCS-MARKER/);
});

test("should not hard-code brand names in the prompt builder", () => {
  const src = fs.readFileSync(path.join(appRoot, "core/prompts.mjs"), "utf8");
  for (const s of ["if(塾)", "Ashura", "アシュラ", "モブ太"]) assert.ok(!src.includes(s), `found ${s}`);
});

test("should ask only for requested slots and tell where to save", () => {
  const draft = { kind: "carousel", text: "本文", images: [{ slot: 1, revision: 1, headline: "一" }, { slot: 2, revision: null, headline: "二" }] };
  const p = buildImagePrompt({ draft: /** @type {any} */ (draft), slots: [2], docs: "", characterRefs: ["/a/ashura.png"] });
  assert.match(p, /images\/slide-02\.png/);
  assert.ok(!p.includes("images/slide-01.png"));
  assert.match(p, /\/a\/ashura\.png/);
  assert.match(p, /TMPDIR/);
});

test("should restrict kinds in the outline prompt for free users", () => {
  const p = buildOutlinePrompt({ brief: { theme: "t", kind: "carousel" }, docs: "", history: [], currentDraft: null, userMessage: null, limits: { kinds: ["text"] } });
  assert.match(p, /"text" だけ/);
});

test("outline schema should require reply and draft with strict objects", () => {
  assert.deepEqual(OUTLINE_SCHEMA.required, ["reply", "draft"]);
  assert.equal(OUTLINE_SCHEMA.additionalProperties, false);
  const d = OUTLINE_SCHEMA.properties.draft;
  assert.equal(d.additionalProperties, false);
  assert.deepEqual([...d.required].sort(), Object.keys(d.properties).sort());
});

test("should list the user's photos with their ids in the outline prompt", () => {
  const p = buildOutlinePrompt({ brief: { theme: "t", photoMode: true }, docs: "", history: [], currentDraft: null, userMessage: null, limits: { kinds: ["text", "image", "carousel"] }, photos: [{ photoId: "p000000000001" }, { photoId: "p000000000002" }] });
  assert.match(p, /p000000000001/);
  assert.match(p, /加工しない|描き直さない/);
});
