import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import type { LibraryMeta } from "@/lib/types";

export function listLibraries(): LibraryMeta[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.name, l.created_at,
              COUNT(d.id) AS doc_count,
              SUM(CASE WHEN d.kind = 'notes' THEN 1 ELSE 0 END) AS notes_count,
              SUM(CASE WHEN d.kind = 'past_paper' THEN 1 ELSE 0 END) AS papers_count
       FROM libraries l LEFT JOIN documents d ON d.library_id = l.id
       GROUP BY l.id ORDER BY l.created_at DESC, l.id DESC`
    )
    .all() as {
    id: string;
    name: string;
    created_at: string;
    doc_count: number;
    notes_count: number | null;
    papers_count: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    docCount: Number(r.doc_count),
    notesCount: Number(r.notes_count ?? 0),
    papersCount: Number(r.papers_count ?? 0),
  }));
}

export function findOrCreateLibrary(name: string): { id: string; name: string } {
  const trimmed = name.trim().slice(0, 120);
  const existing = db
    .prepare("SELECT id, name FROM libraries WHERE lower(name) = lower(?)")
    .get(trimmed) as { id: string; name: string } | undefined;
  if (existing) return existing;
  const id = randomUUID();
  db.prepare("INSERT INTO libraries (id, name) VALUES (?, ?)").run(id, trimmed);
  return { id, name: trimmed };
}
