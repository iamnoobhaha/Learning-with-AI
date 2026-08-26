import Link from "next/link";
import { notFound } from "next/navigation";
import db from "@/lib/db";
import LibraryWorkspace from "@/components/LibraryWorkspace";

export const dynamic = "force-dynamic";

export default async function LibraryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lib = db
    .prepare("SELECT id, name, created_at FROM libraries WHERE id = ?")
    .get(id) as { id: string; name: string; created_at: string } | undefined;
  if (!lib) notFound();

  const docs = db
    .prepare(
      `SELECT id, kind, title, filename, size, pages, library_id, created_at
       FROM documents WHERE library_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(id) as import("@/lib/types").DocMeta[];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-zinc-400 transition hover:text-white">
          ← Library
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{lib.name}</h1>
          <span className="rounded-full bg-violet-950 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">
            Course
          </span>
        </div>
        <p className="mt-2 text-sm text-zinc-500">
          Created {lib.created_at.slice(0, 10)} · the tutor, quizzes and flashcards in this course
          read across every document below.
        </p>
      </div>
      <LibraryWorkspace libraryId={lib.id} name={lib.name} docs={docs} />
    </div>
  );
}
