import Link from "next/link";
import { notFound } from "next/navigation";
import db from "@/lib/db";
import DocWorkspace from "@/components/DocWorkspace";

export const dynamic = "force-dynamic";

export default async function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = db
    .prepare(
      `SELECT id, kind, title, filename, size, pages, library_id, created_at,
              page_model, selection_revision, needs_reprocessing
       FROM documents WHERE id = ?`
    )
    .get(id) as import("@/lib/types").DocMeta | undefined;
  if (!doc) notFound();

  const best = db
    .prepare("SELECT MAX(score_pct) AS m FROM attempts a JOIN quizzes q ON q.id = a.quiz_id WHERE q.document_id = ?")
    .get(id) as { m: number | null };
  const cards = db
    .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN box >= 3 THEN 1 ELSE 0 END) AS mastered FROM flashcards WHERE document_id = ?")
    .get(id) as { n: number; mastered: number | null };
  const chats = db
    .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE document_id = ? AND role = 'user'")
    .get(id) as { n: number };

  const stats: { label: string; value: string }[] = [
    ...(doc.kind === "notes" && best.m !== null ? [{ label: "Best score", value: `${Math.round(Number(best.m))}%` }] : []),
    ...(cards.n > 0
      ? [{ label: "Flashcards", value: `${Number(cards.mastered ?? 0)}/${Number(cards.n)} mastered` }]
      : []),
    ...((chats.n > 0) ? [{ label: "Tutor questions", value: String(Number(chats.n)) }] : []),
    { label: "Added", value: doc.created_at.slice(0, 10) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-zinc-400 transition hover:text-white">
          ← Library
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{doc.title}</h1>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
              doc.kind === "past_paper" ? "bg-amber-950 text-amber-300" : "bg-indigo-950 text-indigo-300"
            }`}
          >
            {doc.kind === "past_paper" ? "Past paper" : "Notes"}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
          {stats.map((s) => (
            <span key={s.label}>
              <span className="font-semibold text-zinc-300">{s.value}</span> {s.label.toLowerCase()}
            </span>
          ))}
        </div>
      </div>
      <DocWorkspace doc={doc} />
    </div>
  );
}
