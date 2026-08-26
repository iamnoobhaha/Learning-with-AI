import db from "@/lib/db";
import { listLibraries } from "@/lib/libraries";
import Uploader from "@/components/Uploader";
import LibraryBrowser from "@/components/LibraryBrowser";
import LibrariesGrid from "@/components/LibrariesGrid";
import type { DocMeta } from "@/lib/types";

export const dynamic = "force-dynamic";

const DOC_COLS = "id, kind, title, filename, size, pages, library_id, created_at";

export default function HomePage() {
  const libraries = listLibraries();
  const docs = db
    .prepare(
      `SELECT ${DOC_COLS} FROM documents WHERE library_id IS NULL ORDER BY created_at DESC, id DESC`
    )
    .all() as DocMeta[];

  const allCount = (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
  const attemptCount = (db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number })
    .n;
  const cardCount = (db.prepare("SELECT COUNT(*) AS n FROM flashcards").get() as { n: number }).n;
  const bestScore = db.prepare("SELECT MAX(score_pct) AS m FROM attempts").get() as {
    m: number | null;
  };

  const stats = [
    { label: "Courses", value: libraries.length },
    { label: "Documents", value: Number(allCount) },
    { label: "Quiz attempts", value: Number(attemptCount) },
    { label: "Flashcards", value: Number(cardCount) },
    {
      label: "Best score",
      value: bestScore.m !== null ? `${Math.round(Number(bestScore.m))}%` : "—",
    },
  ];

  return (
    <div className="space-y-10">
      <section className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-gradient-to-br from-indigo-950/60 via-zinc-900/60 to-zinc-900 p-8 sm:p-10">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-indigo-600/20 blur-3xl"
        />
        <h1 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
          Turn your notes into an{" "}
          <span className="bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">
            AI study partner
          </span>
        </h1>
        <p className="mt-3 max-w-2xl text-zinc-400">
          Group your lecture notes and past papers into courses. The AI tutor, quizzes, flashcards
          and mock exams then draw on an entire course at once — not just a single file.
        </p>
        <div className="mt-6 flex flex-wrap gap-6 border-t border-zinc-800 pt-5">
          {stats.map((s) => (
            <div key={s.label}>
              <p className="text-xl font-bold tabular-nums">{s.value}</p>
              <p className="text-xs uppercase tracking-wide text-zinc-500">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      <Uploader />

      <LibrariesGrid libraries={libraries} />

      <LibraryBrowser docs={docs} />
    </div>
  );
}
