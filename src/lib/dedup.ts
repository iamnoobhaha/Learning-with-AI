const STOP = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was",
  "one", "our", "out", "his", "has", "have", "this", "that", "with", "from",
  "what", "when", "where", "which", "will", "your", "they", "their", "them",
  "then", "than", "there", "these", "those", "into", "also", "been", "were",
  "how", "why", "who", "its", "each", "any", "may", "should", "could", "would",
  "does", "did", "about", "following", "given", "based", "according",
]);

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprint(s: string): string {
  return normalizeText(s).replace(/\s/g, "");
}

export function tokenSet(s: string): Set<string> {
  return new Set(
    (normalizeText(s).match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w))
  );
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const w of small) if (large.has(w)) shared += 1;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

export interface DedupResult<T> {
  fresh: T[];
  duplicatesRemoved: number;
}

/**
 * Keeps only items whose text is not an exact or near duplicate of anything in
 * `existing` or of an earlier kept item. `threshold` is the Jaccard similarity
 * above which two texts are considered the same question.
 */
export function dedupeAgainst<T>(
  items: T[],
  getText: (item: T) => string,
  existing: string[],
  threshold = 0.72
): DedupResult<T> {
  const seenPrints = new Set<string>(existing.map(fingerprint).filter(Boolean));
  const seenSets = existing.map((e) => tokenSet(e)).filter((s) => s.size > 0);
  const fresh: T[] = [];
  let duplicatesRemoved = 0;

  for (const item of items) {
    const raw = getText(item);
    const print = fingerprint(raw);
    if (print && seenPrints.has(print)) {
      duplicatesRemoved += 1;
      continue;
    }
    const tokens = tokenSet(raw);
    let duplicate = false;
    if (tokens.size) {
      for (const prior of seenSets) {
        if (similarity(tokens, prior) >= threshold) {
          duplicate = true;
          break;
        }
      }
    }
    if (duplicate) {
      duplicatesRemoved += 1;
      continue;
    }
    if (print) seenPrints.add(print);
    if (tokens.size) seenSets.push(tokens);
    fresh.push(item);
  }

  return { fresh, duplicatesRemoved };
}
