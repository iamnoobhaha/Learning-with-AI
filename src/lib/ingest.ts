import db from "./db";
import { buildChunksForPage, estimateTokens } from "./chunking";
import { extractFile, type ExtractResult, type ExtractedUnit } from "./extract";
import {
  storeOriginal,
  assertSupported,
  assertSafeArchiveSize,
  assertNotEncryptedPdf,
  deleteOriginal,
} from "./storage";
import { detectLowValue } from "./quality";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface IngestOptions {
  kind: "notes" | "past_paper";
  title: string;
  filename: string;
  libraryId: string | null;
  declaredMime: string;
}

export interface IngestResult {
  documentId: string;
  pageCount: number;
  pageModel: string;
  suggestedExclusions: number;
  noTextPages: number;
  erroredPages: number;
}

const CHUNK_MAX_TOKENS = 700;

/**
 * Persists a document, its page-level selection units and the derived chunks.
 * Everything happens in one transaction so a failure can never leave a document
 * with pages but no chunks (or vice versa). The uploaded original is written
 * first and removed if ingestion fails, so no orphaned files accumulate.
 */
export async function ingestDocument(
  buf: Buffer,
  opts: IngestOptions
): Promise<IngestResult> {
  const safeName = path.basename(opts.filename);
  const { mime } = assertSupported(safeName, buf);
  const ext = safeName.toLowerCase();
  if (
    ext.endsWith(".docx") ||
    ext.endsWith(".pptx") ||
    ext.endsWith(".xlsx") ||
    ext.endsWith(".xls")
  ) {
    assertSafeArchiveSize(buf);
  }
  if (ext.endsWith(".pdf")) assertNotEncryptedPdf(buf);

  const stored = storeOriginal(safeName, buf, mime);

  let result: ExtractResult;
  try {
    result = await extractFile(safeName, mime, buf);
  } catch (err) {
    // Clean up the original before surfacing the failure: no partial files.
    deleteOriginal(stored.storedName);
    throw err;
  }

  const units = result.units;
  if (!units.length) {
    deleteOriginal(stored.storedName);
    throw new Error("No readable content was found in this file.");
  }

  const documentId = randomUUID();
  let suggestedExclusions = 0;
  let noTextPages = 0;
  let erroredPages = 0;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO documents
         (id, kind, title, filename, size, pages, content, library_id,
          page_model, selection_revision, original_path, original_mime, needs_reprocessing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)`
    ).run(
      documentId,
      opts.kind,
      opts.title.slice(0, 250),
      safeName.slice(0, 250),
      stored.size,
      result.pageCount,
      result.text,
      opts.libraryId,
      result.pageModel,
      stored.storedName,
      mime
    );

    const insertPage = db.prepare(
      `INSERT INTO document_pages
         (document_id, page_number, page_type, label, text, included,
          suggested_exclude, exclusion_reason, extraction_status, extraction_error,
          structured_preview, text_length)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
    );
    const insertChunk = db.prepare(
      `INSERT INTO chunks (document_id, idx, text, block_index, included, page_id, page_number, token_estimate)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
    );

    let chunkIdx = 0;
    units.forEach((unit) => {
      const verdict = detectLowValue(unit);
      if (verdict.suggestExclude) suggestedExclusions += 1;
      if (unit.status === "no_text") noTextPages += 1;
      if (unit.status === "error") erroredPages += 1;

      const pageInfo = insertPage.run(
        documentId,
        unit.number,
        unit.type,
        unit.label,
        unit.text,
        verdict.suggestExclude ? 1 : 0,
        verdict.reason,
        unit.status,
        unit.error ?? null,
        unit.slide ? JSON.stringify(unit.slide) : null,
        unit.text.length
      );
      const pageId = Number(pageInfo.lastInsertRowid);

      const chunks = buildChunksForPage(
        {
          pageId,
          pageNumber: unit.number,
          pageLabel: unit.label,
          docId: documentId,
          docTitle: opts.title,
        },
        unit.text,
        CHUNK_MAX_TOKENS
      );

      for (const chunk of chunks) {
        insertChunk.run(
          documentId,
          chunkIdx++,
          chunk.text,
          unit.number - 1,
          pageId,
          unit.number,
          chunk.tokenEstimate || estimateTokens(chunk.text)
        );
      }
    });
  })();

  return {
    documentId,
    pageCount: result.pageCount ?? units.length,
    pageModel: result.pageModel,
    suggestedExclusions,
    noTextPages,
    erroredPages,
  };
}

export type { ExtractResult, ExtractedUnit };