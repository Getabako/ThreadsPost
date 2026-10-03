// @ts-check
// プロンプトの組み立て。投稿の作法とブランドは public/docs/*.md だけに書き、ここには直書きしない。
// 計画: 方針 15・Task 15・16

import fs from "node:fs";
import path from "node:path";

/** 構成チャットと無人の下書き作成で、Codex の最終応答を固定する JSON Schema（--output-schema） */
export const OUTLINE_SCHEMA = /** @type {const} */ ({
  type: "object",
  additionalProperties: false,
  required: ["reply", "draft"],
  properties: {
    reply: { type: "string", description: "利用者への短い返事（日本語・3 行以内）" },
    draft: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "text", "topicTag", "selfReplyText", "images"],
      properties: {
        kind: { type: "string", enum: ["text", "image", "carousel"] },
        text: { type: "string", description: "投稿の本文" },
        topicTag: { type: "string", description: "トピックタグ（# なし・1〜50 字・. と & は使わない）" },
        selfReplyText: { type: "string", description: "自分への返信に置く文。不要なら空文字" },
        images: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["headline", "body", "prompt", "altText", "photoId"],
            properties: {
              photoId: { type: "string", description: "利用者の写真に文字を載せる枠なら、その写真の ID。AI が絵を描く枠なら空文字" },
              headline: { type: "string", description: "画像に大きく描く見出し（15 字以内）" },
              body: { type: "string", description: "画像に描く補足（1 行 20〜28 字・最大 3 行）" },
              prompt: { type: "string", description: "絵柄の指示（日本語でよい）" },
              altText: { type: "string", description: "代替テキスト（1〜2 文）" },
            },
          },
        },
      },
    },
  },
});

/**
 * public/docs/*.md を名前順に読み、つなげて返す。
 * @param {{ appRoot: string }} o
 */
export function loadDocs({ appRoot }) {
  const dir = path.join(appRoot, "public", "docs");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n\n---\n\n");
}

/**
 * キャラクターの参照画像（キャラごとに 1 枚）。public/_brand/<キャラ名>_<表情>.png
 * @param {{ appRoot: string }} o
 * @returns {string[]}
 */
export function characterRefs({ appRoot }) {
  const dir = path.join(appRoot, "public", "_brand");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  } catch {
    return [];
  }
  const picked = new Map();
  for (const f of files) {
    const base = f.split("_")[0];
    const prefer = /_normal\.png$/.test(f);
    if (!picked.has(base) || prefer) picked.set(base, path.join(dir, f));
  }
  return [...picked.values()];
}

/** @param {any} brief */
function briefBlock(brief) {
  const kindLabel = { text: "テキストだけ", image: "画像 1 枚", carousel: `カルーセル ${brief.slideCount ?? 5} 枚` };
  return [
    `- テーマ: ${brief.theme ?? ""}`,
    `- 誰に向けて: ${brief.audience || "（おまかせ）"}`,
    `- トーン: ${brief.tone || "（おまかせ）"}`,
    `- 形式の希望: ${kindLabel[/** @type {"text"|"image"|"carousel"} */ (brief.kind ?? "text")] ?? "おまかせ"}`,
    brief.topicTagHint ? `- トピックタグの希望: ${brief.topicTagHint}` : "",
    brief.notes ? `- 補足: ${brief.notes}` : "",
    brief.link ? `- リンク: ${brief.link.url}（${brief.link.place === "body" ? "本文の最後に自動で付く" : "自分への返信に自動で付く"}。本文・返信の文には URL を書かない）` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const OUTPUT_RULES = `# 出力のしかた（厳守）

- 最後の応答は、指定の JSON の形だけを出す（前後に文を付けない）。
- draft.kind は形式（"text" / "image" / "carousel"）。image は images をちょうど 1 個、carousel は images を指定の枚数、text は images を空にする。
- draft.text は投稿の本文。500 字を超えない（目安 150〜300 字）。リンクやトピックタグは本文に書かない。
- draft.topicTag は 1 つだけ（# を付けない・「.」と「&」を使わない）。
- draft.selfReplyText は自分への返信に置く補足。不要なら空文字。
- images の各要素は、画像に描く見出し・補足・絵柄の指示・代替テキスト。
- reply は利用者への短い返事（何を作った／直したか）。`;

/**
 * 構成チャット（read-only）。会話の履歴と今の下書きを渡し、直した下書き全体を JSON で返させる。
 * photos があれば、利用者の写真（添付した順）に合わせて書かせる。
 * @param {{ brief: any, docs: string, history: Array<{ role: string, text: string }>, currentDraft: any, userMessage: string | null, limits: { kinds: string[] }, premiumPrompt?: string, photos?: Array<{ photoId: string }> }} o
 */
export function buildOutlinePrompt(o) {
  const kindsNote =
    o.limits.kinds.length === 1 && o.limits.kinds[0] === "text"
      ? `\n- この利用者が作れる形式は "text" だけ。draft.kind は必ず "text" にし、images は空にする。`
      : "";
  const history = o.history.length
    ? o.history.map((m) => `【${m.role === "user" ? "利用者" : "あなた"}】\n${m.text}`).join("\n\n")
    : "（まだありません）";
  const photos = o.photos ?? [];
  const photoBlock = photos.length
    ? `
# 利用者の写真（この投稿に使う・添付した画像と同じ順）

${photos.map((p, i) => `${i + 1}. ${p.photoId}`).join("\n")}

- 添付の写真を 1 枚ずつよく見て、写っているものに合う本文を書く。
- images は写真と同じ数・同じ順にし、各要素の photoId に上の ID を入れる。prompt は空文字にする。
- 各写真の headline（15 字以内）と body（1〜2 行）は、その写真の上に重ねる文字。写真の内容と合う、短くて読みやすいものにする。
- altText は、その写真に実際に写っているものを説明する（目の見えない人が読み上げで分かるように）。
- 写真は加工しない・描き直さない（文字は別の仕組みで重ねる）。写真に写っていないことを事実のように書かない。人の名前や場所を推測で書かない。
- 形式は、写真が 1 枚なら "image"、2 枚以上なら "carousel"。
`
    : "";
  return `# あなたの役割

Threads（Meta の SNS）の投稿を一緒に作る編集者です。下の「作法」を必ず守って、投稿の下書きを作ります。
ファイルの作成やコマンドの実行はせず、考えた結果を JSON で返してください。

# 作法

${o.docs}

# ブリーフ

${briefBlock(o.brief)}${kindsNote}
${photoBlock}
# これまでの会話

${history}

# 今の下書き

${o.currentDraft ? "```json\n" + JSON.stringify(o.currentDraft, null, 2) + "\n```" : "（まだありません。ブリーフから最初の下書きを作る）"}

# 利用者からの今回の依頼

${o.userMessage?.trim() || "ブリーフから最初の下書きを作ってください。"}

${OUTPUT_RULES}
${o.premiumPrompt ? `\n# 追加の方針\n\n${o.premiumPrompt}\n` : ""}`;
}

/**
 * 画像生成（workspace-write）。指定の枠の画像だけを作り、作業フォルダの images/slide-NN.png に保存させる。
 * @param {{ draft: import("./validate.mjs").Draft, slots: number[], docs: string, characterRefs: string[] }} o
 */
export function buildImagePrompt(o) {
  const imgs = (o.draft.images ?? []).filter((i) => o.slots.includes(i.slot));
  const list = imgs
    .map((i) => {
      const nn = String(i.slot).padStart(2, "0");
      return `## ${i.slot} 枚目 → images/slide-${nn}.png
- 見出し: ${i.headline ?? "（本文から決める）"}
- 補足: ${i.body ?? "（本文から決める）"}
- 絵柄: ${i.prompt ?? "（本文に合わせて決める）"}`;
    })
    .join("\n\n");
  const refs = o.characterRefs.length
    ? `# キャラクターの参照画像（見た目を揃える）

${o.characterRefs.map((p, i) => `- ref${i + 1}: ${p}`).join("\n")}

キャラクターを描く画像では、image_gen を呼ぶ直前に view_image で参照画像を読み直し、同じ人物・同じ画風・同じ服装で描く（表情とポーズだけ場面に合わせる）。`
    : "";
  return `# あなたへの作業指示

Threads の投稿に使う画像を作ります。下の「作法」を守ってください。

# 作法

${o.docs}

# 投稿の本文（参考）

${o.draft.text}

# 作る画像（この ${imgs.length} 枚だけ）

${list}

${refs}

# 作り方（厳守）

- 画像は Codex 内蔵の image_gen ツールだけで作る。OpenAI の API キー・SDK・curl・python の画像 API は使わない。
- サイズは 1080×1350（縦 4:5）。保存先は上に書いた images/slide-NN.png（作業フォルダの中）。images フォルダが無ければ作る。
- 文字は image_gen が絵と一緒に 1 回で描く。PIL・ImageMagick・HTML などで文字を後から載せない。
- 大きさの調整などで一時ファイルが要るときは、作業フォルダの中の .tmp を使う（例: mkdir -p .tmp && TMPDIR="$PWD/.tmp/" sips ...）。/tmp には書けない。
- 作業フォルダの外には何も書かない。
- 全部そろったら \`ls -la images\` で確かめ、最後に 1〜2 行で結果を報告する。`;
}

/**
 * 無人の下書き作成（workspace-write）。本文を決め、画像があれば作り、最後に下書きを JSON で返させる。
 * @param {{ theme: string, kind: "text"|"image"|"carousel", slideCount?: number, docs: string, characterRefs: string[], recentOpenings: string[], premiumPrompt?: string }} o
 */
export function buildAutoDraftPrompt(o) {
  const kindLine =
    o.kind === "text" ? "テキストだけ（images は空）" : o.kind === "image" ? "画像 1 枚" : `カルーセル ${o.slideCount ?? 5} 枚`;
  const images =
    o.kind === "text"
      ? ""
      : `
# 画像も作る

- 本文を決めたら、images の各要素に合わせて画像を作り、images/slide-01.png から順に保存する（1080×1350）。
- 画像は Codex 内蔵の image_gen だけで作る。文字は image_gen が絵と一緒に描く（後から載せない）。
- 一時ファイルは作業フォルダの .tmp を使う（TMPDIR="$PWD/.tmp/"）。/tmp と作業フォルダの外には書けない。
${o.characterRefs.length ? `- キャラクターの参照画像: ${o.characterRefs.join(" , ")}（描く直前に view_image で読み直し、見た目を揃える）` : ""}`;
  return `# あなたへの作業指示

Threads の投稿の下書きを 1 本作ります。投稿はしません（下書きだけ）。下の「作法」を必ず守ってください。

# 作法

${o.docs}

# 今回のテーマと形式

- テーマ: ${o.theme}
- 形式: ${kindLine}

# 最近の投稿の書き出し（同じ書き出しにしない）

${o.recentOpenings.length ? o.recentOpenings.map((s) => `- ${s}`).join("\n") : "（なし）"}
${images}

${OUTPUT_RULES}
${o.premiumPrompt ? `\n# 追加の方針\n\n${o.premiumPrompt}\n` : ""}`;
}
