/**
 * Lightweight tokenizer used by the retrieval ranker in ai-context.ts.
 *
 * This is deliberately a local, dependency-free lexical tokenizer: it powers
 * offline BM25-style ranking over included pages. It is not used for chunk
 * sizing (that is token-budget based in chunking.ts) and never leaves the
 * server.
 */

export const STOP = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was",
  "one", "our", "out", "his", "has", "have", "this", "that", "with", "from",
  "what", "when", "where", "which", "will", "your", "they", "their", "them",
  "then", "than", "there", "these", "those", "into", "also", "been", "were",
  "how", "why", "who", "its", "each", "any", "may", "should", "could", "would",
  "does", "did", "about", "following", "given", "based", "according",
]);

/**
 * Lowercases, strips punctuation and drops short/stop words.
 *
 * Note: the ASCII-only pattern means heavily non-Latin scripts contribute no
 * query terms, which makes ranking fall back to coverage sampling for those
 * documents rather than returning nothing.
 */
export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9'-]*/g) ?? []).filter(
    (w) => w.length > 2 && !STOP.has(w)
  );
}