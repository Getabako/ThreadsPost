// @ts-check
// ローカル API の認証。計画: 方針 11
//   - すべての /api は、Host がこの Mac（127.0.0.1 / localhost / ::1）で、Cookie の鍵が一致することを確かめる
//   - 状態を変える要求は、さらに Origin が同じで、ヘッダー X-ThreadsPost-Token が一致することを確かめる
//   - 鍵は GET /api/session で渡す（同じオリジンからの要求だけ。応答はほかのサイトから読めない）
// 計画からの変更: proxy.ts は Next.js 16 の文書で「グローバル変数の共有に頼らない」とされているため使わず、
// /api/session で Cookie と鍵を渡す。

import crypto from "node:crypto";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** @param {string | null} host */
function hostParts(host) {
  if (!host) return null;
  const m = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), port: m[2] ?? "80" };
}

/** @param {string} host */
export function cookieName(host) {
  const p = hostParts(host);
  return `tp_session_${p?.port ?? "0"}`;
}

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** @param {string} message */
const forbidden = (message) =>
  new Response(JSON.stringify({ error: message }), { status: 403, headers: { "content-type": "application/json; charset=utf-8" } });

/**
 * Host がこの Mac で、（分かっていれば）実際に待ち受けているポートと一致するか。
 * サーバーは 127.0.0.1 だけで待ち受ける（bin/cli.mjs・npm run dev）ので、Host を偽っても外からは届かない。
 * @param {Request} request @param {string | undefined} port
 */
function localHost(request, port) {
  const host = request.headers.get("host");
  const p = hostParts(host);
  if (!p || !LOCAL_HOSTS.has(p.name)) return null;
  if (port && p.port !== String(port)) return null;
  return /** @type {string} */ (host);
}

/** @param {string | null} cookieHeader @param {string} name */
function readCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/**
 * 読み取りの要求を確かめる。通れば null、通らなければ 403 の Response。
 * @param {Request} request
 * @param {{ sessionToken: string, port?: string }} o
 * @returns {Response | null}
 */
export function checkRead(request, { sessionToken, port }) {
  const host = localHost(request, port);
  if (!host) return forbidden("この Mac からの接続だけを受け付けます");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return forbidden("ほかのサイトからの要求は受け付けません");
  const c = readCookie(request.headers.get("cookie"), cookieName(host));
  if (!c || !safeEqual(c, sessionToken)) return forbidden("画面を読み込み直してください（認証が切れました）");
  return null;
}

/**
 * 状態を変える要求を確かめる。
 * @param {Request} request
 * @param {{ sessionToken: string, port?: string }} o
 * @returns {Response | null}
 */
export function checkWrite(request, { sessionToken, port }) {
  const r = checkRead(request, { sessionToken, port });
  if (r) return r;
  const host = /** @type {string} */ (localHost(request, port));
  const origin = request.headers.get("origin");
  if (!origin || origin !== `http://${host}`) return forbidden("ほかのサイトからの要求は受け付けません");
  const t = request.headers.get("x-threadspost-token");
  if (!t || !safeEqual(t, sessionToken)) return forbidden("画面を読み込み直してください（認証が切れました）");
  return null;
}

/**
 * GET /api/session: 同じオリジンの画面にだけ Cookie と鍵を渡す。
 * @param {Request} request
 * @param {{ sessionToken: string, port?: string }} o
 */
export function sessionResponse(request, { sessionToken, port }) {
  const host = localHost(request, port);
  if (!host) return forbidden("この Mac からの接続だけを受け付けます");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return forbidden("ほかのサイトからの要求は受け付けません");
  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${host}`) return forbidden("ほかのサイトからの要求は受け付けません");
  return new Response(JSON.stringify({ token: sessionToken }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": `${cookieName(host)}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
    },
  });
}
