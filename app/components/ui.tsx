"use client";
// 画面の部品（InstagramPost のデザインを踏襲）

import Image from "next/image";
import { useEffect, useState } from "react";

export const inputCls =
  "w-full bg-white border border-stone-300 rounded-xl px-4 py-3 text-lg text-stone-800 placeholder:text-stone-400 focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100 transition";
export const primaryBtn =
  "px-6 py-2.5 rounded-full text-lg font-semibold text-white bg-gradient-to-r from-orange-500 to-red-500 shadow-md hover:shadow-lg transition disabled:opacity-40 disabled:shadow-none";
export const secondaryBtn =
  "px-5 py-2.5 rounded-full text-base font-medium bg-white border border-stone-300 text-stone-700 shadow-sm hover:bg-stone-50 disabled:opacity-40";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 bg-white/75 backdrop-blur border-b border-stone-200 shadow-sm">
      <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-stone-900 text-white font-bold flex items-center justify-center text-sm tracking-wider">@</div>
          <div className="leading-tight">
            <div className="text-lg font-bold text-stone-800">Threads Post</div>
            <div className="text-xs text-stone-500">AI で Threads の投稿の下書きを作る</div>
          </div>
        </div>
        <div className="px-3 py-1 rounded-full text-xs font-semibold tracking-wider text-white bg-gradient-to-r from-orange-500 to-red-500 shadow-sm">Ashura</div>
      </div>
    </header>
  );
}

export function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-full bg-amber-50 border border-amber-200 p-1 flex items-center justify-center overflow-hidden">
          <Image src="/characters/ashura_normal.png" alt="アシュラ" width={48} height={48} className="object-contain" />
        </div>
        <h1 className="text-3xl font-bold text-orange-600">{title}</h1>
      </div>
      {subtitle && <p className="text-base text-stone-600 pl-1">{subtitle}</p>}
      <div className="border-b border-stone-200" />
    </div>
  );
}

export function CharacterDialog({
  ashura,
  mobuta,
  ashuraSrc = "/characters/ashura_normal.png",
  mobutaSrc = "/characters/mobuta_present.png",
}: {
  ashura: string;
  mobuta: string;
  ashuraSrc?: string;
  mobutaSrc?: string;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div className="shrink-0 w-14 h-14 rounded-full bg-amber-50 border border-amber-200 p-1 overflow-hidden">
          <Image src={ashuraSrc} alt="アシュラ" width={56} height={56} className="object-contain" />
        </div>
        <div className="max-w-[78%] bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-2xl rounded-bl-sm px-4 py-3 text-lg leading-relaxed text-stone-800 shadow-sm">
          {ashura}
        </div>
      </div>
      <div className="flex flex-row-reverse items-end gap-3">
        <div className="shrink-0 w-14 h-14 rounded-full bg-violet-50 border border-violet-200 p-1 overflow-hidden">
          <Image src={mobutaSrc} alt="モブ太" width={56} height={56} className="object-contain" />
        </div>
        <div className="max-w-[78%] bg-gradient-to-br from-violet-500 to-purple-600 text-white rounded-2xl rounded-br-sm px-4 py-3 text-lg leading-relaxed shadow-sm">
          {mobuta}
        </div>
      </div>
    </div>
  );
}

export function Card({ step, title, children, right }: { step: string; title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="relative bg-white/85 backdrop-blur rounded-3xl border border-stone-200 shadow-md overflow-hidden">
      <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-orange-500 to-red-500" />
      <div className="pl-7 pr-6 py-6 space-y-5">
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="px-3 py-1 rounded-full text-xs font-semibold tracking-wider uppercase text-white bg-gradient-to-r from-orange-500 to-red-500">{step}</span>
            <h2 className="text-2xl md:text-3xl font-extrabold bg-gradient-to-r from-stone-900 via-orange-700 to-red-600 bg-clip-text text-transparent">{title}</h2>
            {right && <div className="ml-auto">{right}</div>}
          </div>
          <div className="border-b-2 border-dashed border-orange-200" />
        </div>
        <div className="space-y-5">{children}</div>
      </div>
    </section>
  );
}

export function Stepper({ step, labels, onJump, maxReachable }: { step: number; labels: string[]; onJump: (i: number) => void; maxReachable: number }) {
  return (
    <div className="flex items-center gap-2">
      {labels.map((l, i) => {
        const active = i <= step;
        const can = i <= maxReachable;
        return (
          <div key={l} className="flex items-center gap-2 flex-1">
            <button
              type="button"
              onClick={() => can && onJump(i)}
              disabled={!can}
              className={`flex items-center justify-center w-9 h-9 rounded-full text-base font-semibold shadow-sm ${
                active ? "bg-gradient-to-r from-orange-500 to-red-500 text-white" : "bg-white border border-stone-300 text-stone-400"
              } disabled:cursor-not-allowed`}
            >
              {i + 1}
            </button>
            <span className={`text-base whitespace-nowrap ${i === step ? "text-stone-800 font-semibold" : "text-stone-500"}`}>{l}</span>
            {i < labels.length - 1 && <div className={`flex-1 h-0.5 ${active ? "bg-orange-300" : "bg-stone-200"}`} />}
          </div>
        );
      })}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="block text-lg font-semibold text-stone-800">{label}</span>
      {hint && <span className="block text-base text-stone-500">{hint}</span>}
      {children}
    </label>
  );
}

export function AshuraThinking({ message = "アシュラが考えているのじゃ…", sub }: { message?: string; sub?: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-4 select-none">
      <div className="relative flex items-center justify-center" style={{ width: 96, height: 96 }}>
        <div className="absolute rounded-full bg-gradient-to-br from-amber-200 via-orange-200 to-rose-200 ashura-aura" style={{ width: 130, height: 130, filter: "blur(18px)" }} aria-hidden />
        <div className="relative ashura-float">
          <Image src="/characters/ashura_think.png" alt="考え中のアシュラ" width={96} height={96} className="object-contain drop-shadow-lg" />
        </div>
      </div>
      <div className="flex items-center gap-2.5 text-stone-700 font-semibold">
        <span className="text-base sm:text-lg">{message}</span>
        <span className="inline-flex items-end gap-1 h-4">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-500 thinking-dot" />
          <span className="w-1.5 h-1.5 rounded-full bg-orange-500 thinking-dot" />
          <span className="w-1.5 h-1.5 rounded-full bg-orange-500 thinking-dot" />
        </span>
      </div>
      {sub && <div className="text-sm text-stone-500 text-center max-w-xl break-all">{sub}</div>}
      <div className="text-xs text-stone-400 tabular-nums">
        経過 {Math.floor(elapsed / 60).toString().padStart(2, "0")}:{(elapsed % 60).toString().padStart(2, "0")}
      </div>
    </div>
  );
}

export function Notice({ kind, children }: { kind: "ok" | "warn" | "error" | "info"; children: React.ReactNode }) {
  const cls = {
    ok: "bg-emerald-50 text-emerald-800 border-emerald-200",
    warn: "bg-amber-50 text-amber-900 border-amber-200",
    error: "bg-rose-50 text-rose-800 border-rose-200",
    info: "bg-sky-50 text-sky-900 border-sky-200",
  }[kind];
  return <div className={`rounded-xl border px-4 py-3 text-base leading-[1.8] ${cls}`}>{children}</div>;
}
