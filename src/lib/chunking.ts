/**
 * Token-aware, provenance-preserving chunking.
 *
 * The user-facing selection unit is a page/slide (see document_pages). Chunks
 * are an internal detail created *after* selection, purely to fit model context
 * budgets. A chunk therefore never spans two pages, always records where it came
 * from, and never splits mid-word or mid-sentence.
 *
 * Exact tokenizer files for the configured model are not available at runtime,
 * so we use a documented approximation (~4 chars/token for English prose plus a
 * word-count component) with a deliberately conservative multiplier, and we
 * expose the estimate so truncation is observable rather than silent.
 */

export const CHARS_PER_TOKEN = 4;
export const SAFETY_FACTOR = 1.15;

/** Conservative token approximation. Never returns less than 1 for non-empty text. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const words = (text.match(/\S+/g) ?? []).length;
  const approx = chars / CHARS_PER_TOKEN + words * 0.25;
  return Math.max(1, Math.ceil(approx * SAFETY_FACTOR));
}

export function tokensToChars(tokens: number): number {
  return Math.max(1, Math.floor((tokens * CHARS_PER_TOKEN) / SAFETY_FACTOR));
}

export interface ChunkSource {
  pageId: number;
  pageNumber: number;
  pageLabel: string;
  docId: string;
  docTitle: string;
}

export interface Chunk extends ChunkSource {
  text: string;
  tokenEstimate: number;
}

function splitSentences(text: string): string[] {
  // Split after ., !, ? (optionally followed by quotes/brackets) when followed
  // by whitespace and a capital/quote/digit — avoids breaking decimals and
  // abbreviations far better than a naive split on '.'.
  const parts = text.split(/(?<=[.!?])["')\]]?\s+(?=[A-Z0-9"'(])/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function packSentences(sentences: string[], maxTokens: number, overlapSentences: number): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (!current.length) return;
    out.push(current.join(" "));
    if (overlapSentences > 0) {
      const tail = current.slice(-overlapSentences);
      current = [...tail];
      currentTokens = estimateTokens(current.join(" "));
    } else {
      current = [];
      currentTokens = 0;
    }
  };

  for (const sentence of sentences) {
    const t = estimateTokens(sentence);
    // A single oversized sentence is hard-wrapped on word boundaries.
    if (t > maxTokens) {
      flush();
      const words = sentence.split(/\s+/);
      let buf: string[] = [];
      let bufTokens = 0;
      for (const word of words) {
        const wt = estimateTokens(`${word} `);
        if (bufTokens + wt > maxTokens && buf.length) {
          out.push(buf.join(" "));
          buf = [];
          bufTokens = 0;
        }
        buf.push(word);
        bufTokens += wt;
      }
      if (buf.length) out.push(buf.join(" "));
      continue;
    }
    if (currentTokens + t > maxTokens) flush();
    current.push(sentence);
    currentTokens += t;
  }
  if (current.length) out.push(current.join(" "));
  return out.filter((s) => s.trim().length > 0);
}

/**
 * Chunks one page's text. Never mixes pages: callers invoke this per page so
 * the page boundary is structurally guaranteed.
 */
export function chunkPageText(text: string, maxTokens = 700): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (estimateTokens(trimmed) <= maxTokens) return [trimmed];
  const sentences = splitSentences(trimmed);
  if (sentences.length <= 1) return packSentences([trimmed], maxTokens, 0);
  return packSentences(sentences, maxTokens, 1);
}

export function buildChunksForPage(
  source: ChunkSource,
  text: string,
  maxTokens = 700
): Chunk[] {
  return chunkPageText(text, maxTokens).map((piece) => ({
    ...source,
    text: piece,
    tokenEstimate: estimateTokens(piece),
  }));
}