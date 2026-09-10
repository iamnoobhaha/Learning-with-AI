import { NextResponse } from "next/server";
import db from "@/lib/db";
import type {
  ActivityItem,
  DocProgress,
  ScorePoint,
  StatsOverview,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dayOf(ts: string): string {
  // stored as "YYYY-MM-DD HH:MM:SS" (UTC)
  return ts.slice(0, 10);
}

function computeStreak(dates: Set<string>): number {
  if (!dates.size) return 0;
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  let cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (!dates.has(fmt(cursor))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (!dates.has(fmt(cursor))) return 0;
  }
  let streak = 0;
  while (dates.has(fmt(cursor))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

export async function GET() {
  const docs = db
    .prepare("SELECT id, kind, title FROM documents")
    .all() as { id: string; kind: "notes" | "past_paper"; title: string }[];

  const attempts = db
    .prepare(
      `SELECT a.id, a.score_pct, a.created_at, q.title AS quiz_title, q.document_id
       FROM attempts a JOIN quizzes q ON q.id = a.quiz_id
       ORDER BY a.created_at DESC, a.id DESC`
    )
    .all() as { id: number; score_pct: number; created_at: string; quiz_title: string; document_id: string }[];

  const cards = db
    .prepare("SELECT document_id, box, updated_at, due_at, interval FROM flashcards")
    .all() as {
    document_id: string;
    box: number;
    updated_at: string;
    due_at: string | null;
    interval: number;
  }[];

  const chats = db
    .prepare("SELECT document_id, created_at FROM chat_messages")
    .all() as { document_id: string; created_at: string }[];

  const exams = db
    .prepare(
      `SELECT e.kind, e.title, e.created_at, s.title AS source_title
       FROM exams e JOIN documents s ON s.id = e.source_doc_id`
    )
    .all() as { kind: string; title: string; created_at: string; source_title: string }[];

  const activeDays = new Set<string>();
  for (const a of attempts) activeDays.add(dayOf(a.created_at));
  for (const c of cards) activeDays.add(dayOf(c.updated_at));
  for (const c of chats) activeDays.add(dayOf(c.created_at));

  const scores = attempts.map((a) => Number(a.score_pct));
  const overview: StatsOverview = {
    streakDays: computeStreak(activeDays),
    activeToday: activeDays.has(dayOf(new Date().toISOString())),
    totalDocs: docs.length,
    notesCount: docs.filter((d) => d.kind === "notes").length,
    papersCount: docs.filter((d) => d.kind === "past_paper").length,
    quizzesTaken: attempts.length,
    avgScore: scores.length ? Math.round((scores.reduce((s, x) => s + x, 0) / scores.length) * 10) / 10 : null,
    bestScore: scores.length ? Math.max(...scores) : null,
    flashcardsTotal: cards.length,
    flashcardsMastered: cards.filter((c) => c.box >= 3).length,
    flashcardsDue: cards.filter(
      (c) => !c.due_at || c.due_at <= new Date().toISOString().slice(0, 19).replace("T", " ")
    ).length,
  };

  const nowStr = new Date().toISOString().slice(0, 19).replace("T", " ");
  const dueForecast: { date: string; label: string; count: number }[] = [];
  for (let d = 0; d < 7; d++) {
    const day = new Date(Date.now() + d * 86_400_000);
    const dayStr = day.toISOString().slice(0, 10);
    const count = cards.filter((c) => {
      if (!c.due_at) return d === 0;
      if (c.due_at <= nowStr) return d === 0;
      return c.due_at.slice(0, 10) === dayStr;
    }).length;
    dueForecast.push({
      date: dayStr,
      label:
        d === 0
          ? "Today"
          : d === 1
            ? "Tomorrow"
            : day.toLocaleDateString(undefined, { weekday: "short" }),
      count,
    });
  }

  const scorePoints: ScorePoint[] = [...attempts]
    .reverse()
    .slice(-14)
    .map((a) => ({
      date: a.created_at,
      score: Math.round(Number(a.score_pct) * 10) / 10,
      quizTitle: a.quiz_title,
    }));

  const progress: DocProgress[] = docs.map((d) => {
    const docAttempts = attempts.filter((a) => a.document_id === d.id);
    const docCards = cards.filter((c) => c.document_id === d.id);
    const docScores = docAttempts.map((a) => Number(a.score_pct));
    const quizN = db
      .prepare("SELECT COUNT(*) AS n FROM quizzes WHERE document_id = ?")
      .get(d.id) as { n: number };
    return {
      id: d.id,
      title: d.title,
      kind: d.kind,
      quizCount: Number(quizN.n),
      attempts: docAttempts.length,
      avgScore: docScores.length
        ? Math.round((docScores.reduce((s, x) => s + x, 0) / docScores.length) * 10) / 10
        : null,
      cardsTotal: docCards.length,
      cardsMastered: docCards.filter((c) => c.box >= 3).length,
      chatTurns: chats.filter((c) => c.document_id === d.id).length,
    };
  });

  const activity: ActivityItem[] = [];
  for (const a of attempts.slice(0, 8)) {
    activity.push({
      type: "quiz",
      label: `Scored ${Math.round(Number(a.score_pct))}% on "${a.quiz_title}"`,
      detail: "Quiz attempt",
      at: a.created_at,
    });
  }
  for (const e of exams.slice(0, 5)) {
    activity.push({
      type: "exam",
      label: `${e.kind === "mock" ? "Generated mock exam" : "Wrote reference answers"}: ${e.title}`,
      detail: `from ${e.source_title}`,
      at: e.created_at,
    });
  }
  const reviewedByDay = new Map<string, number>();
  for (const c of cards) {
    const day = dayOf(c.updated_at);
    reviewedByDay.set(day, (reviewedByDay.get(day) ?? 0) + 1);
  }
  activity.push(
    ...[...reviewedByDay.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 4)
      .map(([day, n]) => ({
        type: "flashcards" as const,
        label: `Reviewed ${n} flashcard${n === 1 ? "" : "s"}`,
        detail: "Spaced repetition",
        at: `${day} 12:00:00`,
      }))
  );
  activity.sort((a, b) => b.at.localeCompare(a.at));

  return NextResponse.json({
    overview,
    scorePoints,
    dueForecast,
    progress: progress.sort(
      (a, b) => b.attempts + b.cardsTotal - (a.attempts + a.cardsTotal)
    ),
    activity: activity.slice(0, 12),
  });
}
