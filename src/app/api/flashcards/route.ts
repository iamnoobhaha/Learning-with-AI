import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { evenContext, evenLibraryContext, docIdsInLibrary } from "@/lib/context";
import { flashcardMessages } from "@/lib/prompts";
import { aiComplete, extractJson } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const documentId = url.searchParams.get("documentId");
  const libraryId = url.searchParams.get("libraryId");
  if (!documentId && !libraryId) {
    return NextResponse.json({ error: "documentId or libraryId required" }, { status: 400 });
  }
  const fields =
    "id, front, back, box, created_at, deck_id, due_at, interval, ease, reps, lapses";
  const rows = documentId
    ? db
        .prepare(
          `SELECT ${fields} FROM flashcards WHERE document_id = ? ORDER BY created_at DESC LIMIT 200`
        )
        .all(documentId)
    : db
        .prepare(
          `SELECT ${fields} FROM flashcards WHERE library_id = ? ORDER BY created_at DESC LIMIT 200`
        )
        .all(libraryId);
  return NextResponse.json({ cards: rows });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      documentId?: string;
      libraryId?: string;
      count?: number;
    };
    if (!body.documentId && !body.libraryId) {
      return NextResponse.json(
        { error: "documentId or libraryId required" },
        { status: 400 }
      );
    }

    let context: string;
    let sourceTitle: string;
    if (body.documentId) {
      const doc = db
        .prepare("SELECT id, title FROM documents WHERE id = ?")
        .get(body.documentId) as { id: string; title: string } | undefined;
      if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });
      sourceTitle = doc.title;
      context = evenContext(doc.id, 22000);
    } else {
      const lib = db
        .prepare("SELECT id, name FROM libraries WHERE id = ?")
        .get(body.libraryId!) as { id: string; name: string } | undefined;
      if (!lib) return NextResponse.json({ error: "Library not found" }, { status: 404 });
      const docIds = docIdsInLibrary(lib.id);
      if (!docIds.length) {
        return NextResponse.json(
          { error: "This library has no documents yet — upload some notes first." },
          { status: 400 }
        );
      }
      sourceTitle = `${lib.name} (${docIds.length} documents)`;
      context = evenLibraryContext(lib.id, 30000);
    }

    const count = Math.min(Math.max(body.count ?? 12, 3), 30);
    const raw = await aiComplete(
      flashcardMessages({ title: sourceTitle, context, count }),
      { temperature: 0.5, maxTokens: 3000 }
    );
    const parsed = extractJson<{ cards?: { front?: string; back?: string }[] }>(raw);
    const cards = (parsed.cards ?? []).filter((c) => c.front && c.back);
    if (!cards.length) throw new Error("Model returned no cards");

    const ins = db.prepare(
      "INSERT INTO flashcards (document_id, library_id, front, back, deck_id, created_at, due_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    );
    const deckId = randomUUID();
    db.transaction(() =>
      cards.forEach((c) =>
        ins.run(body.documentId ?? null, body.libraryId ?? null, c.front, c.back, deckId)
      )
    )();

    const where = body.documentId
      ? "document_id = ?"
      : "library_id = ?";
    const all = db
      .prepare(`SELECT COUNT(*) AS n FROM flashcards WHERE ${where}`)
      .get(body.documentId ?? body.libraryId) as { n: number };
    return NextResponse.json({ added: cards.length, total: Number(all.n), deckId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
