"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  countChars,
  mediaUrl,
  photoUrl,
  uploadPhoto,
  type Brief,
  type Draft,
  type DraftImage,
  type JobSummary,
  type JobView,
  type Kind,
  type Layout,
  type Tone,
  type Focus,
  type Status,
} from "@/lib/client";
import {
  AshuraThinking,
  Card,
  CharacterDialog,
  Field,
  Notice,
  SectionTitle,
  SiteHeader,
  Stepper,
  inputCls,
  primaryBtn,
  secondaryBtn,
} from "./components/ui";

const STEPS = ["基本情報", "構成", "画像", "仕上げ"];
const REPLY_CONTROLS: Array<[string, string]> = [
  ["everyone", "だれでも"],
  ["accounts_you_follow", "自分がフォローしている人"],
  ["followers_only", "フォロワーだけ"],
  ["mentioned_only", "メンションした人だけ"],
  ["parent_post_author_only", "自分だけ"],
];
const KIND_LABEL: Record<Kind, string> = { text: "テキスト", image: "画像 1 枚", carousel: "カルーセル" };
const LAYOUT_OPTIONS: Array<[Layout, string]> = [
  ["bottom", "下に帯"],
  ["top", "上に帯"],
  ["center", "真ん中に枠"],
  ["none", "文字なし"],
];
const TONE_OPTIONS: Array<[Tone, string]> = [
  ["dark", "黒地に白い文字"],
  ["light", "白地に黒い文字"],
];
const FOCUS_OPTIONS: Array<[Focus, string]> = [
  ["center", "真ん中を残す"],
  ["top", "上を残す"],
  ["bottom", "下を残す"],
];
const selectCls = "rounded-xl border border-stone-300 px-3 py-2 text-base bg-white disabled:opacity-50";

type LogLine = { id: number; kind: string; message: string; at: string };

/** 開いたときに出す段: 下書きが無ければ構成、画像が残っていれば画像、それ以外は仕上げ */
function stepFor(v: JobView): number {
  const d = v.job.draft;
  if (!d) return 1;
  if (d.kind !== "text" && (d.images ?? []).some((i) => i.revision === null)) return 2;
  return 3;
}

function readJobFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("job");
}
function writeJobToUrl(jobId: string | null) {
  const u = new URL(window.location.href);
  if (jobId) u.searchParams.set("job", jobId);
  else u.searchParams.delete("job");
  window.history.replaceState(null, "", u.toString());
}

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [view, setView] = useState<JobView | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<Status>("GET", "/api/status"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const loadJobs = useCallback(async () => {
    try {
      setJobs((await api<{ jobs: JobSummary[] }>("GET", "/api/jobs")).jobs);
    } catch {
      /* 一覧が読めなくても続ける */
    }
  }, []);
  const loadView = useCallback(async (id: string) => {
    try {
      const v = await api<JobView>("GET", `/api/jobs/${id}`);
      setView(v);
      return v;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);

  useEffect(() => {
    api<Status>("GET", "/api/status")
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
    api<{ jobs: JobSummary[] }>("GET", "/api/jobs")
      .then((r) => setJobs(r.jobs))
      .catch(() => {});
    const id = readJobFromUrl();
    if (id) {
      api<JobView>("GET", `/api/jobs/${id}`)
        .then((v) => {
          setJobId(id);
          setView(v);
          setStep(stepFor(v));
        })
        .catch((e: Error) => setError(e.message));
    }
  }, []);

  // 進み具合（SSE）。生成が終わったら読み直す
  const running = view?.running ?? false;
  const lastEventId = view?.lastEventId ?? 0;
  const lastEventRef = useRef(lastEventId);
  useEffect(() => {
    lastEventRef.current = Math.max(lastEventRef.current, lastEventId);
  }, [lastEventId]);
  useEffect(() => {
    if (!jobId || !running) return;
    const es = new EventSource(`/api/jobs/${jobId}/events?after=${lastEventRef.current}`);
    es.addEventListener("job", (ev) => {
      const r = JSON.parse((ev as MessageEvent).data) as LogLine;
      lastEventRef.current = Math.max(lastEventRef.current, r.id);
      setLogs((p) => [...p.slice(-200), r]);
    });
    es.addEventListener("state", (ev) => {
      const s = JSON.parse((ev as MessageEvent).data) as { running: boolean };
      if (!s.running) {
        es.close();
        loadView(jobId);
        loadJobs();
      }
    });
    es.onerror = () => {
      es.close();
      setTimeout(() => loadView(jobId), 1500);
    };
    return () => es.close();
  }, [jobId, running, loadView, loadJobs]);

  const openJob = async (id: string) => {
    setError(null);
    setLogs([]);
    setJobId(id);
    writeJobToUrl(id);
    const v = await loadView(id);
    if (v) setStep(stepFor(v));
  };
  const newJob = () => {
    setJobId(null);
    setView(null);
    setLogs([]);
    setError(null);
    setStep(0);
    writeJobToUrl(null);
  };

  const draft = view?.job.draft ?? null;
  const maxReachable = !view ? 0 : !draft ? 1 : 3;

  return (
    <>
      <SiteHeader />
      <main className="min-h-screen">
        <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
          <SectionTitle title="Threads Post" subtitle="Codex（GPT-6.1 Sol）が Threads の投稿の下書き（本文・画像）を作るのじゃ。今は下書きまで。投稿は次の段階で対応する。" />
          {status && <StatusBanners status={status} onActivated={loadStatus} />}
          {error && (
            <Notice kind="error">
              {error}{" "}
              <button className="underline" onClick={() => setError(null)}>
                閉じる
              </button>
            </Notice>
          )}
          <Stepper
            step={step}
            labels={draft?.kind === "text" ? ["基本情報", "構成", "画像（なし）", "仕上げ"] : STEPS}
            maxReachable={maxReachable}
            onJump={(i) => setStep(i === 2 && draft?.kind === "text" ? 3 : i)}
          />

          {step === 0 && (
            <>
              <CharacterDialog ashura="まずは投稿のテーマを教えてくれぬか。誰に・どんな調子で届けたいかも一緒にじゃ。" mobuta="Threads は文章が中心なんだよね。まずはテキストで作ってみる！" />
              <Card step="Step 01" title="投稿の基本情報">
                <BriefForm
                  status={status}
                  onCreated={async (id) => {
                    await openJob(id);
                    setStep(1);
                    try {
                      await api("POST", `/api/jobs/${id}/outline`, { message: null });
                      await loadView(id);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                    loadJobs();
                  }}
                  onError={setError}
                />
              </Card>
            </>
          )}

          {step >= 1 && view && (
            <>
              {view.running && <Progress logs={logs} purpose={view.generation?.purpose} onCancel={() => api("POST", `/api/jobs/${view.job.jobId}/cancel`).catch(() => {})} />}
              {!view.running && view.generation && view.generation.status !== "completed" && (
                <Notice kind="warn">
                  前回の{view.generation.purpose === "images" ? "画像づくり" : "下書きづくり"}は終わりませんでした（{view.generation.status}
                  {view.generation.detail ? `：${view.generation.detail}` : ""}）。もう一度試してください。
                </Notice>
              )}
              {view.job.state === "frozen" && <Notice kind="info">この下書きは投稿を始めたので直せません。「複製して直す」を使ってください。</Notice>}
            </>
          )}

          {step === 1 && view && (
            <>
              <CharacterDialog
                ashura="下書きを作ったぞ。直してほしいところは遠慮なく言うのじゃ。本文を自分で直してもよい。"
                mobuta="冒頭の 1 行と、最後の問いかけが大事なんだよね。"
                ashuraSrc="/characters/ashura_suggest.png"
                mobutaSrc="/characters/mobuta_think.png"
              />
              <OutlineStep view={view} status={status} onChanged={() => loadView(view.job.jobId).then(() => loadJobs())} onError={setError} />
              {draft && (
                <div className="flex justify-end">
                  <button className={primaryBtn} onClick={() => setStep(draft.kind === "text" ? 3 : 2)}>
                    {draft.kind === "text" ? "仕上げへ →" : "画像へ →"}
                  </button>
                </div>
              )}
            </>
          )}

          {step === 2 && view && draft && (
            <>
              <CharacterDialog
                ashura={draft.images?.some((i) => i.photoId) ? "写真はそのままに、文字だけを重ねたぞ。置き場所や色を変えると、すぐ入れ直すのじゃ。" : "画像は 1 枚ずつ作るのじゃ。気に入らない 1 枚だけ作り直すこともできる。"}
                mobuta="画像は「見せた方が早い」ときだけ、だったよね。"
                ashuraSrc="/characters/ashura_think.png"
                mobutaSrc="/characters/mobuta_idea.png"
              />
              <ImagesStep view={view} status={status} onChanged={() => loadView(view.job.jobId)} onError={setError} />
              <div className="flex justify-between">
                <button className={secondaryBtn} onClick={() => setStep(1)}>
                  ← 構成へ
                </button>
                <button className={primaryBtn} onClick={() => setStep(3)}>
                  仕上げへ →
                </button>
              </div>
            </>
          )}

          {step === 3 && view && draft && (
            <>
              <CharacterDialog
                ashura="これが Threads に出る形じゃ。問題がなければ下書きの完成じゃ。"
                mobuta="投稿は次の段階なんだね。まずは下書きをためておこう！"
                ashuraSrc="/characters/ashura_happy.png"
                mobutaSrc="/characters/mobuta_happy.png"
              />
              <FinishStep
                view={view}
                onChanged={() => loadView(view.job.jobId).then(() => loadJobs())}
                onError={setError}
                onDuplicate={async () => {
                  try {
                    const r = await api<{ jobId: string }>("POST", `/api/jobs/${view.job.jobId}/duplicate`);
                    await openJob(r.jobId);
                    setStep(1);
                    loadJobs();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              />
              <div className="flex justify-between">
                <button className={secondaryBtn} onClick={() => setStep(draft.kind === "text" ? 1 : 2)}>
                  ← 戻る
                </button>
                <button className={secondaryBtn} onClick={newJob}>
                  新しい下書きを作る
                </button>
              </div>
            </>
          )}

          <DraftList
            jobs={jobs}
            currentId={jobId}
            onOpen={openJob}
            onNew={newJob}
            onDelete={async (id) => {
              if (!window.confirm("この下書きを消しますか？（保存した投稿パッケージのフォルダは残ります）")) return;
              try {
                await api("POST", `/api/jobs/${id}/delete`);
                if (id === jobId) newJob();
                loadJobs();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        </div>
      </main>
    </>
  );
}

// ---- 状態の案内 --------------------------------------------------------------

function StatusBanners({ status, onActivated }: { status: Status; onActivated: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const free = status.entitlement.mode === "free";
  const activate = async () => {
    if (!email.trim() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await api<{ activated: boolean; message: string }>("POST", "/api/activate", { email: email.trim() });
      setNotice({ ok: r.activated, text: r.message });
      if (r.activated) onActivated();
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      {!status.codex.loggedIn && (
        <Notice kind="error">
          Codex にログインしていません。ターミナルで <code className="px-1 bg-white rounded">codex login</code> を実行して ChatGPT アカウントでログインしてから、この画面を読み込み直してください。
        </Notice>
      )}
      <section className="rounded-3xl border border-stone-300 bg-white shadow-sm px-5 py-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`px-3 py-1 rounded-full text-sm font-bold text-white ${free ? "bg-stone-800" : "bg-emerald-600"}`}>{free ? "フリー版" : "フル版"}</span>
          <span className="text-sm text-stone-500">モデル: {status.model}</span>
          <span className="text-sm text-stone-500">段階: 下書きまで</span>
        </div>
        <p className="text-base text-stone-600 leading-[1.8]">{status.entitlement.message}</p>
        {free && (
          <div className="flex gap-2 flex-wrap">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") activate();
              }}
              placeholder="アシュラ会員の登録メールアドレス"
              className="flex-1 min-w-[240px] rounded-full border border-stone-300 px-5 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
            />
            <button onClick={activate} disabled={busy || !email.trim()} className={primaryBtn}>
              {busy ? "認証中…" : "会員認証"}
            </button>
          </div>
        )}
        {notice && <Notice kind={notice.ok ? "ok" : "warn"}>{notice.text}</Notice>}
      </section>
    </div>
  );
}

// ---- Step 1: ブリーフ ---------------------------------------------------------

function BriefForm({ status, onCreated, onError }: { status: Status | null; onCreated: (id: string) => void; onError: (m: string) => void }) {
  const [b, setB] = useState<Brief>({ theme: "", audience: "AI に興味を持ち始めた社会人・経営者", tone: "親しみやすく・具体的に", kind: "text", slideCount: 5 });
  const [linkUrl, setLinkUrl] = useState("");
  const [linkPlace, setLinkPlace] = useState<"body" | "reply">("reply");
  const [busy, setBusy] = useState(false);
  const [usePhotos, setUsePhotos] = useState(false);
  const [photos, setPhotos] = useState<File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const allowed = status?.entitlement.kinds ?? ["text"];
  const canPhotos = allowed.includes("image");
  const submit = async () => {
    if (!b.theme.trim() || busy) return;
    if (usePhotos && photos.length === 0) {
      onError("写真を 1 枚以上選んでください");
      return;
    }
    setBusy(true);
    try {
      const brief: Brief = { ...b, link: linkUrl.trim() ? { url: linkUrl.trim(), place: linkPlace } : undefined };
      if (usePhotos) brief.photoMode = true;
      if (brief.kind !== "carousel" || usePhotos) delete brief.slideCount;
      const r = await api<{ jobId: string }>("POST", "/api/jobs", { brief });
      if (usePhotos) {
        for (const [i, f] of photos.entries()) {
          setProgress(`写真を取り込んでいます（${i + 1} / ${photos.length}）…`);
          await uploadPhoto(r.jobId, f);
        }
      }
      setProgress(null);
      onCreated(r.jobId);
    } catch (e) {
      setProgress(null);
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <Field label="テーマ" hint="何について投稿するか。具体的なほど良い下書きになる">
        <textarea className={inputCls} rows={3} value={b.theme} onChange={(e) => setB({ ...b, theme: e.target.value })} placeholder="例: 議事録の清書を AI に任せたら毎回 40 分浮いた話" />
      </Field>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="誰に向けて">
          <input className={inputCls} value={b.audience ?? ""} onChange={(e) => setB({ ...b, audience: e.target.value })} />
        </Field>
        <Field label="トーン">
          <input className={inputCls} value={b.tone ?? ""} onChange={(e) => setB({ ...b, tone: e.target.value })} />
        </Field>
      </div>
      <Field label="自分の写真を使う" hint="写真はそのままに、上に見出しと補足を重ねます（写真を AI で描き直しません）。位置情報などは消して取り込みます">
        <div className="space-y-3">
          <label className={`inline-flex items-center gap-2 text-base ${canPhotos ? "" : "opacity-50"}`}>
            <input type="checkbox" checked={usePhotos} disabled={!canPhotos} onChange={(e) => setUsePhotos(e.target.checked)} className="w-5 h-5 accent-orange-500" />
            自分の写真に文字を入れて投稿する{!canPhotos && "（会員限定）"}
          </label>
          {usePhotos && (
            <div className="space-y-2">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                multiple
                onChange={(e) => setPhotos(Array.from(e.target.files ?? []).slice(0, 10))}
                className="block text-base"
              />
              <p className="text-sm text-stone-500">1〜10 枚（JPEG・PNG・HEIC・WebP、1 枚 25MB まで）。1 枚なら画像 1 枚、2 枚以上ならカルーセルになります。</p>
              {photos.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {photos.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="px-3 py-1 rounded-full bg-white border border-stone-200 text-sm text-stone-700">
                      {i + 1}. {f.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Field>
      {!usePhotos && (
      <Field label="形式" hint="Threads はテキストが中心。画像は見せた方が早いときに">
        <div className="flex gap-2 flex-wrap">
          {(["text", "image", "carousel"] as Kind[]).map((k) => {
            const ok = allowed.includes(k);
            return (
              <button
                key={k}
                type="button"
                disabled={!ok}
                onClick={() => setB({ ...b, kind: k })}
                className={`px-5 py-2 rounded-full border text-base ${b.kind === k ? "bg-orange-500 text-white border-orange-500" : "bg-white border-stone-300 text-stone-700"} disabled:opacity-40`}
                title={ok ? "" : "アシュラ会員限定"}
              >
                {KIND_LABEL[k]}
                {!ok && "（会員限定）"}
              </button>
            );
          })}
          {b.kind === "carousel" && (
            <select className="rounded-full border border-stone-300 px-4 py-2 text-base bg-white" value={b.slideCount} onChange={(e) => setB({ ...b, slideCount: Number(e.target.value) })}>
              {Array.from({ length: 9 }, (_, i) => i + 2).map((n) => (
                <option key={n} value={n}>
                  {n} 枚
                </option>
              ))}
            </select>
          )}
        </div>
      </Field>
      )}
      <Field label="トピックタグの希望（任意）" hint="1 つだけ。# は付けない。空なら AI が選ぶ">
        <input className={inputCls} value={b.topicTagHint ?? ""} onChange={(e) => setB({ ...b, topicTagHint: e.target.value })} placeholder="例: AI活用" />
      </Field>
      <Field label="リンク（任意）" hint="本文の最後に付けるか、自分への返信に置くかを選べる">
        <div className="flex gap-2 flex-wrap">
          <input className={`${inputCls} flex-1 min-w-[240px]`} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://..." />
          <select className="rounded-xl border border-stone-300 px-3 py-2 text-base bg-white" value={linkPlace} onChange={(e) => setLinkPlace(e.target.value as "body" | "reply")}>
            <option value="reply">自分への返信に置く</option>
            <option value="body">本文の最後に付ける</option>
          </select>
        </div>
      </Field>
      <Field label="補足（任意）" hint="入れたい事実・数字・避けたい表現など">
        <textarea className={inputCls} rows={2} value={b.notes ?? ""} onChange={(e) => setB({ ...b, notes: e.target.value })} />
      </Field>
      <div className="flex justify-end">
        {progress && <span className="text-sm text-stone-600 self-center mr-3">{progress}</span>}
        <button className={primaryBtn} disabled={!b.theme.trim() || busy} onClick={submit}>
          {busy ? "準備中…" : "下書きを作る →"}
        </button>
      </div>
    </div>
  );
}

// ---- 進み具合 ---------------------------------------------------------------

function Progress({ logs, purpose, onCancel }: { logs: LogLine[]; purpose?: string; onCancel: () => void }) {
  const last = logs.at(-1);
  return (
    <Card step="生成中" title={purpose === "images" ? "画像を作っています" : "下書きを作っています"} right={<button className={secondaryBtn} onClick={onCancel}>止める</button>}>
      <AshuraThinking message={purpose === "images" ? "アシュラが画像を描いているのじゃ…（1 枚 1〜3 分）" : "アシュラが考えているのじゃ…"} sub={last?.message} />
      {logs.length > 0 && (
        <details className="text-sm text-stone-500">
          <summary className="cursor-pointer">作業の記録（{logs.length}）</summary>
          <ul className="mt-2 space-y-1 max-h-48 overflow-auto font-mono text-xs">
            {logs.map((l) => (
              <li key={l.id} className="break-all">
                {l.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

// ---- Step 2: 構成（チャットと下書きの編集）-----------------------------------

function OutlineStep({ view, status, onChanged, onError }: { view: JobView; status: Status | null; onChanged: () => void; onError: (m: string) => void }) {
  const job = view.job;
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const editable = job.state === "draft" && !view.running;

  const send = async () => {
    if (sending || view.running) return;
    setSending(true);
    try {
      await api("POST", `/api/jobs/${job.jobId}/outline`, { message: message.trim() || null });
      setMessage("");
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Card step="Step 02" title="アシュラと相談する">
        <div className="space-y-3 max-h-80 overflow-auto pr-1">
          {job.chat.length === 0 && !view.running && <p className="text-stone-500 text-base">まだ会話はありません。</p>}
          {job.chat.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-base whitespace-pre-wrap ${m.role === "user" ? "bg-violet-600 text-white" : "bg-amber-50 border border-amber-200 text-stone-800"}`}>
                {m.text}
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <textarea
            className={`${inputCls} flex-1`}
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={job.draft ? "例: 冒頭をもっと具体的に / 200 字くらいに短く / 問いかけを変えて" : "最初の下書きを作るときは空のままで OK"}
            disabled={!editable || sending}
          />
          <button className={primaryBtn} disabled={!editable || sending} onClick={send}>
            {job.draft ? "直してもらう" : "作る"}
          </button>
        </div>
      </Card>
      {job.draft && <DraftEditor key={`${job.jobId}:${job.draftRevision}`} view={view} status={status} onChanged={onChanged} onError={onError} />}
    </>
  );
}

/** 下書きの編集欄。版が変わるたびに作り直す（key に版を入れる） */
function DraftEditor({ view, status, onChanged, onError }: { view: JobView; status: Status | null; onChanged: () => void; onError: (m: string) => void }) {
  const job = view.job;
  const [edit, setEdit] = useState<Draft | null>(job.draft);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const editable = job.state === "draft" && !view.running;

  const save = async () => {
    if (!edit) return;
    setSaving(true);
    try {
      const clean: Draft = { ...edit };
      if (!clean.topicTag?.trim()) delete clean.topicTag;
      if (!clean.selfReplyText?.trim()) delete clean.selfReplyText;
      if (!clean.link?.url?.trim()) delete clean.link;
      const v = await api<JobView>("PUT", `/api/jobs/${job.jobId}`, { draft: clean, expectedRevision: job.draftRevision });
      // 写真の枠の文字や置き場所を変えたら、その場で入れ直す
      if (v.job.draft?.images?.some((i) => i.photoId && i.revision === null)) {
        const r = await api<{ errors: Array<{ slot: number; reason: string }> }>("POST", `/api/jobs/${job.jobId}/render`, { slots: null });
        if (r.errors.length) onError(r.errors.map((e) => `${e.slot} 枚目: ${e.reason}`).join(" / "));
      }
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString("ja-JP"));
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      onError(err.issues?.length ? err.issues.map((i) => i.message).join(" / ") : err.message);
    } finally {
      setSaving(false);
    }
  };

  const set = (patch: Partial<Draft>) => {
    if (!edit) return;
    setEdit({ ...edit, ...patch });
    setDirty(true);
  };
  const setImg = (slot: number, patch: Partial<DraftImage>) => {
    if (!edit?.images) return;
    set({ images: edit.images.map((i) => (i.slot === slot ? { ...i, ...patch } : i)) });
  };

  const credit = status?.entitlement.credit;
  const textCount = edit ? countChars(edit.text) : 0;

  return (
    <>
      {edit && (
        <Card step="下書き" title="本文を整える" right={<span className="text-sm text-stone-500">版 {job.draftRevision}</span>}>
          <Field label="本文" hint={`目安 150〜300 字・上限 500 字${credit?.place === "body" ? `（フリー版は最後に「${credit.text}」が付く）` : ""}`}>
            <textarea className={inputCls} rows={8} value={edit.text} disabled={!editable} onChange={(e) => set({ text: e.target.value })} />
            <span className={`block text-right text-sm ${textCount > 500 ? "text-rose-600 font-bold" : textCount > 480 ? "text-amber-600" : "text-stone-500"}`}>{textCount} / 500 字（下書きの本文のみ）</span>
          </Field>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="トピックタグ" hint="1 つ・# なし・「.」「&」不可">
              <input className={inputCls} value={edit.topicTag ?? ""} disabled={!editable} onChange={(e) => set({ topicTag: e.target.value.replace(/^#/, "") })} />
            </Field>
            <Field label="返信できる人">
              <select className={inputCls} value={edit.replyControl ?? "everyone"} disabled={!editable} onChange={(e) => set({ replyControl: e.target.value })}>
                {REPLY_CONTROLS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="自分への返信（任意）" hint={status?.entitlement.mode === "free" ? "フリー版では自分への返信は使えません" : "補足やリンクの説明など"}>
            <textarea className={inputCls} rows={2} value={edit.selfReplyText ?? ""} disabled={!editable || status?.entitlement.mode === "free"} onChange={(e) => set({ selfReplyText: e.target.value })} />
          </Field>
          <Field label="リンク（任意）">
            <div className="flex gap-2 flex-wrap">
              <input
                className={`${inputCls} flex-1 min-w-[240px]`}
                value={edit.link?.url ?? ""}
                disabled={!editable}
                onChange={(e) => set({ link: { url: e.target.value, place: edit.link?.place ?? "reply" } })}
                placeholder="https://..."
              />
              <select
                className="rounded-xl border border-stone-300 px-3 py-2 text-base bg-white"
                value={edit.link?.place ?? "reply"}
                disabled={!editable}
                onChange={(e) => set({ link: { url: edit.link?.url ?? "", place: e.target.value as "body" | "reply" } })}
              >
                <option value="reply">自分への返信に置く</option>
                <option value="body">本文の最後に付ける</option>
              </select>
            </div>
          </Field>
          {edit.images && edit.images.length > 0 && (
            <div className="space-y-3">
              <div className="text-lg font-semibold text-stone-800">画像の中身（{edit.images.length} 枚）</div>
              {edit.images.map((img) => (
                <div key={img.slot} className="rounded-2xl border border-stone-200 bg-stone-50/60 p-3 space-y-2">
                  <div className="flex items-center gap-3">
                    {img.photoId && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={photoUrl(job.jobId, img.photoId)} alt="" className="w-14 h-14 rounded-lg object-cover border border-stone-200" />
                    )}
                    <div className="text-sm font-semibold text-stone-600">
                      {img.slot} 枚目{img.photoId ? "（あなたの写真に文字を重ねる）" : "（AI が描く）"}
                    </div>
                  </div>
                  <input className={inputCls} value={img.headline ?? ""} disabled={!editable} onChange={(e) => setImg(img.slot, { headline: e.target.value })} placeholder="見出し（15 字以内）" />
                  <textarea className={inputCls} rows={2} value={img.body ?? ""} disabled={!editable} onChange={(e) => setImg(img.slot, { body: e.target.value })} placeholder="補足" />
                  {img.photoId ? (
                    <PhotoControls img={img} disabled={!editable} onChange={(patch) => setImg(img.slot, patch)} />
                  ) : (
                    <input className={inputCls} value={img.prompt ?? ""} disabled={!editable} onChange={(e) => setImg(img.slot, { prompt: e.target.value })} placeholder="絵柄の指示" />
                  )}
                  <input className={inputCls} value={img.altText ?? ""} disabled={!editable} onChange={(e) => setImg(img.slot, { altText: e.target.value })} placeholder="代替テキスト（読み上げ用の説明）" />
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-end gap-3">
            {savedAt && !dirty && <span className="text-sm text-emerald-700">{savedAt} に保存しました</span>}
            {dirty && <span className="text-sm text-amber-700">保存していない変更があります</span>}
            <button className={primaryBtn} disabled={!editable || !dirty || saving} onClick={save}>
              {saving ? "保存中…" : "下書きを保存"}
            </button>
          </div>
        </Card>
      )}
    </>
  );
}

// ---- Step 3: 画像 -------------------------------------------------------------

function ImagesStep({ view, status, onChanged, onError }: { view: JobView; status: Status | null; onChanged: () => void; onError: (m: string) => void }) {
  const job = view.job;
  const draft = job.draft!;
  const images = draft.images ?? [];
  const missing = images.filter((i) => i.revision === null).length;
  const missingAi = images.filter((i) => i.revision === null && !i.photoId).length;
  const missingPhotos = images.filter((i) => i.revision === null && i.photoId).length;
  const canImages = (status?.entitlement.kinds ?? []).some((k) => k !== "text");
  /** 写真の枠に文字を入れる（その場で数秒） */
  const render = async (slots: number[] | null) => {
    try {
      const r = await api<{ rendered: Array<{ slot: number }>; errors: Array<{ slot: number; reason: string }> }>("POST", `/api/jobs/${job.jobId}/render`, { slots });
      if (r.errors.length) onError(r.errors.map((e) => `${e.slot} 枚目: ${e.reason}`).join(" / "));
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  /** 写真の置き場所などを変えて、すぐ入れ直す */
  const restyle = async (slot: number, patch: Partial<DraftImage>) => {
    try {
      const d: Draft = { ...draft, images: images.map((i) => (i.slot === slot ? { ...i, ...patch } : i)) };
      await api("PUT", `/api/jobs/${job.jobId}`, { draft: d, expectedRevision: job.draftRevision });
      await render([slot]);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const editable = job.state === "draft" && !view.running;
  const start = async (slots: number[] | null) => {
    try {
      await api("POST", `/api/jobs/${job.jobId}/images`, { slots });
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  /** 前に作った版に戻す（その枠の画像の版を選び直して保存） */
  const choose = async (slot: number, revision: number) => {
    try {
      const d: Draft = { ...draft, images: images.map((i) => (i.slot === slot ? { ...i, revision } : i)) };
      await api("PUT", `/api/jobs/${job.jobId}`, { draft: d, expectedRevision: job.draftRevision });
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <Card step="Step 03" title="画像を作る" right={<span className="text-sm text-stone-500">{images.length - missing} / {images.length} 枚</span>}>
      {!canImages && <Notice kind="warn">画像の生成はアシュラ会員限定です。上の欄から会員認証してください。</Notice>}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {images.map((img) => (
          <div key={img.slot} className="rounded-2xl border border-stone-200 bg-white overflow-hidden shadow-sm">
            <div className="aspect-[4/5] bg-stone-100 flex items-center justify-center">
              {img.revision ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={mediaUrl(job.jobId, img.slot, img.revision)} alt={img.altText ?? `${img.slot} 枚目`} className="w-full h-full object-cover" />
              ) : (
                <span className="text-stone-400 text-sm">まだありません</span>
              )}
            </div>
            <div className="p-2 space-y-1">
              <div className="text-sm font-semibold text-stone-700 truncate">
                {img.slot}. {img.headline ?? ""}
              </div>
              {img.photoId ? (
                <>
                  <PhotoControls img={img} disabled={!editable || !canImages} compact onChange={(patch) => restyle(img.slot, patch)} />
                  <button className="w-full text-sm rounded-full border border-stone-300 py-1.5 hover:bg-stone-50 disabled:opacity-40" disabled={!editable || !canImages} onClick={() => render([img.slot])}>
                    {img.revision ? "文字を入れ直す" : "文字を入れる"}
                  </button>
                </>
              ) : (
                <button className="w-full text-sm rounded-full border border-stone-300 py-1.5 hover:bg-stone-50 disabled:opacity-40" disabled={!editable || !canImages} onClick={() => start([img.slot])}>
                  {img.revision ? "この 1 枚だけ作り直す" : "この 1 枚を作る"}
                </button>
              )}
              {job.images.filter((x) => x.slot === img.slot).length > 1 && (
                <div className="flex gap-1 flex-wrap pt-1" title="前に作った版を選べます">
                  {job.images
                    .filter((x) => x.slot === img.slot)
                    .map((x) => (
                      <button
                        key={x.revision}
                        disabled={!editable || x.revision === img.revision}
                        onClick={() => choose(img.slot, x.revision)}
                        className={`w-9 h-11 rounded-md overflow-hidden border-2 ${x.revision === img.revision ? "border-orange-500" : "border-transparent opacity-70 hover:opacity-100"}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={mediaUrl(job.jobId, x.slot, x.revision)} alt={`版 ${x.revision}`} className="w-full h-full object-cover" />
                      </button>
                    ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-3 flex-wrap">
        {missingPhotos > 0 && (
          <button className={primaryBtn} disabled={!editable || !canImages} onClick={() => render(null)}>
            写真 {missingPhotos} 枚に文字を入れる
          </button>
        )}
        {(missingAi > 0 || missing === 0) && (
          <button className={primaryBtn} disabled={!editable || !canImages || missingAi === 0} onClick={() => start(null)}>
            {missingAi ? `まだ無い ${missingAi} 枚を AI で作る` : "すべて作成済み"}
          </button>
        )}
      </div>
    </Card>
  );
}

/** 写真の枠の、文字の置き場所・色・切り抜き */
function PhotoControls({ img, disabled, compact, onChange }: { img: DraftImage; disabled: boolean; compact?: boolean; onChange: (patch: Partial<DraftImage>) => void }) {
  const cls = compact ? `${selectCls} w-full text-sm py-1.5` : selectCls;
  return (
    <div className={compact ? "space-y-1" : "flex gap-2 flex-wrap"}>
      <select className={cls} value={img.layout ?? "bottom"} disabled={disabled} onChange={(e) => onChange({ layout: e.target.value as Layout })} aria-label="文字の置き場所">
        {LAYOUT_OPTIONS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <select className={cls} value={img.tone ?? "dark"} disabled={disabled} onChange={(e) => onChange({ tone: e.target.value as Tone })} aria-label="文字の色">
        {TONE_OPTIONS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <select className={cls} value={img.focus ?? "center"} disabled={disabled} onChange={(e) => onChange({ focus: e.target.value as Focus })} aria-label="写真の切り抜き">
        {FOCUS_OPTIONS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---- Step 4: 仕上げ（Threads 風のプレビュー）------------------------------

function FinishStep({ view, onDuplicate, onChanged, onError }: { view: JobView; onDuplicate: () => void; onChanged: () => void; onError: (m: string) => void }) {
  const { job, final, issues, readiness, counts } = view;
  const ok = issues.length === 0 && readiness.length === 0;
  const images = useMemo(() => (final?.main.images ?? []).filter((i) => i.revision !== null), [final]);
  if (!final) return null;
  return (
    <Card step="Step 04" title="仕上がりを確かめる">
      {ok ? <Notice kind="ok">下書きが完成しました。Threads の決まり（文字数・リンク数・トピックタグ）を満たしています。</Notice> : null}
      {issues.map((i, k) => (
        <Notice key={`i${k}`} kind="error">
          {i.field.startsWith("reply") ? "返信: " : "本文: "}
          {i.message}
        </Notice>
      ))}
      {readiness.map((i, k) => (
        <Notice key={`r${k}`} kind="warn">
          {i.message}
        </Notice>
      ))}

      <div className="rounded-3xl border border-stone-200 bg-white p-4 sm:p-5 shadow-sm">
        <div className="flex gap-3">
          <div className="shrink-0 w-11 h-11 rounded-full bg-amber-50 border border-amber-200 overflow-hidden">
            <Image src="/characters/ashura_normal.png" alt="" width={44} height={44} className="object-contain" />
          </div>
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center gap-2 text-base">
              <span className="font-bold text-stone-900">あなたのアカウント</span>
              {final.main.topicTag && <span className="text-stone-500">› {final.main.topicTag}</span>}
            </div>
            <div className="whitespace-pre-wrap text-[17px] leading-[1.7] text-stone-900 break-words">{final.main.text}</div>
            {images.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {images.map((i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i.slot} src={mediaUrl(job.jobId, i.slot, i.revision!)} alt={i.altText ?? ""} className={`${images.length === 1 ? "w-full max-w-sm" : "w-44"} aspect-[4/5] object-cover rounded-xl border border-stone-200`} />
                ))}
              </div>
            )}
            <div className="text-sm text-stone-400">
              返信できる人: {REPLY_CONTROLS.find(([v]) => v === final.main.replyControl)?.[1] ?? final.main.replyControl}
            </div>
          </div>
        </div>
        {final.reply && (
          <div className="flex gap-3 mt-4 pl-6 border-l-2 border-stone-200 ml-5">
            <div className="flex-1 min-w-0 space-y-1">
              <div className="text-sm font-bold text-stone-700">あなたのアカウント（自分への返信）</div>
              <div className="whitespace-pre-wrap text-base text-stone-800 break-words">{final.reply.text}</div>
            </div>
          </div>
        )}
      </div>

      {counts && (
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className={`rounded-xl border px-3 py-2 ${counts.main > 500 ? "border-rose-300 bg-rose-50" : "border-stone-200 bg-stone-50"}`}>本文: {counts.main} / 500 字・リンク {counts.mainLinks} / 5</div>
          <div className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2">返信: {final.reply ? `${counts.reply} / 500 字・リンク ${counts.replyLinks} / 5` : "なし"}</div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <CopyButton label="本文をコピー" text={final.main.text} />
        {final.reply && <CopyButton label="返信をコピー" text={final.reply.text} />}
        <button className={secondaryBtn} onClick={onDuplicate}>
          複製して別の案を作る
        </button>
      </div>

      <PackagePanel view={view} ready={ok} onChanged={onChanged} onError={onError} />
    </Card>
  );
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={secondaryBtn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* クリップボードが使えない環境 */
        }
      }}
    >
      {done ? "コピーしました" : label}
    </button>
  );
}

/** 投稿パッケージ（ローカル保存）。投稿（アップロード）は次の段階でこのパッケージを使う */
function PackagePanel({ view, ready, onChanged, onError }: { view: JobView; ready: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const job = view.job;
  const exp = view.export;
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api("POST", `/api/jobs/${job.jobId}/export`);
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      onError(err.issues?.length ? err.issues.map((i) => i.message).join(" / ") : err.message);
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    try {
      await api("POST", `/api/jobs/${job.jobId}/open-folder`);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 space-y-3">
      <div className="text-lg font-bold text-stone-800">投稿パッケージ（このパソコンに保存）</div>
      <p className="text-base text-stone-600 leading-[1.8]">
        本文・返信・Threads に送れる形に整えた画像（JPEG）・投稿情報を、アプリのフォルダの中の「Threads投稿」フォルダにまとめて保存します。インターネットには何も送りません。
      </p>
      {exp && (
        <div className="text-sm text-stone-600 break-all">
          保存先: <code className="px-1 bg-white rounded">{exp.dir}</code>（{new Date(exp.createdAt).toLocaleString("ja-JP")}）
        </div>
      )}
      {exp?.stale && <Notice kind="warn">保存した後に下書きを直しています。もう一度保存すると、同じフォルダが今の内容に更新されます。</Notice>}
      <div className="flex flex-wrap gap-3 justify-end">
        {exp && (
          <>
            <button className={secondaryBtn} onClick={open}>
              フォルダを開く
            </button>
            <a className={secondaryBtn} href={`/api/jobs/${job.jobId}/export.zip`}>
              ZIP でダウンロード
            </a>
          </>
        )}
        <button className={primaryBtn} disabled={!ready || busy || view.running || job.state !== "draft"} onClick={save}>
          {busy ? "保存中…" : exp ? (exp.stale ? "今の内容で保存し直す" : "もう一度保存する") : "パソコンに保存する"}
        </button>
        <button className={secondaryBtn} disabled title="Threads への投稿は次の段階で対応します">
          Threads に投稿（準備中）
        </button>
      </div>
    </div>
  );
}

// ---- 下書きの一覧 -------------------------------------------------------------

function DraftList({
  jobs,
  currentId,
  onOpen,
  onNew,
  onDelete,
}: {
  jobs: JobSummary[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="space-y-3 pt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-stone-800">下書きの一覧</h2>
        <button className={secondaryBtn} onClick={onNew}>
          ＋ 新しく作る
        </button>
      </div>
      {jobs.length === 0 && <p className="text-stone-500 text-base">まだ下書きはありません。</p>}
      <ul className="space-y-2">
        {jobs.map((j) => (
          <li key={j.jobId} className="relative">
            {j.state === "draft" && (
              <button
                onClick={() => onDelete(j.jobId)}
                className="absolute right-3 top-3 z-10 text-xs px-2.5 py-1 rounded-full border border-stone-300 bg-white text-stone-500 hover:text-rose-600 hover:border-rose-300"
                title="この下書きを消す"
              >
                消す
              </button>
            )}
            <button
              onClick={() => onOpen(j.jobId)}
              className={`w-full text-left rounded-2xl border px-4 py-3 bg-white/80 hover:bg-white shadow-sm ${j.jobId === currentId ? "border-orange-400 ring-2 ring-orange-100" : "border-stone-200"}`}
            >
              <div className="flex items-center gap-2 text-sm text-stone-500">
                <span>{new Date(j.updatedAt).toLocaleString("ja-JP")}</span>
                {j.kind && <span className="px-2 rounded-full bg-stone-100">{KIND_LABEL[j.kind]}</span>}
                {j.source === "cli" && <span className="px-2 rounded-full bg-sky-100 text-sky-800">無人実行</span>}
                {j.state === "frozen" && <span className="px-2 rounded-full bg-stone-800 text-white">投稿処理済み</span>}
              </div>
              <div className="text-base font-semibold text-stone-800 truncate">{j.theme ?? "（テーマなし）"}</div>
              {j.preview && <div className="text-sm text-stone-600 truncate">{j.preview}</div>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
