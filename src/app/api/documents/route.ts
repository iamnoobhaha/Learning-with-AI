import { NextResponse } from "next/server";
import db from "@/lib/db";
import { findOrCreateLibrary } from "@/lib/libraries";
import { ingestDocument } from "@/lib/ingest";
import { MAX_UPLOAD_BYTES, UploadValidationError, sanitizeFilename } from "@/lib/storage";
import { DocumentExtractionError } from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const rows = db
    .prepare(
      `SELECT id, kind, title, filename, size, pages, library_id, created_at,
              page_model, selection_revision, needs_reprocessing
       FROM documents ORDER BY created_at DESC, id DESC`
    )
    .all();
  return NextResponse.json({ documents: rows });
}

export async function POST(req: Request) {
  let storedFileId: string | null = null;
  try {
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (contentLength > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: `That file is ${(contentLength / 1024 / 1024).toFixed(1)}MB, above the ${Math.round(
            MAX_UPLOAD_BYTES / 1024 / 1024
          )}MB limit.`,
        },
        { status: 413 }
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB, above the ${Math.round(
            MAX_UPLOAD_BYTES / 1024 / 1024
          )}MB limit.`,
        },
        { status: 413 }
      );
    }

    const kind = form.get("kind") === "past_paper" ? "past_paper" : "notes";
    const originalName = sanitizeFilename(String(form.get("title") || "") || file.name);
    const title =
      String(form.get("title") || "").trim() ||
      sanitizeFilename(file.name).replace(/\.[^.]+$/, "");

    let libraryId: string | null = null;
    const rawLibraryId = String(form.get("libraryId") || "").trim();
    const libraryName = String(form.get("libraryName") || "").trim();
    if (rawLibraryId) {
      const lib = db
        .prepare("SELECT id FROM libraries WHERE id = ?")
        .get(rawLibraryId) as { id: string } | undefined;
      if (!lib) return NextResponse.json({ error: "Library not found" }, { status: 404 });
      libraryId = lib.id;
    } else if (libraryName) {
      libraryId = findOrCreateLibrary(libraryName).id;
    }

    const buf = Buffer.from(await file.arrayBuffer());
    void originalName;

    const result = await ingestDocument(buf, {
      kind,
      title,
      filename: file.name,
      libraryId,
      declaredMime: file.type,
    });
    storedFileId = result.documentId;

    return NextResponse.json(
      {
        id: result.documentId,
        libraryId,
        pages: result.pageCount,
        pageModel: result.pageModel,
        suggestedExclusions: result.suggestedExclusions,
        noTextPages: result.noTextPages,
        erroredPages: result.erroredPages,
      },
      { status: 201 }
    );
  } catch (err) {
    // Defence in depth: if ingestion created a row before failing, remove it so
    // we never leave a half-uploaded document behind.
    if (storedFileId) {
      try {
        db.prepare("DELETE FROM documents WHERE id = ?").run(storedFileId);
      } catch {
        // best effort
      }
    }

    if (err instanceof UploadValidationError) {
      // Covers UnsupportedFileTypeError, which extends it.
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof DocumentExtractionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Upload failed";
    // Never leak stack traces or filesystem paths to the client.
    return NextResponse.json(
      { error: message.startsWith("No ") || message.includes("could not") ? message : `Upload failed: ${message}` },
      { status: 500 }
    );
  }
}