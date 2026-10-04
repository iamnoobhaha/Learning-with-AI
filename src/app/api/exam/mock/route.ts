import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import {
  buildContext,
  documentScopeName,
  libraryScopeName,
  NoIncludedContentError,
  resolveDocumentIds,
} from "@/lib/ai-context";
import { mockExamMessages } from "@/lib/prompts";
import { aiComplete, extractJson } from "@/lib/ai";
import type { MockExamContent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    let body: {
      sourceDocId?: string;
      sourceLibraryId?: string;
      sampleDocId?: string;
      topic?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if ((!body.sourceDocId && !body.sourceLibraryId) || !body.sampleDocId) {
      return NextResponse.json(
        { error: "sourceDocId or sourceLibraryId (your notes), and sampleDocId (past paper) are required" },
        { status: 400 }
      );
    }
    const sample = db
      .prepare("SELECT id, title FROM documents WHERE id = ?")
      .get(body.sampleDocId) as { id: string; title: string } | undefined;
    if (!sample) {
      return NextResponse.json({ error: "Sample past paper not found" }, { status: 404 });
    }

    // Both the notes and the sample paper go through the same included-page
    // filter: an excluded page cannot influence the generated exam.
    let notesTitle: string;
    let notesContext: string;
    let sampleContext: string;
    try {
      const notes = buildContext({
        documentId: body.sourceDocId,
        libraryId: body.sourceLibraryId,
        maxChars: 26000,
        coverage: true,
        scopeName: body.sourceDocId
          ? documentScopeName(body.sourceDocId)
          : libraryScopeName(body.sourceLibraryId!),
      });
      const sampleBuilt = buildContext({
        documentId: sample.id,
        maxChars: 18000,
        coverage: true,
        scopeName: documentScopeName(sample.id),
      });
      notesTitle = body.sourceDocId
        ? documentScopeName(body.sourceDocId).replace(/"/g, "")
        : libraryScopeName(body.sourceLibraryId!).replace(/"/g, "");
      notesContext = notes.text;
      sampleContext = sampleBuilt.text;
    } catch (err) {
      if (err instanceof NoIncludedContentError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof Error && /not found/i.test(err.message)) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      return NextResponse.json({ error: "Could not read the selected pages" }, { status: 400 });
    }

    const raw = await aiComplete(
      mockExamMessages({
        notesTitle,
        notesContext,
        sampleTitle: sample.title,
        sampleContext,
        topic: body.topic?.trim().slice(0, 200) || undefined,
      }),
      { temperature: 0.55, maxTokens: 6000 }
    );
    const exam = extractJson<MockExamContent>(raw);
    if (!exam?.sections?.length) throw new Error("Model returned no exam sections");

    // exams.source_doc_id is NOT NULL; a library-sourced exam anchors to the first doc in the library
    let anchorDocId = body.sourceDocId ?? null;
    if (!anchorDocId) {
      anchorDocId = resolveDocumentIds({ libraryId: body.sourceLibraryId })[0] ?? null;
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
