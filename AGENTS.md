## この奥義の使い方（AI モード / UI モード）— 最初の返答で一言案内する

「この奥義は 2 通りで使えます。**AI モード**: このチャットに『〇〇の Threads 投稿の下書きを作って』と頼む。**UI モード**: 『起動して』と送ると操作画面がブラウザで開きます。」

- **UI モード**: 「起動して」「画面を開いて」と言われたら、手順を組み立てずに `bash ashura-start.sh` を実行し、最後の `ASHURA_URL=...` を「起動しました: URL」と 1 行で報告する。失敗したときだけ、出力と `.ashura/server.log` を読んで直し、もう一度実行する。停止は `bash ashura-start.sh stop`。
- **AI モード**: 下書きを作るときは `node scripts/auto-post.mjs --theme="…" --kind=text` を使う（アシュラ会員のみ）。できた下書きは画面の「下書きの一覧」で確かめてもらう。

## 守ること

- **Threads への投稿は、人間の承認なしに行わない。** 今の段階（第一段階の前半）は下書きまで。`--publish` は未対応（終了コード 2）。コードは 2026-10-07 にアシュラ奥義「Threads Post」として Getabako/ThreadsPost で配布を始めた
- AI が Threads API を直接呼ばない。投稿は、第一段階の後半で作る `core/runner.mjs` だけが行う
- Codex のモデルは `gpt-6.1-sol`（`core/codex.mjs` の `CODEX_MODEL`）。`gpt-6-sol`・`gpt-6-astra`・`gpt-5.5` は使わない
- 有料の API キー（OpenAI API など）で文章・画像を作らない。画像は Codex 内蔵の image_gen だけ
- 投稿の作法・ブランドは `public/docs/*.md` だけに書く。コード（`core/prompts.mjs`）に直書きしない
- 計画書 `../plans/20261002-threads-post-phase1.md` と違うことをするときは、止めて人間に相談する

## 開発の作法

- 中核は `core/*.mjs`（素の ESM + JSDoc + `// @ts-check`）。Next.js の API（`app/api/**/route.ts`）は `server/handlers.mjs` を呼ぶだけ
- テストは `npm test`（node:test）。偽の Codex（`test/fixtures/fake-codex.mjs`）で動き、本物は呼ばない
- 変更の後は `npm test`・`npm run type-check`・`npm run lint`・`npm run build` を通す

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
