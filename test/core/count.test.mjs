import { test } from "node:test";
import assert from "node:assert/strict";
import { countThreadsChars, countLinks, TEXT_LIMIT, LINK_LIMIT } from "../../core/count.mjs";

test("provisional: limits are 500 chars and 5 links", () => {
  assert.equal(TEXT_LIMIT, 500);
  assert.equal(LINK_LIMIT, 5);
});

const cases = [
  ["ascii", "hello", 5],
  ["japanese", "こんにちは", 5],
  ["newline counts as one", "a\nb", 3],
  ["url as characters", "https://a.jp", 12],
  ["simple emoji is utf-8 bytes", "😀", 4],
  ["flag is utf-8 bytes", "🇯🇵", 8],
  ["keycap is utf-8 bytes", "1️⃣", 7],
  ["bare copyright sign is a normal character", "©", 1],
  ["copyright with variation selector is emoji", "©️", 5],
  ["zwj family is utf-8 bytes", "👨‍👩‍👧", 18],
  ["skin tone is utf-8 bytes", "👍🏽", 8],
  ["combining character counts code points", "é", 2],
];
for (const [name, text, expected] of cases) {
  test(`provisional: ${name}`, () => {
    assert.equal(countThreadsChars(/** @type {string} */ (text)), expected);
  });
}

test("should count flags and keycaps as emoji and bare copyright sign as a normal character", () => {
  assert.equal(countThreadsChars("🇯🇵1️⃣©"), 8 + 7 + 1);
});

test("should count https, www and bare domain links once each", () => {
  assert.equal(countLinks("https://example.com と https://example.com"), 1);
  assert.equal(countLinks("www.facebook.com を見て"), 1);
  assert.equal(countLinks("詳しくは if-juku.net/ashura へ"), 1);
  assert.equal(countLinks("https://a.com www.b.com c.jp/x"), 3);
  assert.equal(countLinks("Node.js と next.config を使う"), 0);
  assert.equal(countLinks("連絡は info@if-juku.net まで"), 0);
});

test("should treat www and https forms of the same host as one link", () => {
  assert.equal(countLinks("https://www.example.com と www.example.com"), 1);
  assert.equal(countLinks("https://EXAMPLE.com/a と https://example.com/a"), 1);
});

test("should not merge links whose paths differ only in case or a trailing slash", () => {
  const urls = ["/a", "/A", "/b", "/B", "/c", "/C"].map((p) => `https://example.com${p}`).join(" ");
  assert.equal(countLinks(urls), 6);
  assert.equal(countLinks("https://example.com/x https://example.com/x/"), 2);
});
