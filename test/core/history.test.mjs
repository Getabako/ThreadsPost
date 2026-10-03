import { test } from "node:test";
import assert from "node:assert/strict";
import { jstDateKey, normalizeForCompare, trigramJaccard, checkDuplicate, pickTheme, openingOf } from "../../core/history.mjs";

test("should use the Japan date, not the UTC date", () => {
  assert.equal(jstDateKey(new Date("2026-10-01T16:00:00Z")), "2026-10-02");
  assert.equal(jstDateKey(new Date("2026-10-01T14:59:59Z")), "2026-10-01");
});

test("should strip links, the credit and whitespace before comparing", () => {
  const a = normalizeForCompare("本文です\n\nhttps://a.jp\n\n#アシュラ秘奥義", { strip: ["#アシュラ秘奥義"] });
  assert.equal(a, "本文です");
});

test("should score identical texts 1 and unrelated texts low", () => {
  assert.equal(trigramJaccard("議事録をAIで清書した", "議事録をAIで清書した"), 1);
  assert.ok(trigramJaccard("議事録をAIで清書した", "今日は天気が良いので散歩") < 0.1);
});

test("should block exact duplicates and flag same openings and similar texts", () => {
  const recent = ["議事録の清書に毎回40分かかってた。\nAIに任せたら一瞬", "全然ちがう投稿です。天気の話"];
  assert.equal(checkDuplicate("議事録の清書に毎回40分かかってた。\nAIに任せたら一瞬", recent, { threshold: 0.5 }).kind, "exact");
  assert.equal(checkDuplicate("議事録の清書に毎回40分かかってた。\n別の展開です", recent, { threshold: 0.99 }).kind, "opening");
  assert.equal(checkDuplicate("議事録の清書に毎回40分かかってたけど、AIに任せたら一瞬", recent, { threshold: 0.5 }).kind, "similar");
  assert.equal(checkDuplicate("まったく新しい話題について書く", recent, { threshold: 0.5 }).kind, null);
});

test("should take the first line as the opening", () => {
  assert.equal(openingOf("一行目\n二行目"), "一行目");
});

test("should pick a theme not used recently and return null when exhausted", () => {
  const pool = ["A", "B", "C"];
  const t = pickTheme(pool, ["A", "B"], new Date("2026-10-02T00:00:00Z"));
  assert.equal(t, "C");
  assert.equal(pickTheme(pool, ["A", "B", "C"], new Date()), null);
});
