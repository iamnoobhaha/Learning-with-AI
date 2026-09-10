"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type {
  ActivityItem,
  DocProgress,
  ScorePoint,
  StatsOverview,
} from "@/lib/types";

interface StatsPayload {
  overview: StatsOverview;
  scorePoints: ScorePoint[];
  progress: DocProgress[];
  activity: ActivityItem[];
}

function scoreColor(s: number): string {
  return s >= 80 ? "bg-emerald-500" : s >= 50 ? "bg-amber-500" : "bg-red-500";
}

export default function DashboardPage() {
  const [data, setData] = useState<StatsPayload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/stats");
        if (!res.ok) throw new Error("Could not load stats");
        setData((await res.json()) as StatsPayload);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load stats");
      }
    })();
  }, []);

  if (error) {
    return <p className="rounded-xl bg-red-950/60 px-4 py-3 text-sm text-red-300">{error}</p>;
  }
  if (!data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-zinc-900" />
        ))}
      </div>
    );
  }

  const { overview, scorePoints, progress, activity } = data;

  const cards = [
    {
      label: "Study streak",
      value: `${overview.streakDays} day${overview.streakDays === 1 ? "" : "s"}`,
      sub: overview.activeToday ? "Active today — keep it going" : "No study logged today yet",
      accent: overview.activeToday,
    },
    {
      label: "Quiz attempts",
      value: String(overview.quizzesTaken),
      sub:
        overview.avgScore !== null
          ? `Average ${overview.avgScore}% · best ${Math.round(overview.bestScore ?? 0)}%`
          : "Take your first quiz",
    },
    {
      label: "Flashcard reviews due",
      value: String(overview.flashcardsDue),
      sub:
        overview.flashcardsDue > 0
          ? `${overview.flashcardsMastered}/${overview.flashcardsTotal} mastered overall`
          : overview.flashcardsTotal > 0
            ? "Nothing due — you're up to date"
            : "Generate cards from any notes doc",
      accent: overview.flashcardsDue > 0,
    },
    {
      label: "Library",
      value: String(overview.totalDocs),
      sub: `${overview.notesCount} notes · ${overview.papersCount} past papers`,
    },
  ];

  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-3xl font-bold tracking-tight">Your progress</h1>
        <p className="mt-2 max-w-2xl text-zinc-400">
          Everything you&apos;ve studied, in one place. Streaks count quiz attempts, tutor chats and
          flashcard reviews.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className={`rounded-2xl border p-5 ${
              c.accent ? "border-emerald-700/50 bg-emerald-950/20" : "border-zinc-800 bg-zinc-900/50"
            }`}
          >
            <p className="text-xs uppercase tracking-wide text-zinc-500">{c.label}</p>
            <p className="mt-1.5 text-3xl font-bold tabular-nums">{c.value}</p>
            <p className="mt-1 text-xs text-zinc-500">{c.sub}</p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="font-semibold">Recent quiz scores</h2>
        {scorePoints.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
            No quiz attempts yet — generate a quiz from any notes document to see your trend here.
          </p>
        ) : (
          <>
            <div className="relative mt-6 flex h-44 items-end gap-2">
              <span className="absolute -top-2 left-0 text-[10px] text-zinc-600">100%</span>
              {scorePoints.map((p, i) => (
                <div key={i} className="group relative flex h-full flex-1 items-end">
                  <div
                    className={`w-full rounded-t-md transition-all group-hover:brightness-125 ${scoreColor(p.score)}`}
                    style={{ height: `${Math.max(3, p.score)}%` }}
                  />
                  <div className="pointer-events-none absolute -top-9 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 shadow group-hover:block">
                    {Math.round(p.score)}% · {p.quizTitle.slice(0, 32)}
                    {p.quizTitle.length > 32 ? "…" : ""}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wide text-zinc-600">
              <span>Oldest</span>
              <span>{scorePoints.length} most recent attempts</span>
              <span>Latest</span>
            </div>
          </>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="font-semibold">Per-document progress</h2>
        {progress.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
            Upload a document to start tracking progress.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-4 font-medium">Document</th>
                  <th className="px-4 py-2 font-medium">Quizzes</th>
                  <th className="px-4 py-2 font-medium">Attempts</th>
                  <th className="px-4 py-2 font-medium">Avg score</th>
                  <th className="px-4 py-2 font-medium">Cards mastered</th>
                  <th className="px-4 py-2 font-medium">Chat turns</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {progress.map((d) => (
                  <tr key={d.id} className="transition hover:bg-zinc-900/60">
                    <td className="max-w-[240px] truncate py-3 pr-4">
                      <Link href={`/docs/${d.id}`} className="font-medium hover:text-indigo-300">
                        {d.title}
                      </Link>
                      <span
                        className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          d.kind === "past_paper"
                            ? "bg-amber-950 text-amber-300"
                            : "bg-indigo-950 text-indigo-300"
                        }`}
                      >
                        {d.kind === "past_paper" ? "Paper" : "Notes"}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">{d.quizCount}</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">{d.attempts}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {d.avgScore !== null ? (
                        <span
                          className={`font-semibold ${
                            d.avgScore >= 80
                              ? "text-emerald-400"
                              : d.avgScore >= 50
                                ? "text-amber-400"
                                : "text-red-400"
                          }`}
                        >
                          {d.avgScore}%
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">
                      {d.cardsTotal > 0 ? `${d.cardsMastered}/${d.cardsTotal}` : "—"}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">{d.chatTurns || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="font-semibold">Recent activity</h2>
        {activity.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
            Your study events will appear here.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {activity.map((a, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                    a.type === "quiz"
                      ? "bg-indigo-400"
                      : a.type === "flashcards"
                        ? "bg-emerald-400"
                        : a.type === "exam"
                          ? "bg-sky-400"
                          : "bg-zinc-500"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-zinc-200">{a.label}</p>
                  <p className="text-xs text-zinc-500">
                    {a.detail} · {a.at.replace("T", " ").slice(0, 16)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
