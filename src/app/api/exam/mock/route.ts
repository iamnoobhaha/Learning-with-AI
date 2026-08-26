import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { evenContext, evenLibraryContext, docIdsInLibrary } from "@/lib/context";
import { mockExamMessages } from "@/lib/prompts";
import { aiComplete, extractJson } from "@/lib/ai";
import type { MockExamContent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      sourceDocId?: string;
      sourceLibraryId?: string;
      sampleDocId?: string;
      topic?: string;
    };
    if ((!body.sourceDocId && !body.sourceLibraryId) || !body.sampleDocId) {
      return NextResponse.json(
        { error: "sourceDocId or sourceLibraryId (your notes), and sampleDocId (past paper) are required" },
        { status: 400 }
      );
    }
    const getDoc = db.prepare("SELECT id, title FROM documents WHERE id = ?");
    const sample = body.sampleDocId
      ? (getDoc.get(body.sampleDocId) as { id: string; title: string } | undefined)
      : undefined;
    if (!sample) {
      return NextResponse.json({ error: "Sample past paper not found" }, { status: 404 });
    }

    let notesTitle: string;
    let notesContext: string;
    if (body.sourceDocId) {
      const source = getDoc.get(body.sourceDocId) as { id: string; title: string } | undefined;
      if (!source) return NextResponse.json({ error: "Notes document not found" }, { status: 404 });
      notesTitle = source.title;
      notesContext = evenContext(source.id, 30000);
    } else {
      const lib = db
        .prepare("SELECT id, name FROM libraries WHERE id = ?")
        .get(body.sourceLibraryId!) as { id: string; name: string } | undefined;
      if (!lib) return NextResponse.json({ error: "Library not found" }, { status: 404 });
      const docIds = docIdsInLibrary(lib.id);
      if (!docIds.length) {
        return NextResponse.json({ error: "That library has no documents yet" }, { status: 400 });
      }
      notesTitle = `${lib.name} (${docIds.length} documents)`;
      notesContext = evenLibraryContext(lib.id, 34000);
    }

    const raw = await aiComplete(
      mockExamMessages({
        notesTitle,
        notesContext,
        sampleTitle: sample.title,
        sampleContext: evenContext(sample.id, 22000),
        topic: body.topic?.trim().slice(0, 200) || undefined,
      }),
      { temperature: 0.55, maxTokens: 6000 }
    );
    const exam = extractJson<MockExamContent>(raw);
    if (!exam?.sections?.length) throw new Error("Model returned no exam sections");

    // exams.source_doc_id is NOT NULL; a library-sourced exam anchors to the first doc in the library
    let anchorDocId = body.sourceDocId ?? null;
    if (!anchorDocId) {
      anchorDocId = docIdsInLibrary(body.sourceLibraryId!)[0] ?? null;
    }
    if (!anchorDocId) {
      return NextResponse.json({ error: "No documents available" }, { status: 400 });
    }

    const id = randomUUID();
    db.prepare(
      "INSERT INTO exams (id, kind, title, source_doc_id, sample_doc_id, content) VALUES (?, 'mock', ?, ?, ?, ?)"
    ).run(
      id,
      String(exam.title || `Mock exam based on ${sample.title}`).slice(0, 250),
      anchorDocId,
      sample.id,
      JSON.stringify(exam)
    );
    return NextResponse.json({ examId: id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
