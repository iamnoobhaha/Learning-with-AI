import db from "./db";

interface ChunkRow {
  id: number;
  idx: number;
  text: string;
  doc_id: string;
  doc_title: string;
}

const STOP = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was",
  "one", "our", "out", "his", "has", "have", "this", "that", "with", "from",
  "what", "when", "where", "which", "will", "your", "they", "their", "them",
  "then", "than", "there", "these", "those", "into", "also", "been", "were",
  "how", "why", "who", "its", "each", "any", "may", "should", "could", "would",
]);

export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const brk = text.lastIndexOf("\n", end);
      if (brk > start + 200) end = brk;
    }
    const slice = text.slice(start, end);
    if (slice.trim()) out.push(slice);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9'-]*/g) ?? []).filter(
    (w) => w.length > 2 && !STOP.has(w)
  );
}

function spread(rows: ChunkRow[], k: number): ChunkRow[] {
  if (rows.length <= k) return rows;
  const step = rows.length / k;
  return Array.from({ length: k }, (_, i) => rows[Math.floor(i * step)]);
}

export function docIdsInLibrary(libraryId: string): string[] {
  const rows = db
    .prepare("SELECT id FROM documents WHERE library_id = ? ORDER BY created_at ASC, id ASC")
    .all(libraryId) as { id: string }[];
  return rows.map((r) => r.id);
}

function chunksForDocs(docIds: string[]): ChunkRow[] {
  if (!docIds.length) return [];
  const placeholders = docIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT c.id, c.idx, c.text, d.id AS doc_id, d.title AS doc_title
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.document_id IN (${placeholders}) ORDER BY d.created_at ASC, d.id ASC, c.idx ASC`
    )
    .all(...docIds) as ChunkRow[];
  return rows;
}

function relevant(docIds: string[], query: string, k: number): ChunkRow[] {
  const rows = chunksForDocs(docIds);
  if (!rows.length) return [];
  const terms = tokenize(query);
  if (!terms.length) return spread(rows, k);
  const N = rows.length;
  const df = new Map<string, number>();
  for (const r of rows) {
    for (const w of new Set(tokenize(r.text))) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const scored = rows.map((r) => {
    const counts = new Map<string, number>();
    for (const w of tokenize(r.text)) counts.set(w, (counts.get(w) ?? 0) + 1);
    let score = 0;
    for (const t of terms) {
      const c = counts.get(t);
      if (!c) continue;
      const idf = Math.log(1 + N / (df.get(t) ?? 1));
      score += c * (idf + 1);
    }
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((x) => x.score > 0).slice(0, k).map((x) => x.r);
  return top.length ? top : spread(rows, k);
}

function joinChunks(rows: ChunkRow[], maxChars: number): string {
  const multiDoc = new Set(rows.map((r) => r.doc_id)).size > 1;
  let out = "";
  let lastTitle = "";
  for (const r of rows) {
    const header = !multiDoc || r.doc_title === lastTitle ? "" : `[Source: ${r.doc_title}]\n`;
    lastTitle = r.doc_title;
    const block = header + r.text + "\n\n";
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out.trim();
}

export function relevantChunks(
  documentId: string,
  query: string,
  k = 10
): ChunkRow[] {
  return relevant([documentId], query, k);
}

export function docContext(documentId: string, query: string, maxChars = 24000): string {
  return joinChunks(relevant([documentId], query, 12), maxChars);
}

export function evenContext(documentId: string, maxChars = 36000): string {
  return joinChunks(spread(chunksForDocs([documentId]), Math.max(4, Math.ceil(maxChars / 1300))), maxChars);
}

export function libraryContext(libraryId: string, query: string, maxChars = 30000): string {
  return joinChunks(relevant(docIdsInLibrary(libraryId), query, 14), maxChars);
}

export function evenLibraryContext(libraryId: string, maxChars = 36000): string {
  return joinChunks(
    spread(chunksForDocs(docIdsInLibrary(libraryId)), Math.max(4, Math.ceil(maxChars / 1300))),
    maxChars
  );
}
