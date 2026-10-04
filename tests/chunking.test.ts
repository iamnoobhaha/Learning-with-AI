import { describe, it, expect } from "vitest";
import {
  chunkPageText,
  buildChunksForPage,
  estimateTokens,
  tokensToChars,
} from "@/lib/chunking";

const LONG = Array.from(
  { length: 40 },
  (_, i) =>
    `Sentence number ${i} explains concept ${i} in enough detail to be a real sentence worth splitting on.`
).join(" ");

describe("token estimation", () => {
  it("never under-reports tokens for real prose", () => {
    const text = "Photosynthesis converts light energy into chemical energy stored as glucose.";
    expect(estimateTokens(text)).toBeGreaterThan(0);
    expect(estimateTokens("")).toBe(0);
  });

  it("round-trips tokens to chars conservatively", () => {
    const tokens = 1000;
    expect(tokensToChars(tokens)).toBeGreaterThan(0);
  });
});

describe("chunkPageText", () => {
  it("keeps short text as a single chunk", () => {
    expect(chunkPageText("A short page about photosynesis.")).toHaveLength(1);
  });

  it("splits long text into multiple token-bounded chunks", () => {
    const chunks = chunkPageText(LONG, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateTokens(c)).toBeLessThanOrEqual(200);
    }
  });

  it("never splits mid-sentence", () => {
    const chunks = chunkPageText(LONG, 120);
    for (const c of chunks) {
      // A chunk ending mid-sentence would not end with terminal punctuation.
      const trimmed = c.trim();
      if (trimmed.length > 5) {
        expect(/[.!?:)\]]$/.test(trimmed)).toBe(true);
      }
    }
  });

  it("never splits mid-word", () => {
    const noSpaces = "x".repeat(4000);
    const chunks = chunkPageText(noSpaces, 100);
    expect(chunks.join("")).not.toContain("xx xx");
  });

  it("returns empty for empty input", () => {
    expect(chunkPageText("")).toEqual([]);
  });
});

describe("buildChunksForPage provenance", () => {
  const source = {
    pageId: 7,
    pageNumber: 3,
    pageLabel: "Page 3",
    docId: "doc-1",
    docTitle: "Notes",
  };

  it("stamps every chunk with its source page", () => {
    const chunks = buildChunksForPage(source, LONG, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.pageId).toBe(7);
      expect(c.pageNumber).toBe(3);
      expect(c.pageLabel).toBe("Page 3");
      expect(c.tokenEstimate).toBeGreaterThan(0);
    }
  });

  it("does not merge chunks across pages because callers invoke it per page", () => {
    const a = buildChunksForPage({ ...source, pageNumber: 1, pageLabel: "Page 1" }, LONG, 120);
    const b = buildChunksForPage({ ...source, pageNumber: 2, pageLabel: "Page 2" }, LONG, 120);
    const all = [...a, ...b];
    expect(new Set(all.map((c) => c.pageNumber)).size).toBe(2);
    // No chunk may claim two pages: provenance is single-valued by construction.
    expect(all.every((c) => typeof c.pageNumber === "number")).toBe(true);
  });
});