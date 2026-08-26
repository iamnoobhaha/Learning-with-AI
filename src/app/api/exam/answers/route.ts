import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { evenContext } from "@/lib/context";
import { referenceAnswersMessages } from "@/lib/prompts";
import { aiComplete, extractJson } from "@/lib/ai";
import type { AnswersContent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { documentId?: string };
    if (!body.documentId) {
      return NextResponse.json({ error: "documentId required" }, { status: 400 });
    }
    const doc = db
      .prepare("SELECT id, title FROM documents WHERE id = ?")
      .get(body.documentId) as { id: string; title: string } | undefined;
    if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

    const raw = await aiComplete(
      referenceAnswersMessages({
        paperTitle: doc.title,
        paperContext: evenContext(doc.id, 48000),
      }),
      { temperature: 0.3, maxTokens: 6000 }
    );
    const parsed = extractJson<AnswersContent>(raw);
    if (!parsed?.answers?.length) throw new Error("Model returned no answers");

    const id = randomUUID();
    db.prepare(
      "INSERT INTO exams (id, kind, title, source_doc_id, content) VALUES (?, 'answers', ?, ?, ?)"
    ).run(
      id,
      `Answers — ${String(parsed.paper_title || doc.title).slice(0, 200)}`,
      doc.id,
      JSON.stringify(parsed)
    );
    return NextResponse.json({ examId: id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
