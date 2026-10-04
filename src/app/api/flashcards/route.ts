import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { flashcardMessages } from "@/lib/prompts";
import { aiComplete, extractJson } from "@/lib/ai";
import { dedupeAgainst } from "@/lib/dedup";
import {
  buildContext,
  documentScopeName,
  libraryScopeName,
  NoIncludedContentError,
  summariseSources,
} from "@/lib/ai-context";

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
    let body: { documentId?: string; libraryId?: string; count?: number; pageFrom?: number; pageTo?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body.documentId && !body.libraryId) {
      return NextResponse.json(
        { error: "documentId or libraryId required" },
        { status: 400 }
      );
    }

    let built;
    try {
      built = buildContext({
        documentId: body.documentId,
        libraryId: body.libraryId,
        maxChars: 24000,
        coverage: true,
        pageRange: body.pageFrom || body.pageTo ? { from: body.pageFrom, to: body.pageTo } : undefined,
        scopeName: body.documentId
          ? documentScopeName(body.documentId)
          : libraryScopeName(body.libraryId!),
      });
    } catch (err) {
      if (err instanceof NoIncludedContentError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof Error && /not found/i.test(err.message)) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      return NextResponse.json({ error: "Could not read the selected pages" }, { status: 400 });
    }

    const context = built.text;
    const sourceTitle = body.documentId
      ? documentScopeName(body.documentId).replace(/"/g, "")
      : libraryScopeName(body.libraryId!).replace(/"/g, "");
    const sourcePages = summariseSources(built.sources);

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

    const revision = body.documentId
      ? ((
          db
            .prepare("SELECT selection_revision FROM documents WHERE id = ?")
            .get(body.documentId) as { selection_revision: number } | undefined
        )?.selection_revision ?? 1)
      : Number(
          (
            db
              .prepare(
                "SELECT COALESCE(MAX(selection_revision), 1) AS m FROM documents WHERE library_id = ?"
              )
              .get(body.libraryId) as { m: number }
          ).m
        ) || 1;

    const ins = db.prepare(
      `INSERT INTO flashcards
         (document_id, library_id, front, back, deck_id, created_at, due_at, selection_revision, source_pages)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)`
    );
    const deckId = randomUUID();
    db.transaction(() =>
      kept.forEach((c) =>
        ins.run(
          body.documentId ?? null,
          body.libraryId ?? null,
          c.front,
          c.back,
          deckId,
          revision,
          sourcePages || null
        )
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
      sourcePages: sourcePages || null,
      pagesUsed: built.sources.length,
      pagesIncluded: built.includedPages,
      truncated: built.truncated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
