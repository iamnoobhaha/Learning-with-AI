import { NextResponse } from "next/server";
import db from "@/lib/db";
import { readOriginal } from "@/lib/storage";
import type { DocumentPageRow } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface PageSummary {
  id: number;
  pageNumber: number;
  pageType: string;
  label: string;
  included: boolean;
  suggestedExclude: boolean;
  exclusionReason: string | null;
  extractionStatus: "ok" | "no_text" | "error" | "pending";
  extractionError: string | null;
  textLength: number;
  preview: string;
  hasStructuredPreview: boolean;
  hasImage: boolean;
  hasNotes: boolean;
  charCount: number;
}

export interface PagesPayload {
  documentId: string;
  documentTitle: string;
  filename: string;
  pageModel: "paginated" | "sectioned";
  pageCount: number;
  selectionRevision: number;
  needsReprocessing: boolean;
  hasOriginal: boolean;
  visualPreviewAvailable: boolean;
  visualPreviewReason: string | null;
  includedCount: number;
  excludedCount: number;
  includedChars: number;
  totalChars: number;
  noTextCount: number;
  errorCount: number;
  pages: PageSummary[];
}

function buildPreview(text: string, limit = 260): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  const doc = db
    .prepare(
      `SELECT id, title, filename, page_model, selection_revision,
              original_path, needs_reprocessing
       FROM documents WHERE id = ?`
    )
    .get(id) as
    | {
        id: string;
        title: string;
        filename: string;
        page_model: string;
        selection_revision: number;
        original_path: string | null;
        needs_reprocessing: number;
      }
    | undefined;

  if (!doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const rows = db
    .prepare(
      `SELECT p.* FROM document_pages p
       WHERE p.document_id = ?
       ORDER BY p.page_number ASC`
    )
    .all(id) as DocumentPageRow[];

  const pages: PageSummary[] = rows.map((p) => {
    const structured = parseStructuredPreview(p.structured_preview ?? null);
    return {
      id: p.id,
      pageNumber: p.page_number,
      pageType: p.page_type,
      label: p.label,
      included: p.included === 1,
      suggestedExclude: p.suggested_exclude === 1,
      exclusionReason: p.exclusion_reason,
      extractionStatus: p.extraction_status,
      extractionError: p.extraction_error,
      textLength: p.text_length,
      preview: buildPreview(p.text),
      hasStructuredPreview: Boolean(structured),
      hasImage: structured?.hasImage ?? false,
      hasNotes: Boolean(structured?.notes),
      charCount: p.text_length,
    };
  });

  const included = pages.filter((p) => p.included);
  const visual = doc.original_path ? Boolean(readOriginal(doc.original_path)) : false;
  const isPdf = doc.filename.toLowerCase().endsWith(".pdf");
  const isPptx = doc.filename.toLowerCase().endsWith(".pptx");

  let visualPreviewReason: string | null = null;
  if (!doc.original_path) {
    visualPreviewReason =
      "This document was uploaded before page previews were available and its original file was not stored. Re-upload it to enable visual page previews.";
  } else if (!visual) {
    visualPreviewReason =
      "The stored original file is missing, so visual previews cannot be rendered. Re-upload the document to restore them.";
  } else if (isPptx) {
    visualPreviewReason =
      "PowerPoint previews are structured summaries (title, bullets, images and speaker notes) rather than pixel-accurate slide images, because rendering PPTX to an image requires LibreOffice, which is not installed.";
  }

  const payload: PagesPayload = {
    documentId: doc.id,
    documentTitle: doc.title,
    filename: doc.filename,
    pageModel: (doc.page_model as "paginated" | "sectioned") ?? "sectioned",
    pageCount: pages.length,
    selectionRevision: doc.selection_revision,
    needsReprocessing: doc.needs_reprocessing === 1,
    hasOriginal: Boolean(doc.original_path),
    visualPreviewAvailable: isPdf && visual,
    visualPreviewReason,
    includedCount: included.length,
    excludedCount: pages.length - included.length,
    includedChars: included.reduce((n, p) => n + p.charCount, 0),
    totalChars: pages.reduce((n, p) => n + p.charCount, 0),
    noTextCount: pages.filter((p) => p.extractionStatus === "no_text").length,
    errorCount: pages.filter((p) => p.extractionStatus === "error").length,
    pages,
  };

  return NextResponse.json(payload);
}

interface SlideStructured {
  title: string | null;
  bullets: string[];
  hasImage: boolean;
  hasTable: boolean;
  hasChart: boolean;
  notes: string | null;
}

/**
 * Slide previews are stored as structured metadata in their own column, never
 * inside `text`, so slide body text stays clean for AI context while the UI can
 * still render a faithful structured card (title, bullets, image/table/chart
 * indicators and speaker notes).
 */
function parseStructuredPreview(raw: string | null): SlideStructured | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SlideStructured;
  } catch {
    return null;
  }
}

interface SelectionUpdate {
  pageId?: number;
  included?: boolean;
  allIncluded?: boolean;
  invert?: boolean;
  pageIds?: number[];
  pageNumbers?: number[];
  includeNumbers?: number[];
  excludeNumbers?: number[];
  range?: { from: number; to: number; included: boolean };
  applySuggestions?: boolean;
}

/**
 * Bulk-aware selection update. All changes run in one transaction and bump the
 * document's selection_revision so previously generated material can be flagged
 * stale. Returns 400 rather than silently producing an empty selection.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  let body: SelectionUpdate;
  try {
    body = (await req.json()) as SelectionUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const doc = db
    .prepare("SELECT id, selection_revision FROM documents WHERE id = ?")
    .get(id) as { id: string; selection_revision: number } | undefined;
  if (!doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const setOne = db.prepare(
    "UPDATE document_pages SET included = ?, updated_at = datetime('now') WHERE document_id = ? AND id = ?"
  );

  let changed = 0;
  try {
    db.transaction(() => {
      if (typeof body.allIncluded === "boolean") {
        changed = db
          .prepare("UPDATE document_pages SET included = ?, updated_at = datetime('now') WHERE document_id = ?")
          .run(body.allIncluded ? 1 : 0, id).changes;
      }

      if (body.invert) {
        changed += db
          .prepare(
            "UPDATE document_pages SET included = CASE included WHEN 1 THEN 0 ELSE 1 END, updated_at = datetime('now') WHERE document_id = ?"
          )
          .run(id).changes;
      }

      if (body.applySuggestions) {
        changed += db
          .prepare(
            "UPDATE document_pages SET included = 0, updated_at = datetime('now') WHERE document_id = ? AND suggested_exclude = 1"
          )
          .run(id).changes;
      }

      if (body.range && typeof body.range.from === "number" && typeof body.range.to === "number") {
        const from = Math.max(1, Math.floor(body.range.from));
        const to = Math.max(from, Math.floor(body.range.to));
        changed += db
          .prepare(
            "UPDATE document_pages SET included = ?, updated_at = datetime('now') WHERE document_id = ? AND page_number BETWEEN ? AND ?"
          )
          .run(body.range.included ? 1 : 0, id, from, to).changes;
      }

      if (Array.isArray(body.pageNumbers) && body.pageNumbers.length && typeof body.included === "boolean") {
        const stmt = db.prepare(
          "UPDATE document_pages SET included = ?, updated_at = datetime('now') WHERE document_id = ? AND page_number = ?"
        );
        for (const n of body.pageNumbers) {
          if (Number.isFinite(n)) changed += stmt.run(body.included ? 1 : 0, id, Math.floor(n)).changes;
        }
      }

      // Explicit include/exclude lists, so a mixed batch is applied correctly in
      // a single request (one network call per bulk action, not per page).
      if (Array.isArray(body.includeNumbers) && body.includeNumbers.length) {
        const stmt = db.prepare(
          "UPDATE document_pages SET included = 1, updated_at = datetime('now') WHERE document_id = ? AND page_number = ?"
        );
        for (const n of body.includeNumbers) {
          if (Number.isFinite(n)) changed += stmt.run(id, Math.floor(n)).changes;
        }
      }
      if (Array.isArray(body.excludeNumbers) && body.excludeNumbers.length) {
        const stmt = db.prepare(
          "UPDATE document_pages SET included = 0, updated_at = datetime('now') WHERE document_id = ? AND page_number = ?"
        );
        for (const n of body.excludeNumbers) {
          if (Number.isFinite(n)) changed += stmt.run(id, Math.floor(n)).changes;
        }
      }

      if (Array.isArray(body.pageIds) && body.pageIds.length && typeof body.included === "boolean") {
        for (const pid of body.pageIds) {
          if (Number.isFinite(pid)) changed += setOne.run(body.included ? 1 : 0, id, Math.floor(pid)).changes;
        }
      }

      if (typeof body.pageId === "number" && typeof body.included === "boolean") {
        changed += setOne.run(body.included ? 1 : 0, id, Math.floor(body.pageId)).changes;
      }
    })();
  } catch {
    return NextResponse.json({ error: "Could not update page selection" }, { status: 500 });
  }

  if (!changed) {
    return NextResponse.json({ error: "No pages matched that update" }, { status: 400 });
  }

  // Refuse to leave a document with nothing studyable selected.
  const remaining = db
    .prepare(
      "SELECT COUNT(*) AS n FROM document_pages WHERE document_id = ? AND included = 1 AND text_length > 0"
    )
    .get(id) as { n: number };
  if (Number(remaining.n) === 0) {
    return NextResponse.json(
      {
        error:
          "At least one page with study content must stay included, otherwise there is nothing for the AI to use.",
      },
      { status: 400 }
    );
  }

  const revision = db
    .prepare("UPDATE documents SET selection_revision = selection_revision + 1 WHERE id = ? RETURNING selection_revision")
    .get(id) as { selection_revision: number } | undefined;

  return NextResponse.json({
    ok: true,
    changed,
    selectionRevision: revision?.selection_revision ?? doc.selection_revision + 1,
  });
}