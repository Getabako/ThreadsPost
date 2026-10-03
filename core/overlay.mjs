// @ts-check
// 写真に文字を重ねる。写真の画素は変えず、帯（パネル）と文字だけを上に合成する。
// 計画:「追加機能: 本物の写真に文字を入れる」方針 1・「文字の重ね方」

import fs from "node:fs";
import sharp from "sharp";

export const OUT_WIDTH = 1080;
export const OUT_HEIGHT = 1350;
const TEXT_WIDTH = 960;
const PAD_X = (OUT_WIDTH - TEXT_WIDTH) / 2;
const PAD_Y = 44;
const GAP = 18;
const MAX_PANEL_RATIO = 0.45;
const CENTER_MARGIN = 30;

/** macOS 標準のヒラギノ角ゴシック（見出しは W8、補足は W6） */
const FONT_DIR = "/System/Library/Fonts";
const HEAD_FONT = `${FONT_DIR}/ヒラギノ角ゴシック W8.ttc`;
const BODY_FONT = `${FONT_DIR}/ヒラギノ角ゴシック W6.ttc`;

export const LAYOUTS = /** @type {const} */ (["bottom", "top", "center", "none"]);
export const TONES = /** @type {const} */ (["dark", "light"]);
export const FOCUSES = /** @type {const} */ (["center", "top", "bottom"]);

export class OverlayError extends Error {
  /** @param {string} m */
  constructor(m) {
    super(m);
    this.name = "OverlayError";
  }
}

/** Pango のマークアップで意味を持つ文字を逃がす @param {string} s */
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 文字を透明な画像として描く
 * @param {string} text @param {{ file: string, size: number, color: string, weight: "heavy" | "bold" }} f
 * @returns {Promise<{ data: Buffer, width: number, height: number } | null>}
 */
async function textImage(text, f) {
  if (!text.trim()) return null;
  const fontfile = fs.existsSync(f.file) ? f.file : undefined;
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${f.color}" weight="${f.weight}">${esc(text.trim())}</span>`,
      font: `Hiragino Sans ${f.size}`,
      fontfile,
      rgba: true,
      width: TEXT_WIDTH,
      wrap: "word-char",
      spacing: Math.round(f.size * 0.35),
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * 写真を 1080×1350 に切り抜き、見出しと補足を重ねた PNG を返す。
 * @param {{ photoPath: string, headline: string, body: string, layout: typeof LAYOUTS[number], tone: typeof TONES[number], focus: typeof FOCUSES[number] }} o
 * @returns {Promise<Buffer>}
 */
export async function renderOverlay(o) {
  const position = o.focus === "top" ? "north" : o.focus === "bottom" ? "south" : "centre";
  const base = await sharp(o.photoPath).resize(OUT_WIDTH, OUT_HEIGHT, { fit: "cover", position }).toColorspace("srgb").png().toBuffer();
  const headline = (o.headline ?? "").trim();
  const body = (o.body ?? "").trim();
  if (o.layout === "none" || (!headline && !body)) return base;

  const color = o.tone === "light" ? "#1c1917" : "#ffffff";
  const maxPanel = Math.floor(OUT_HEIGHT * MAX_PANEL_RATIO);
  /** @type {{ head: Awaited<ReturnType<typeof textImage>>, bodyImg: Awaited<ReturnType<typeof textImage>>, panelH: number } | null} */
  let fit = null;
  for (let step = 0; step < 12 && !fit; step++) {
    const headSize = Math.max(44, 72 - step * 4);
    const bodySize = Math.max(30, 40 - step * 2);
    const head = await textImage(headline, { file: HEAD_FONT, size: headSize, color, weight: "heavy" });
    const bodyImg = await textImage(body, { file: BODY_FONT, size: bodySize, color, weight: "bold" });
    const inner = (head?.height ?? 0) + (head && bodyImg ? GAP : 0) + (bodyImg?.height ?? 0);
    const panelH = inner + PAD_Y * 2;
    if (panelH <= maxPanel) fit = { head, bodyImg, panelH };
  }
  if (!fit) throw new OverlayError("文字が多すぎて写真に収まりません。見出しか補足を短くしてください。");

  const panelW = o.layout === "center" ? OUT_WIDTH - CENTER_MARGIN * 2 : OUT_WIDTH;
  const panelX = o.layout === "center" ? CENTER_MARGIN : 0;
  const panelY = o.layout === "top" ? 0 : o.layout === "bottom" ? OUT_HEIGHT - fit.panelH : Math.round((OUT_HEIGHT - fit.panelH) / 2);
  const fill = o.tone === "light" ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.8)";
  const radius = o.layout === "center" ? 28 : 0;
  const panel = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${panelW}" height="${fit.panelH}"><rect x="0" y="0" width="${panelW}" height="${fit.panelH}" rx="${radius}" ry="${radius}" fill="${fill}"/></svg>`,
  );

  /** @type {import("sharp").OverlayOptions[]} */
  const layers = [{ input: panel, left: panelX, top: panelY }];
  let y = panelY + PAD_Y;
  if (fit.head) {
    layers.push({ input: fit.head.data, left: PAD_X, top: y });
    y += fit.head.height + GAP;
  }
  if (fit.bodyImg) layers.push({ input: fit.bodyImg.data, left: PAD_X, top: y });
  return sharp(base).composite(layers).png().toBuffer();
}
