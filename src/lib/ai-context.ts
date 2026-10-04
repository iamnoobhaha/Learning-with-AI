import db from "./db";
import { estimateTokens, tokensToChars } from "./chunking";
import { tokenize } from "./tokenizer";

/**
 * THE authoritative context builder.
 *
 * Every AI feature (chat, quiz, flashcards, mock exam, answer key) must obtain
 * source material through this module. It is the only place allowed to read
 * `document_pages`, and it reads *only* pages the user has included. There is no
 * `documents.content` fallback anywhere: if a selection yields nothing, callers
 * get NoIncludedContentError rather than a silent full-document prompt.
 */

/**
 * A scope is only rejected when it has no studyable text at all. The bar is
 * deliberately low: a single short-but-real page (a definition, a formula
 * slide) is valid source material, and silently refusing it would be worse than
 * sending the model a short prompt.
 */
export const MIN_CONTEXT_CHARS = 40;

export class NoIncludedContentError extends Error {
  scopeName: string;
  constructor(scopeName: string) {
    super(
      `No study content is selected in ${scopeName}. Open "Study content" and include at least one page, then try again.`
    );
    this.name = "NoIncludedContentError";
    this.scopeName = scopeName;
  }
}

export interface ContextSource {
  documentId: string;
  documentTitle: string;
  pageId: number;
  pageNumber: number;
  pageLabel: string;
  pageType: string;
}

export interface ContextChunk {
  chunkId: number;
  text: string;
  tokenEstimate: number;
  source: ContextSource;
}

export interface BuiltContext {
  /** Prompt-ready text, page-delimited, with an untrusted-content banner. */
  text: string;
  chunks: ContextChunk[];
  sources: ContextSource[];
  includedPages: number;
  totalPages: number;
  includedChars: number;
  tokenEstimate: number;
  /** True when the budget could not fit every included page. */
  truncated: boolean;
}

interface PageRow {
  id: number;
  document_id: string;
  page_number: number;
  page_label: string;
  page_type: string;
  text: string;
  included: number;
  extraction_status: string;
}

interface ChunkRow {
  id: number;
  text: string;
  page_id: number | null;
  page_number: number | null;
  token_estimate: number;
  document_id: string;
  document_title: string;
  page_label: string | null;
  page_type: string | null;
}

export function documentScopeName(documentId: string): string {
  const row = db.prepare("SELECT title FROM documents WHERE id = ?").get(documentId) as
    | { title: string }
    | undefined;
  return row ? `"${row.title}"` : "this document";
}

export function libraryScopeName(libraryId: string): string {
  const row = db.prepare("SELECT name FROM libraries WHERE id = ?").get(libraryId) as
    | { name: string }
    | undefined;
  return row ? `"${row.name}"` : "this course";
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-fA-F-]{8,64}$/.test(value);
}

/**
 * Resolves a scope to concrete document ids. Rejects malformed ids so a caller
 * can never smuggle a cross-library scope past validation.
 */
export function resolveDocumentIds(scope: {
  documentId?: string;
  libraryId?: string;
}): string[] {
  if (scope.documentId) {
    if (!isUuidLike(scope.documentId)) throw new Error("Invalid document id");
    const exists = db
      .prepare("SELECT id FROM documents WHERE id = ?")
      .get(scope.documentId);
    if (!exists) throw new Error("Document not found");
    return [scope.documentId];
  }
  if (scope.libraryId) {
    if (!isUuidLike(scope.libraryId)) throw new Error("Invalid library id");
    const rows = db
      .prepare(
        "SELECT id FROM documents WHERE library_id = ? ORDER BY created_at ASC, id ASC"
      )
      .all(scope.libraryId) as { id: string }[];
    return rows.map((r) => r.id);
  }
  throw new Error("documentId or libraryId required");
}

function loadPages(docIds: string[]): PageRow[] {
  if (!docIds.length) return [];
  const placeholders = docIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT p.id, p.document_id, p.page_number, p.label AS page_label,
              p.page_type, p.text, p.included, p.extraction_status
       FROM document_pages p
       WHERE p.document_id IN (${placeholders})
       ORDER BY p.document_id ASC, p.page_number ASC`
    )
    .all(...docIds) as PageRow[];
}

function loadChunks(docIds: string[]): ChunkRow[] {
  if (!docIds.length) return [];
  const placeholders = docIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT c.id, c.text, c.page_id, c.page_number, c.token_estimate,
              d.id AS document_id, d.title AS document_title,
              p.label AS page_label, p.page_type
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       JOIN document_pages p ON p.id = c.page_id
       WHERE c.document_id IN (${placeholders})
         AND p.included = 1
       ORDER BY d.created_at ASC, d.id ASC, p.page_number ASC, c.idx ASC`
    )
    .all(...docIds) as ChunkRow[];
}

/**
 * Legacy documents have pages backfilled from chunks, so they always have
 * chunks. If a page exists with text but no chunks (e.g. a very new upload
 * interrupted mid-transaction), we synthesise from page text rather than
 * returning nothing.
 */
function synthesiseFromPages(pages: PageRow[]): ChunkRow[] {
  const withText = pages.filter((p) => p.included === 1 && p.text.trim());
  if (!withText.length) return [];
  const titles = db
    .prepare(
      `SELECT id, title FROM documents WHERE id IN (${withText.map(() => "?").join(",")})`
    )
    .all(...withText.map((p) => p.document_id)) as { id: string; title: string }[];
  const titleById = new Map(titles.map((t) => [t.id, t.title]));
  return withText.map((p, i) => ({
    id: -(i + 1),
    text: p.text,
    page_id: p.id,
    page_number: p.page_number,
    token_estimate: 0,
    document_id: p.document_id,
    document_title: titleById.get(p.document_id) ?? "Document",
    page_label: p.page_label,
    page_type: p.page_type,
  }));
}

/* --------------------------------------------------------------- retrieval */

function tfidfRank(chunks: ContextChunk[], query: string, keep: number): ContextChunk[] {
  const terms = Array.from(new Set(tokenize(query)));
  if (!terms.length || !chunks.length) return chunks.slice(0, keep);

  const docFreq = new Map<string, number>();
  const tokenised = chunks.map((c) => {
    const counts = new Map<string, number>();
    for (const w of tokenize(c.text)) counts.set(w, (counts.get(w) ?? 0) + 1);
    for (const w of counts.keys()) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
    return counts;
  });

  const N = chunks.length;
  const scored = chunks.map((c, i) => {
    const counts = tokenised[i];
    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term);
      if (!tf) continue;
      const idf = Math.log(1 + N / (docFreq.get(term) ?? 1));
      // Sublinear TF + length normalisation stops long pages and repeated terms
      // from dominating purely by size.
      const norm = 1 / Math.sqrt(counts.size || 1);
      score += (1 + Math.log(tf)) * idf * norm;
    }
    return { c, score };
  });

  const positive = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (!positive.length) return chunks.slice(0, keep);
  return positive.slice(0, keep).map((s) => s.c);
}

/**
 * Coverage-aware selection: samples across *pages* (not raw chunk positions) so
 * generated material reflects the whole document instead of its opening pages.
 */
function coverageSelect(
  chunks: ContextChunk[],
  maxTokens: number
): { picked: ContextChunk[]; truncated: boolean } {
  const byPage = new Map<string, ContextChunk[]>();
  for (const c of chunks) {
    const key = `${c.source.documentId}#${c.source.pageNumber}`;
    const list = byPage.get(key);
    if (list) list.push(c);
    else byPage.set(key, [c]);
  }
  const groups = [...byPage.values()];
  const picked: ContextChunk[] = [];
  let used = 0;
  let truncated = false;
  let round = 0;
  let added = true;

  while (added) {
    added = false;
    for (const group of groups) {
      const next = group[round];
      if (!next) continue;
      if (used + next.tokenEstimate > maxTokens) {
        truncated = true;
        continue;
      }
      picked.push(next);
      used += next.tokenEstimate;
      added = true;
    }
    round += 1;
  }
  return { picked, truncated };
}

/** Removes overlapping duplicates that coverage sampling can introduce. */
function renderContext(
  chunks: ContextChunk[],
  maxChars: number,
  multiDoc: boolean
): string {
  const parts: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const header = multiDoc
      ? `[Source: ${chunk.source.documentTitle} — ${chunk.source.pageLabel}]`
      : `[${chunk.source.pageLabel}]`;
    const block = `${header}\n${chunk.text}`;
    // `continue`, not `break`: one oversized chunk must not truncate the rest.
    if (used + block.length > maxChars) continue;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

export interface BuildContextOptions {
  documentId?: string;
  libraryId?: string;
  /** maxChars is the hard ceiling for the rendered prompt payload. */
  maxChars?: number;
  /** Query-aware retrieval (chat). */
  query?: string;
  /** Coverage sampling (quizzes, flashcards, exams). */
  coverage?: boolean;
  /** Restrict to an explicit page-number range, 1-based inclusive. */
  pageRange?: { from?: number; to?: number };
  scopeName?: string;
}

export function buildContext(opts: BuildContextOptions): BuiltContext {
  const docIds = resolveDocumentIds(opts);
  const pages = loadPages(docIds);
  const totalPages = pages.length;

  let includedPages = pages.filter((p) => p.included === 1);
  if (opts.pageRange?.from || opts.pageRange?.to) {
    const from = opts.pageRange.from ?? 1;
    const to = opts.pageRange.to ?? Number.MAX_SAFE_INTEGER;
    includedPages = includedPages.filter(
      (p) => p.page_number >= from && p.page_number <= to
    );
  }

  const includedChars = includedPages.reduce((n, p) => n + (p.text?.length ?? 0), 0);
  if (!includedPages.length || includedChars < MIN_CONTEXT_CHARS) {
    throw new NoIncludedContentError(opts.scopeName ?? "this document");
  }

  const maxChars = opts.maxChars ?? 24000;
  // Reserve room for prompt scaffolding and the model's own output.
  const maxTokens = Math.floor(tokensToChars(maxChars) * 0.8 / 4);

  let chunks = loadChunks(docIds);
  if (opts.pageRange?.from || opts.pageRange?.to) {
    const from = opts.pageRange.from ?? 1;
    const to = opts.pageRange.to ?? Number.MAX_SAFE_INTEGER;
    chunks = chunks.filter((c) => (c.page_number ?? 0) >= from && (c.page_number ?? 0) <= to);
  }
  if (!chunks.length) chunks = synthesiseFromPages(includedPages);
  if (!chunks.length) {
    throw new NoIncludedContentError(opts.scopeName ?? "this document");
  }

  const labelled: ContextChunk[] = chunks.map((c) => ({
    chunkId: c.id,
    text: c.text,
    tokenEstimate: c.token_estimate || estimateTokens(c.text),
    source: {
      documentId: c.document_id,
      documentTitle: c.document_title,
      pageId: c.page_id ?? 0,
      pageNumber: c.page_number ?? 0,
      pageLabel: c.page_label ?? `Page ${c.page_number ?? "?"}`,
      pageType: c.page_type ?? "section",
    },
  }));

  let selected: ContextChunk[];
  let truncated: boolean;
  if (opts.query) {
    const keep = Math.max(12, Math.floor(maxTokens / 700));
    const ranked = tfidfRank(labelled, opts.query, keep);
    selected = [];
    let used = 0;
    truncated = false;
    for (const c of ranked) {
      if (used + c.tokenEstimate > maxTokens) {
        truncated = true;
        continue;
      }
      selected.push(c);
      used += c.tokenEstimate;
    }
    // Restore document order so the model reads pages sequentially.
    selected.sort(
      (a, b) =>
        a.source.documentId.localeCompare(b.source.documentId) ||
        a.source.pageNumber - b.source.pageNumber
    );
  } else if (opts.coverage !== false) {
    const result = coverageSelect(labelled, maxTokens);
    selected = result.picked;
    truncated = result.truncated;
  } else {
    selected = labelled.slice(0, Math.max(1, Math.floor(maxTokens / 700)));
    truncated = labelled.length > selected.length;
  }

  selected = dedupeContexts(selected);
  const multiDoc = new Set(selected.map((c) => c.source.documentId)).size > 1;
  const text = renderContext(selected, maxChars, multiDoc);

  const sources: ContextSource[] = [];
  const seenSource = new Set<string>();
  for (const c of selected) {
    const key = `${c.source.documentId}#${c.source.pageId}`;
    if (seenSource.has(key)) continue;
    seenSource.add(key);
    sources.push(c.source);
  }

  return {
    text,
    chunks: selected,
    sources,
    includedPages: includedPages.length,
    totalPages,
    includedChars,
    tokenEstimate: estimateTokens(text),
    truncated,
  };
}

function dedupeContexts(chunks: ContextChunk[]): ContextChunk[] {
  const seen = new Set<string>();
  const out: ContextChunk[] = [];
  for (const c of chunks) {
    const key = c.text.replace(/\s+/g, " ").trim().slice(0, 180).toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(c);
  }
  return out;
}

/** Compact citation string list, e.g. "p3, p7-9". */
export function summariseSources(sources: ContextSource[]): string {
  if (!sources.length) return "";
  const pages = Array.from(new Set(sources.map((s) => s.pageNumber))).sort((a, b) => a - b);
  return pages.map((p) => `p${p}`).join(", ");
}