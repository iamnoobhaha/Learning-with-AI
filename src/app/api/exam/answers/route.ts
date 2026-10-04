import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import {
  buildContext,
  documentScopeName,
  NoIncludedContentError,
} from "@/lib/ai-context";
import { referenceAnswersMessages } from "@/lib/prompts";
import { aiComplete, extractJson } from "@/lib/ai";
import type { AnswersContent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    let body: { documentId?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body.documentId) {
      return NextResponse.json({ error: "documentId required" }, { status: 400 });
    }
    const doc = db
      .prepare("SELECT id, title FROM documents WHERE id = ?")
      .get(body.documentId) as { id: string; title: string } | undefined;
    if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

    // Only pages the user included can inform the mark scheme.
    let paperContext: string;
    try {
      paperContext = buildContext({
        documentId: doc.id,
        maxChars: 42000,
        coverage: true,
        scopeName: documentScopeName(doc.id),
      }).text;
    } catch (err) {
      if (err instanceof NoIncludedContentError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      return NextResponse.json({ error: "Could not read the selected pages" }, { status: 400 });
    }

    const raw = await aiComplete(
      referenceAnswersMessages({
        paperTitle: doc.title,
        paperContext,
      }),
      { temperature: 0.3, maxTokens: 6000 }
    );
    const parsed = extractJson<AnswersContent>(raw);
    if (!parsed?.answers?.length) throw new Error("Model returned no answers");

    const revision =
      (
        db
          .prepare("SELECT selection_revision FROM documents WHERE id = ?")
          .get(doc.id) as { selection_revision: number } | undefined
      )?.selection_revision ?? 1;

    const id = randomUUID();
    db.prepare(
      "INSERT INTO exams (id, kind, title, source_doc_id, content, selection_revision) VALUES (?, 'answers', ?, ?, ?, ?)"
    ).run(
      id,
      `Answers — ${String(parsed.paper_title || doc.title).slice(0, 200)}`,
      doc.id,
      JSON.stringify(parsed),
      revision
    );
    return NextResponse.json({ examId: id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
