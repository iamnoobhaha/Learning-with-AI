"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FlashcardView } from "@/lib/types";
import { dueLabel, intervalLabel, isDue } from "@/lib/srs";

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

function formatDate(s: string) {
  const d = new Date(s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

function deckMastery(cards: FlashcardView[]) {
  if (!cards.length) return 0;
  return Math.round((cards.filter((c) => c.box >= 3).length / cards.length) * 100);
}

type StudyMode = "due" | "cram";

export default function FlashcardsPanel({
  documentId,
  libraryId,
  title,
}: {
  documentId?: string;
  libraryId?: string;
  title?: string;
}) {
  const [allCards, setAllCards] = useState<FlashcardView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [count, setCount] = useState(12);
  const [error, setError] = useState("");

  // active study session
  const [mode, setMode] = useState<StudyMode | null>(null);
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  const [deck, setDeck] = useState<FlashcardView[]>([]);
  const [deckIndex, setDeckIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [lastGrade, setLastGrade] = useState<string | null>(null);
  const pendingStartDeck = useRef<string | null>(null);

  const scopeParam = documentId
    ? `documentId=${documentId}`
    : `libraryId=${libraryId}`;

  const startSession = useCallback((cards: FlashcardView[], m: StudyMode) => {
    if (!cards.length) return;
    setMode(m);
    setActiveDeckId(cards[0].deck_id);
    setDeck(cards);
    setDeckIndex(0);
    setFlipped(false);
    setReviewed(0);
    setLastGrade(null);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch(`/api/flashcards?${scopeParam}`);
    const data = (await res.json()) as { cards?: FlashcardView[] };
    const list = data.cards ?? [];
    setAllCards(list);
    setLoaded(true);
    const startId = pendingStartDeck.current;
    if (startId) {
      pendingStartDeck.current = null;
      startSession(list.filter((c) => c.deck_id === startId), "cram");
    }
  }, [scopeParam, startSession]);

  useEffect(() => {
    void load();
  }, [load]);

  const decks = useMemo(() => {
    const m = new Map<string, FlashcardView[]>();
    for (const c of allCards) {
      const list = m.get(c.deck_id);
      if (list) list.push(c);
      else m.set(c.deck_id, [c]);
    }
    return [...m.entries()]
      .map(([id, cards]) => ({ id, cards, label: formatDate(cards[0].created_at) }))
      .sort(
        (a, b) =>
          new Date(b.cards[0].created_at).getTime() -
          new Date(a.cards[0].created_at).getTime()
      );
  }, [allCards]);

  const dueCards = useMemo(
    () =>
      allCards
        .filter((c) => isDue(c.due_at ?? ""))
        .sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? "")),
    [allCards]
  );

  async function generate() {
    setGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/flashcards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, libraryId, count }),
      });
      const data = (await res.json()) as { error?: string; deckId?: string };
      if (!res.ok) throw new Error(data.error || "Generation failed");
      pendingStartDeck.current = data.deckId ?? null;
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  const advance = useCallback(
    async (result: "again" | "know") => {
      const card = deck[deckIndex];
      if (!card) return;
      setFlipped(false);
      setReviewed((n) => n + 1);
      setLastGrade(null);
      try {
        const res = await fetch(`/api/flashcards/${card.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ result }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            box: number;
            interval: number;
            ease: number;
            reps: number;
            lapses: number;
            dueAt: string;
          };
          setAllCards((prev) =>
            prev.map((c) =>
              c.id === card.id
                ? {
                    ...c,
                    box: data.box,
                    due_at: data.dueAt,
                    interval: data.interval,
                    ease: data.ease,
                    reps: data.reps,
                    lapses: data.lapses,
                  }
                : c
            )
          );
          setLastGrade(
            result === "know"
              ? `Next review ${intervalLabel(data.interval).toLowerCase()}`
              : "Forgotten — review again in 10 min"
          );
        }
      } catch {
        // grading is best-effort; the queue still advances
      }
      const rest = deck.filter((c) => c.id !== card.id);
      if (result === "know") {
        setDeck(rest);
        setDeckIndex(rest.length === 0 ? 0 : deckIndex % rest.length);
      } else {
        setDeck([...rest, card]);
        setDeckIndex(0);
      }
    },
    [deck, deckIndex]
  );

  const skip = useCallback(
    (dir: -1 | 1) => {
      if (deck.length === 0) return;
      setFlipped(false);
      setLastGrade(null);
      setDeckIndex((i) => (i + dir + deck.length) % deck.length);
    },
    [deck.length]
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
        void advance("again");
      } else if (e.key === "2" && flipped) {
        void advance("know");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, flipped, skip]);

  async function removeCard(id: number) {
    await fetch(`/api/flashcards/${id}`, { method: "DELETE" });
    setAllCards((prev) => prev.filter((c) => c.id !== id));
    setDeck((prev) => prev.filter((c) => c.id !== id));
    setDeckIndex(0);
    setFlipped(false);
  }

  function exitStudy() {
    setMode(null);
    setActiveDeckId(null);
    setDeck([]);
    setDeckIndex(0);
    setFlipped(false);
    setReviewed(0);
    setLastGrade(null);
  }

  const overallMastery = deckMastery(allCards);
  const activeCards = useMemo(
    () => allCards.filter((c) => c.deck_id === activeDeckId),
    [allCards, activeDeckId]
  );

  if (!loaded) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-10 text-center text-sm text-zinc-500">
        Loading…
      </div>
    );
  }

  /* ---------------- STUDY SESSION ---------------- */
  if (mode && deck.length) {
    const card = deck[deckIndex];
    const progressPct = Math.round(((deckIndex + 1) / deck.length) * 100);
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <button
              onClick={exitStudy}
              className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition hover:border-indigo-500"
            >
              ← All decks
            </button>
            <p className="text-zinc-400">
              <span
                className={`mr-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                  mode === "due" ? "bg-emerald-950 text-emerald-300" : "bg-indigo-950 text-indigo-300"
                }`}
              >
                {mode === "due" ? "Due review" : "Deck study"}
              </span>
              <span className="font-semibold text-white">{deck.length}</span> left ·{" "}
              <span className="font-semibold text-white">{reviewed}</span> reviewed
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => exportCsv(activeCards, `${title || "deck"} (${activeDeckId?.slice(0, 8)})`)}
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

        <div className="[perspective:1200px]">
          <div
            onClick={() => setFlipped(!flipped)}
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
              onClick={() => void advance("again")}
              className="rounded-xl border border-red-800 bg-red-950/40 py-3.5 font-medium text-red-200 transition hover:bg-red-900/60"
            >
              Again <span className="ml-1 text-xs opacity-60">(1)</span>
            </button>
            <button
              onClick={() => void advance("know")}
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

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-600">
          <span>
            Card {deckIndex + 1} of {deck.length} · {reviewed} reviewed this session
            {lastGrade && (
              <span className="ml-3 font-medium text-indigo-300">{lastGrade}</span>
            )}
          </span>
          {mode === "cram" && (
            <button
              onClick={() => {
                setDeck((prev) => [...prev].sort(() => Math.random() - 0.5));
                setDeckIndex(0);
                setFlipped(false);
              }}
              className="transition hover:text-zinc-300"
            >
              Shuffle deck
            </button>
          )}
        </div>
      </div>
    );
  }

  /* ---------------- ROUND COMPLETE ---------------- */
  if (mode && !deck.length) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-emerald-800/50 bg-emerald-950/30 p-8 text-center">
          <h2 className="text-lg font-semibold text-emerald-200">
            {mode === "due" ? "Due reviews cleared" : "Round complete"}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-400">
            You reviewed {reviewed} card{reviewed === 1 ? "" : "s"} this session.
            {mode === "due" && dueCards.length === 0
              ? " You're fully up to date — nothing else is due right now."
              : " Cards you forgot are scheduled to come back in 10 minutes."}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            {mode === "due" && (
              <button
                onClick={() => startSession([...activeCards].sort(() => Math.random() - 0.5), "cram")}
                className="rounded-xl border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-indigo-500"
              >
                Cram this deck ({activeCards.length})
              </button>
            )}
            <button
              onClick={() => startSession(activeCards, "cram")}
              className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium transition hover:bg-indigo-500"
            >
              Study deck again
            </button>
            <button
              onClick={exitStudy}
              className="rounded-xl border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-indigo-500"
            >
              ← All decks
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- BROWSE / HISTORY ---------------- */
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Generate flashcards</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {libraryId
                ? "Drawn from every document in this course. New batches stack as new decks below."
                : "New batches are saved as separate decks in your history below."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm outline-none focus:border-indigo-500"
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
              {generating ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>
        {error && (
          <p className="mt-3 rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>
        )}
      </div>

      {dueCards.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-700/50 bg-emerald-950/30 px-5 py-4">
          <div>
            <p className="font-semibold text-emerald-200">
              {dueCards.length} card{dueCards.length === 1 ? "" : "s"} due for review
            </p>
            <p className="text-xs text-zinc-400">
              Spaced repetition picks the right moment for each card — review now to keep your memory strong.
            </p>
          </div>
          <button
            onClick={() => startSession(dueCards, "due")}
            className="rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-medium transition hover:bg-emerald-500"
          >
            Start due review
          </button>
        </div>
      )}

      {allCards.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-10 text-center text-sm text-zinc-500">
          No decks yet — pick a card count above and hit generate.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-300">
              Deck history
              <span className="ml-2 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-400">
                {decks.length} deck{decks.length === 1 ? "" : "s"} · {allCards.length} cards ·{" "}
                {overallMastery}% mastered
              </span>
            </h3>
            <button
              onClick={() => exportCsv(allCards, title || "deck")}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-indigo-500"
            >
              Export all CSV
            </button>
          </div>
          {decks.map((d) => {
            const due = d.cards.filter((c) => isDue(c.due_at ?? "")).length;
            return (
              <DeckCard
                key={d.id}
                label={d.label}
                cards={d.cards}
                due={due}
                onReviewDue={() => startSession(d.cards.filter((c) => isDue(c.due_at ?? "")), "due")}
                onStudy={() => startSession(d.cards, "cram")}
                onRemoveCard={removeCard}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function DeckCard({
  label,
  cards,
  due,
  onReviewDue,
  onStudy,
  onRemoveCard,
}: {
  label: string;
  cards: FlashcardView[];
  due: number;
  onReviewDue: () => void;
  onStudy: () => void;
  onRemoveCard: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const mastery = deckMastery(cards);
  const learning = cards.filter((c) => c.interval === 0).length;
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-200">
            {label}
            {due > 0 && (
              <span className="ml-2 rounded-full bg-emerald-950 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                {due} due
              </span>
            )}
          </p>
          <p className="text-xs text-zinc-500">
            {cards.length} cards · {mastery}% mastered · {learning} learning
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOpen((o) => !o)}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-indigo-500"
          >
            {open ? "Hide cards" : "Preview"}
          </button>
          {due > 0 && (
            <button
              onClick={onReviewDue}
              className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-medium transition hover:bg-emerald-500"
            >
              Review {due} due
            </button>
          )}
          <button
            onClick={onStudy}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium transition hover:bg-indigo-500"
          >
            Study deck
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          {cards.map((c) => (
            <div
              key={c.id}
              className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 px-3 py-2 text-sm"
            >
              <p className="text-zinc-200">
                <span
                  className={`mr-2 rounded px-1.5 py-0.5 text-[10px] ${
                    isDue(c.due_at ?? "")
                      ? "bg-emerald-950 text-emerald-300"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {intervalLabel(c.interval)} · {dueLabel(c.due_at ?? "")}
                </span>
                {c.front}
              </p>
              <p className="mt-1 text-xs text-zinc-500">{c.back}</p>
              <button
                onClick={() => void onRemoveCard(c.id)}
                className="mt-1.5 text-[10px] text-zinc-600 transition hover:text-red-400"
              >
                Remove card
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
