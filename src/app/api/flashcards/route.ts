import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { evenContext, evenLibraryContext, docIdsInLibrary, includedContentChars } from "@/lib/context";
import { flashcardMessages } from "@/lib/prompts";
import { aiComplete, extractJson } from "@/lib/ai";
import { dedupeAgainst } from "@/lib/dedup";

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
      if (includedContentChars([doc.id]) < 200) {
        return NextResponse.json(
          { error: "All content in this document is excluded. Include at least one section first." },
          { status: 400 }
        );
      }
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
      if (includedContentChars(docIds) < 200) {
        return NextResponse.json(
          { error: "All content in this library is excluded. Include at least one section first." },
          { status: 400 }
        );
      }
      sourceTitle = `${lib.name} (${docIds.length} documents)`;
      context = evenLibraryContext(lib.id, 30000);
    }

    const count = Math.min(Math.max(body.count ?? 12, 3), 30);

    // prior cards for this scope: prompt avoidance + hard dedup
    const priorWhere = body.documentId ? "document_id = ?" : "library_id = ?";
    const priorRows = db
      .prepare(
        `SELECT front FROM flashcards WHERE ${priorWhere} ORDER BY id DESC LIMIT 300`
      )
      .all(body.documentId ?? body.libraryId) as { front: string }[];
    const priorFronts = priorRows.map((r) => r.front);
    const avoidList = priorFronts
      .slice(0, 60)
      .map((f) => `- ${f.replace(/\s+/g, " ").slice(0, 100)}`)
      .join("\n");

    const raw = await aiComplete(
      flashcardMessages({
        title: sourceTitle,
        context,
        count: count + Math.min(4, count),
        avoid: avoidList || undefined,
      }),
      { temperature: 0.5, maxTokens: 4000 }
    );
    const parsed = extractJson<{ cards?: { front?: string; back?: string }[] }>(raw);
    const all = (parsed.cards ?? [])
      .map((c) => ({ front: String(c.front ?? "").trim(), back: String(c.back ?? "").trim() }))
      .filter((c) => c.front && c.back);
    const { fresh: cards, duplicatesRemoved } = dedupeAgainst(
      all,
      (c) => c.front,
      priorFronts,
      0.78
    );
    const kept = cards.slice(0, count);
    if (!kept.length) {
      throw new Error(
        duplicatesRemoved > 0
          ? "The model only repeated cards you already have — try generating from a different document."
          : "Model returned no cards"
      );
    }

    const ins = db.prepare(
      "INSERT INTO flashcards (document_id, library_id, front, back, deck_id, created_at, due_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    );
    const deckId = randomUUID();
    db.transaction(() =>
      kept.forEach((c) =>
        ins.run(body.documentId ?? null, body.libraryId ?? null, c.front, c.back, deckId)
      )
    )();

    const where = body.documentId
      ? "document_id = ?"
      : "library_id = ?";
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM flashcards WHERE ${where}`)
      .get(body.documentId ?? body.libraryId) as { n: number };
    return NextResponse.json({
      added: kept.length,
      total: Number(totalRow.n),
      deckId,
      duplicatesRemoved,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
