"use client";
// 画面からの API 呼び出し。起動ごとの鍵を /api/session で受け取り、状態を変える要求にヘッダーで付ける。

export type Kind = "text" | "image" | "carousel";
export type Layout = "bottom" | "top" | "center" | "none";
export type Tone = "dark" | "light";
export type Focus = "center" | "top" | "bottom";
export type DraftImage = {
  slot: number;
  revision: number | null;
  altText?: string;
  headline?: string;
  body?: string;
  prompt?: string;
  photoId?: string;
  layout?: Layout;
  tone?: Tone;
  focus?: Focus;
};
export type Draft = {
  kind: Kind;
  text: string;
  topicTag?: string;
  replyControl?: string;
  images?: DraftImage[];
  link?: { url: string; place: "body" | "reply" };
  selfReplyText?: string;
};
export type Brief = {
  theme: string;
  audience?: string;
  tone?: string;
  kind?: Kind;
  slideCount?: number;
  topicTagHint?: string;
  notes?: string;
  link?: { url: string; place: "body" | "reply" };
  photoMode?: boolean;
};
export type Issue = { code: string; field: string; message: string };
export type JobImage = { slot: number; revision: number; sha256: string; isCurrent: boolean; createdAt: string };
export type Job = {
  jobId: string;
  source: "ui" | "cli";
  theme: string | null;
  brief: Brief;
  draft: Draft | null;
  draftRevision: number;
  state: "draft" | "frozen";
  copiedFromJobId: string | null;
  createdAt: string;
  updatedAt: string;
  images: JobImage[];
  chat: Array<{ role: "user" | "assistant"; text: string; createdAt: string }>;
};
export type FinalPayload = {
  main: { kind: Kind; text: string; topicTag: string | null; replyControl: string; images: Array<{ slot: number; revision: number | null; altText: string | null }> };
  reply: { text: string } | null;
};
export type JobView = {
  job: Job;
  final: FinalPayload | null;
  issues: Issue[];
  readiness: Issue[];
  counts: { main: number; mainLinks: number; reply: number; replyLinks: number } | null;
  generation: { gen_id: string; purpose: string; status: string; detail: string | null; started_at: string; ended_at: string | null } | null;
  running: boolean;
  lastEventId: number;
  export: { dir: string; draftRevision: number; createdAt: string; payloadSha256: string; stale: boolean } | null;
  photos: Array<{ photoId: string; width: number; height: number; createdAt: string }>;
};
export type JobSummary = {
  jobId: string;
  source: "ui" | "cli";
  theme: string | null;
  kind: Kind | null;
  preview: string | null;
  draftRevision: number;
  state: "draft" | "frozen";
  createdAt: string;
  updatedAt: string;
};
export type Status = {
  entitlement: { mode: "full" | "free"; message: string; kinds: Kind[]; credit: { text: string; place: "body" | "reply" } | null };
  codex: { loggedIn: boolean; detail: string };
  model: string;
  stage: string;
};

let token: string | null = null;

export async function ensureSession(): Promise<string> {
  if (token) return token;
  const r = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
  if (!r.ok) throw new Error("画面の認証に失敗しました。読み込み直してください。");
  token = ((await r.json()) as { token: string }).token;
  return token;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  issues?: Issue[];
  constructor(message: string, status: number, code?: string, issues?: Issue[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export async function api<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const t = await ensureSession();
  const r = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: method === "GET" ? {} : { "content-type": "application/json", "x-threadspost-token": t },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(data.error ?? `エラー（${r.status}）`, r.status, data.code, data.issues);
  return data as T;
}

/** 写真を 1 枚取り込む（ファイルの中身をそのまま送る） */
export async function uploadPhoto(jobId: string, file: File): Promise<{ photoId: string; width: number; height: number }> {
  const t = await ensureSession();
  const r = await fetch(`/api/jobs/${jobId}/photos`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": file.type || "application/octet-stream", "x-threadspost-token": t },
    body: file,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(`${file.name}: ${data.error ?? `エラー（${r.status}）`}`, r.status, data.code);
  return data.photo;
}

export function photoUrl(jobId: string, photoId: string) {
  return `/api/jobs/${jobId}/photos/${photoId}`;
}

export function mediaUrl(jobId: string, slot: number, revision: number) {
  return `/api/media/${jobId}/${slot}/${revision}`;
}

/** 文字数の数え方は core/count.mjs と同じ関数を使う（画面・API・CLI で同じ数になるように） */
export { countThreadsChars as countChars } from "@/core/count.mjs";
