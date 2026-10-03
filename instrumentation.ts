// サーバーの起動時に 1 回だけ呼ばれる（Next.js 16 の instrumentation）。
// 前回の起動中に止まった生成を「中断」にする（計画 方針 12）。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootRecover } = await import("./server/context.mjs");
    bootRecover();
  }
}
