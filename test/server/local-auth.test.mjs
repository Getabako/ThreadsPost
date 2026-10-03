import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRead, checkWrite, sessionResponse, cookieName } from "../../server/local-auth.mjs";

const token = "t".repeat(64);
const base = "http://127.0.0.1:4593";

/** @param {string} path @param {RequestInit & { headers?: Record<string, string> }} [init] */
const req = (path, init = {}) => new Request(base + path, init);

test("should name the cookie with the port so two servers do not clash", () => {
  assert.equal(cookieName("127.0.0.1:4593"), "tp_session_4593");
  assert.equal(cookieName("localhost:4600"), "tp_session_4600");
});

test("should issue the session cookie and token only to same-origin requests on a local host", async () => {
  const ok = sessionResponse(req("/api/session", { headers: { host: "127.0.0.1:4593", "sec-fetch-site": "same-origin" } }), { sessionToken: token });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie") ?? "", /tp_session_4593=.+HttpOnly.*SameSite=Strict/i);
  assert.equal((await ok.json()).token, token);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const cross = sessionResponse(req("/api/session", { headers: { host: "127.0.0.1:4593", "sec-fetch-site": "cross-site" } }), { sessionToken: token });
  assert.equal(cross.status, 403);
  const rebinding = sessionResponse(req("/api/session", { headers: { host: "evil.example:4593" } }), { sessionToken: token });
  assert.equal(rebinding.status, 403);
});

test("should reject any api request without the session cookie, including GET", () => {
  const r = checkRead(req("/api/jobs", { headers: { host: "127.0.0.1:4593" } }), { sessionToken: token });
  assert.equal(r?.status, 403);
  const ok = checkRead(req("/api/jobs", { headers: { host: "127.0.0.1:4593", cookie: `tp_session_4593=${token}` } }), { sessionToken: token });
  assert.equal(ok, null);
});

test("should reject a foreign Origin and a rebinding Host", () => {
  const h = { cookie: `tp_session_4593=${token}`, "x-threadspost-token": token, "content-type": "application/json" };
  assert.equal(checkRead(req("/api/jobs", { headers: { ...h, host: "evil.example:4593" } }), { sessionToken: token })?.status, 403);
  assert.equal(checkWrite(req("/api/jobs", { method: "POST", headers: { ...h, host: "127.0.0.1:4593", origin: "http://evil.example" } }), { sessionToken: token })?.status, 403);
  assert.equal(checkWrite(req("/api/jobs", { method: "POST", headers: { ...h, host: "127.0.0.1:4593", origin: base } }), { sessionToken: token }), null);
});

test("should require the header token for state-changing requests", () => {
  const h = { host: "127.0.0.1:4593", origin: base, cookie: `tp_session_4593=${token}` };
  assert.equal(checkWrite(req("/api/jobs", { method: "POST", headers: h }), { sessionToken: token })?.status, 403);
  assert.equal(checkWrite(req("/api/jobs", { method: "POST", headers: { ...h, "x-threadspost-token": "wrong" } }), { sessionToken: token })?.status, 403);
});

test("should reject a Host whose port is not the listening port", () => {
  const h = { host: "127.0.0.1:9999", cookie: `tp_session_9999=${token}` };
  assert.equal(checkRead(new Request("http://127.0.0.1:9999/api/jobs", { headers: h }), { sessionToken: token, port: "4593" })?.status, 403);
  const ok = { host: "127.0.0.1:4593", cookie: `tp_session_4593=${token}` };
  assert.equal(checkRead(new Request("http://127.0.0.1:4593/api/jobs", { headers: ok }), { sessionToken: token, port: "4593" }), null);
  const s = sessionResponse(new Request("http://127.0.0.1:9999/api/session", { headers: { host: "127.0.0.1:9999" } }), { sessionToken: token, port: "4593" });
  assert.equal(s.status, 403);
});
