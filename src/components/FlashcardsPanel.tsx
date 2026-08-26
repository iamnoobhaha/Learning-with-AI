"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FlashcardView } from "@/lib/types";

function exportCsv(cards: FlashcardView[], docTitle: string) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const csv = ["front,back", ...cards.map((c) => `${esc(c.front)},${esc(c.back)}`)].join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${docTitle.replace(/[^\w-]+/g, "_")}-flashcards.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function FlashcardsPanel({
  documentId,
  libraryId,
  title,
}: {
  documentId?: string;
  libraryId?: string;
  title?: string;
}) {
  const [cards, setCards] = useState<FlashcardView[]>([]);
  const [allCards, setAllCards] = useState<FlashcardView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [count, setCount] = useState(12);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [error, setError] = useState("");

  const scopeParam = documentId
    ? `documentId=${documentId}`
    : `libraryId=${libraryId}`;

  const load = useCallback(async () => {
    const res = await fetch(`/api/flashcards?${scopeParam}`);
    const data = (await res.json()) as { cards?: FlashcardView[] };
    const list = data.cards ?? [];
    setAllCards(list);
    setCards((prev) => (prev.length ? mergeProgress(list, prev) : list));
    setLoaded(true);
  }, [scopeParam]);

  useEffect(() => {
    void load();
  }, [load]);

  // keep the working deck in sync when the server list changes underneath it
  function mergeProgress(server: FlashcardView[], current: FlashcardView[]): FlashcardView[] {
    const byId = new Map(server.map((c) => [c.id, c]));
    return current
      .filter((c) => byId.has(c.id))
      .map((c) => byId.get(c.id)!);
  }

  async function generate() {
    setGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/flashcards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, libraryId, count }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Generation failed");
      await load();
      setIndex(0);
      setFlipped(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  const advance = useCallback(
    (result: "again" | "know") => {
      const card = cards[index];
      if (!card) return;
      setFlipped(false);
      setReviewed((n) => n + 1);
      fetch(`/api/flashcards/${card.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result }),
      }).catch(() => {});
      const rest = cards.filter((c) => c.id !== card.id);
      if (result === "know") {
        setCards(rest);
        setIndex(rest.length === 0 ? 0 : index % rest.length);
      } else {
        setCards([...rest, card]);
        setIndex(0);
      }
    },
    [cards, index]
  );

  const skip = useCallback(
    (dir: -1 | 1) => {
      if (cards.length === 0) return;
      setFlipped(false);
      setIndex((i) => (i + dir + cards.length) % cards.length);
    },
    [cards.length]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (e.key === "ArrowRight") {
        skip(1);
      } else if (e.key === "ArrowLeft") {
        skip(-1);
      } else if (e.key === "1" && flipped) {
        advance("again");
      } else if (e.key === "2" && flipped) {
        advance("know");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, flipped, skip]);

  async function removeCard(id: number) {
    await fetch(`/api/flashcards/${id}`, { method: "DELETE" });
    const nextAll = allCards.filter((c) => c.id !== id);
    setAllCards(nextAll);
    setCards((prev) => prev.filter((c) => c.id !== id));
    setIndex((i) => (i >= nextAll.length ? 0 : i));
    setFlipped(false);
  }

  const mastery = useMemo(() => {
    if (allCards.length === 0) return 0;
    return Math.round((allCards.filter((c) => c.box >= 3).length / allCards.length) * 100);
  }, [allCards]);

  if (!loaded) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-10 text-center text-sm text-zinc-500">
        Loading…
      </div>
    );
  }

  if (!cards.length && allCards.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <h2 className="text-lg font-semibold">No flashcards yet</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
          {libraryId
            ? "Generate atomic Q&A cards drawn from every document in this course, then review them with a Leitner box system."
            : "Generate atomic Q&A cards from your notes, then review them with a Leitner box system — cards you \"know\" move up and come back less often."}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          >
            {[6, 12, 20, 30].map((n) => (
              <option key={n} value={n}>{n} cards</option>
            ))}
          </select>
          <button
            onClick={generate}
            disabled={generating}
            className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {generating ? "Generating…" : "Generate flashcards"}
          </button>
        </div>
        {error && <p className="mx-auto mt-4 max-w-lg rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}
      </div>
    );
  }

  if (!cards.length) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-emerald-800/50 bg-emerald-950/30 p-8 text-center">
          <h2 className="text-lg font-semibold text-emerald-200">Round complete</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-400">
            You reviewed {reviewed} card{reviewed === 1 ? "" : "s"} this round and know them all.
            Deck mastery: <span className="font-semibold text-emerald-300">{mastery}%</span>.
          </p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <button
              onClick={() => {
                setCards([...allCards]);
                setIndex(0);
                setReviewed(0);
                setFlipped(false);
              }}
              className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium transition hover:bg-indigo-500"
            >
              Study full deck ({allCards.length})
            </button>
          </div>
        </div>
        <DeckFooter
          allCards={allCards}
          mastery={mastery}
          onExport={() => exportCsv(allCards, title || "deck")}
        />
      </div>
    );
  }

  const card = cards[index];
  const progressPct = Math.round(((index + 1) / cards.length) * 100);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="text-zinc-400">
            <span className="font-semibold text-white">{cards.length}</span> left this round ·{" "}
            <span className="font-semibold text-white">{mastery}%</span> deck mastered
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => exportCsv(allCards, title || "deck")}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-indigo-500"
            >
              Export CSV
            </button>
            <button
              onClick={() => void removeCard(card.id)}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-500 transition hover:border-red-800 hover:text-red-300"
            >
              Delete card
            </button>
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-400 transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* flip card */}
      <div className="[perspective:1200px]">
        <div
          onClick={() => setFlipped((f) => !f)}
          className={`relative min-h-[280px] w-full cursor-pointer transition-transform duration-500 [transform-style:preserve-3d] ${
            flipped ? "[transform:rotateX(180deg)]" : ""
          }`}
        >
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-2xl border border-zinc-700 bg-gradient-to-b from-zinc-900 to-zinc-900/40 p-8 text-center [backface-visibility:hidden]">
            <p className="text-xs uppercase tracking-wide text-zinc-500">Question</p>
            <p className="max-w-xl text-xl font-medium leading-relaxed">{card.front}</p>
            <p className="text-xs text-zinc-600">Click or press Space to flip</p>
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-2xl border border-indigo-800/60 bg-gradient-to-b from-indigo-950/40 to-zinc-900/60 p-8 text-center [backface-visibility:hidden] [transform:rotateX(180deg)]">
            <p className="text-xs uppercase tracking-wide text-indigo-300">Answer</p>
            <p className="max-w-xl whitespace-pre-wrap text-lg leading-relaxed text-zinc-100">{card.back}</p>
            <p className="text-[11px] text-zinc-600">
              Press <kbd className="rounded bg-zinc-800 px-1">1</kbd> Again ·{" "}
              <kbd className="rounded bg-zinc-800 px-1">2</kbd> Knew it ·{" "}
              <kbd className="rounded bg-zinc-800 px-1">&larr;</kbd>
              <kbd className="rounded bg-zinc-800 px-1">&rarr;</kbd> navigate
            </p>
          </div>
        </div>
      </div>

      {flipped ? (
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => advance("again")}
            className="rounded-xl border border-red-800 bg-red-950/40 py-3.5 font-medium text-red-200 transition hover:bg-red-900/60"
          >
            Again <span className="ml-1 text-xs opacity-60">(1)</span>
          </button>
          <button
            onClick={() => advance("know")}
            className="rounded-xl border border-emerald-700 bg-emerald-950/40 py-3.5 font-medium text-emerald-200 transition hover:bg-emerald-900/60"
          >
            I knew it <span className="ml-1 text-xs opacity-60">(2)</span>
          </button>
        </div>
      ) : (
        <button
          onClick={() => setFlipped(true)}
          className="w-full rounded-xl bg-indigo-600 py-3.5 font-medium transition hover:bg-indigo-500"
        >
          Reveal answer (Space)
        </button>
      )}

      <DeckFooter
        allCards={allCards}
        mastery={mastery}
        onExport={() => exportCsv(allCards, title || "deck")}
        position={`Card ${index + 1} of ${cards.length}`}
        reviewed={reviewed}
        onShuffle={() => {
          setCards((prev) => [...prev].sort(() => Math.random() - 0.5));
          setIndex(0);
          setFlipped(false);
        }}
      />
    </div>
  );
}

function DeckFooter({
  allCards,
  mastery,
  onExport,
  position,
  reviewed,
  onShuffle,
}: {
  allCards: FlashcardView[];
  mastery: number;
  onExport: () => void;
  position?: string;
  reviewed?: number;
  onShuffle?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-600">
      <span>
        {position ?? `${allCards.length} cards total`} · {mastery}% mastered ·{" "}
        {allCards.length - allCards.filter((c) => c.box >= 3).length} still learning
      </span>
      <span className="flex items-center gap-4">
        {typeof reviewed === "number" && <span>{reviewed} reviewed this session</span>}
        {onShuffle && (
          <button onClick={onShuffle} className="transition hover:text-zinc-300">
            Shuffle deck
          </button>
        )}
        <button onClick={onExport} className="transition hover:text-zinc-300 sm:hidden">
          Export
        </button>
      </span>
    </div>
  );
}
