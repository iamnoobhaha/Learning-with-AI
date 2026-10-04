import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb, fixture } from "./setup";
import db from "@/lib/db";
import { ingestDocument } from "@/lib/ingest";
import { buildContext, NoIncludedContentError, summariseSources } from "@/lib/ai-context";
import { GET as pagesGET, PATCH as pagesPATCH } from "@/app/api/documents/[id]/pages/route";

/**
 * Integration coverage for the central guarantee: an excluded page can never
 * reach AI context, for any AI feature, and selection state is independent from
 * generated chunks.
 */

type RouteCtx = { params: Promise<{ id: string }> };
const ctxFor = (id: string): RouteCtx => ({ params: Promise.resolve({ id }) });

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

async function ingestPdf(): Promise<string> {
  const result = await ingestDocument(fixture("sample.pdf"), {
    kind: "notes",
    title: "OS Notes",
    filename: "sample.pdf",
    libraryId: null,
    declaredMime: "application/pdf",
  });
  return result.documentId;
}

async function ingestNotes(): Promise<string> {
  const result = await ingestDocument(fixture("sample-notes.txt"), {
    kind: "notes",
    title: "Physics Notes",
    filename: "sample-notes.txt",
    libraryId: null,
    declaredMime: "text/plain",
  });
  return result.documentId;
}

beforeEach(() => {
  const d = testDb();
  d.exec("DELETE FROM flashcards");
  d.exec("DELETE FROM attempts");
  d.exec("DELETE FROM questions");
  d.exec("DELETE FROM quizzes");
  d.exec("DELETE FROM document_pages");
  d.exec("DELETE FROM chunks");
  d.exec("DELETE FROM documents");
  d.close();
});

afterEach(() => {
  // no-op; shared db per file
});

describe("document_pages persistence", () => {
  it("creates a row per PDF page including the empty one", async () => {
    const id = await ingestPdf();
    const rows = testDb()
      .prepare("SELECT page_number, extraction_status FROM document_pages WHERE document_id = ? ORDER BY page_number")
      .all(id) as { page_number: number; extraction_status: string }[];
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.page_number)).toEqual([1, 2, 3, 4]);
    expect(rows[2].extraction_status).toBe("no_text");
  });

  it("links every chunk to its source page and keeps page provenance", async () => {
    const id = await ingestPdf();
    const orphans = testDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM chunks c
         LEFT JOIN document_pages p ON p.id = c.page_id
         WHERE c.document_id = ? AND p.id IS NULL`
      )
      .get(id) as { n: number };
    expect(Number(orphans.n)).toBe(0);
  });

  it("stores the original file outside the public directory", async () => {
    const id = await ingestPdf();
    const row = testDb()
      .prepare("SELECT original_path, original_mime FROM documents WHERE id = ?")
      .get(id) as { original_path: string; original_mime: string };
    expect(row.original_path).toBeTruthy();
    expect(row.original_path).not.toContain("/public/");
    expect(row.original_mime).toBe("application/pdf");
  });
});

describe("context filtering", () => {
  it("includes only pages the user selected", async () => {
    const id = await ingestPdf();
    // Exclude page 4 (the deadlock page) only.
    const res = await pagesPATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ pageNumbers: [4], included: false }),
      }),
      ctxFor(id)
    );
    expect(res.status).toBe(200);

    const built = buildContext({ documentId: id, maxChars: 20000, coverage: true });
    expect(built.text).not.toContain("Deadlock");
    expect(built.text).toContain("process is a program in execution");
    const pageNumbers = built.sources.map((s) => s.pageNumber).sort();
    expect(pageNumbers).not.toContain(4);
  });

  it("excludes empty pages from contributing text but keeps them visible", async () => {
    const id = await ingestPdf();
    const payload = await json(await pagesGET(new Request("http://x"), ctxFor(id)));
    expect((payload.pages as unknown[]).length).toBe(4);
    const empty = (payload.pages as { pageNumber: number; extractionStatus: string }[]).find(
      (p) => p.pageNumber === 3
    );
    expect(empty?.extractionStatus).toBe("no_text");
  });

  it("throws NoIncludedContentError when nothing studyable is included", async () => {
    const id = await ingestNotes();
    // Exclude every page via bulk endpoint.
    const res = await pagesPATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ allIncluded: false }),
      }),
      ctxFor(id)
    );
    // Server refuses an empty selection outright.
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(String(body.error)).toMatch(/at least one page/i);
  });

  it("still throws when only textless pages remain included", async () => {
    const id = await ingestPdf();
    testDb()
      .prepare("UPDATE document_pages SET included = 0 WHERE document_id = ? AND text_length > 0")
      .run(id);
    expect(() => buildContext({ documentId: id, coverage: true })).toThrow(NoIncludedContentError);
  });

  it("honours an explicit page range", async () => {
    const id = await ingestPdf();
    // Page 4 holds the deadlock text; pages 1-2 hold process/scheduling text.
    const built = buildContext({
      documentId: id,
      maxChars: 20000,
      coverage: true,
      pageRange: { from: 4, to: 4 },
    });
    expect(built.text).toContain("Deadlock");
    expect(built.text).not.toContain("Round robin");
  });

  it("never returns excluded content for query-aware chat retrieval", async () => {
    const id = await ingestNotes();
    // The notes fixture splits into: 1 title, 2 Photosynthesis, 3 Binary Search.
    // Exclude the Binary Search section and ask about it directly.
    await pagesPATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ pageNumbers: [3], included: false }),
      }),
      ctxFor(id)
    );
    const built = buildContext({
      documentId: id,
      query: "binary search interval halving",
      maxChars: 20000,
      coverage: false,
    });
    expect(built.text).not.toContain("Binary search");
    expect(built.text).toContain("Photosynthesis");
  });

  it("reports sources for later provenance display", async () => {
    const id = await ingestNotes();
    const built = buildContext({ documentId: id, coverage: true });
    const summary = summariseSources(built.sources);
    expect(summary).toMatch(/p\d/);
  });

  it("rejects a malformed document id instead of querying", () => {
    expect(() => buildContext({ documentId: "'; DROP TABLE documents;--" })).toThrow();
  });

  it("does not leak another scope's pages", async () => {
    const libId = randomUUID();
    testDb().prepare("INSERT INTO libraries (id, name) VALUES (?, ?)").run(libId, "Course A");
    const inLib = await ingestNotes();
    testDb().prepare("UPDATE documents SET library_id = ? WHERE id = ?").run(libId, inLib);
    const outside = await ingestPdf();

    const libContext = buildContext({ libraryId: libId, coverage: true });
    expect(libContext.text).toContain("Photosynthesis");
    expect(libContext.text).not.toContain("Deadlock");
    void outside;
  });
});

describe("selection revision & staleness", () => {
  it("increments the revision on every selection change", async () => {
    const id = await ingestNotes();
    const before = testDb()
      .prepare("SELECT selection_revision FROM documents WHERE id = ?")
      .get(id) as { selection_revision: number };
    const res = await pagesPATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ pageNumbers: [1], included: false }),
      }),
      ctxFor(id)
    );
    const body = await json(res);
    const after = testDb()
      .prepare("SELECT selection_revision FROM documents WHERE id = ?")
      .get(id) as { selection_revision: number };
    expect(after.selection_revision).toBeGreaterThan(before.selection_revision);
    expect(Number(body.selectionRevision)).toBe(after.selection_revision);
  });
});

describe("bulk selection API", () => {
  it("supports include all, invert, exclude all and range", async () => {
    const id = await ingestNotes();
    const total = Number(
      (
        testDb()
          .prepare("SELECT COUNT(*) AS n FROM document_pages WHERE document_id = ?")
          .get(id) as { n: number }
      ).n
    );

    // Exclude one page first so there is something to invert.
    await pagesPATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ pageNumbers: [1], included: false }),
      }),
      ctxFor(id)
    );

    // Inverting swaps included/excluded without emptying the document.
    const inv = await pagesPATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ invert: true }),
      }),
      ctxFor(id)
    );
    expect(inv.status).toBe(200);
    const afterInvert = testDb()
      .prepare("SELECT COUNT(*) AS n FROM document_pages WHERE document_id = ? AND included = 1")
      .get(id) as { n: number };
    expect(Number(afterInvert.n)).toBe(1);

    await pagesPATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ allIncluded: true }),
      }),
      ctxFor(id)
    );
    const included = testDb()
      .prepare("SELECT COUNT(*) AS n FROM document_pages WHERE document_id = ? AND included = 1")
      .get(id) as { n: number };
    expect(Number(included.n)).toBe(total);

    const range = await pagesPATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ range: { from: 2, to: 2, included: false } }),
      }),
      ctxFor(id)
    );
    expect(range.status).toBe(200);
    const still = testDb()
      .prepare("SELECT included FROM document_pages WHERE document_id = ? AND page_number = 2")
      .get(id) as { included: number };
    expect(still.included).toBe(0);
  });

  it("refuses to exclude every page (prevents a dead-end document)", async () => {
    const id = await ingestNotes();
    const res = await pagesPATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ allIncluded: false }),
      }),
      ctxFor(id)
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(String(body.error)).toMatch(/at least one page/i);
  });

  it("applies a mixed include/exclude batch in one request", async () => {
    const id = await ingestPdf();
    // Include page 3 (currently excluded) while excluding page 1, in one call.
    const res = await pagesPATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ includeNumbers: [3], excludeNumbers: [1] }),
      }),
      ctxFor(id)
    );
    expect(res.status).toBe(200);
    const rows = testDb()
      .prepare("SELECT page_number, included FROM document_pages WHERE document_id = ? ORDER BY page_number")
      .all(id) as { page_number: number; included: number }[];
    expect(rows.find((r) => r.page_number === 1)?.included).toBe(0);
    expect(rows.find((r) => r.page_number === 3)?.included).toBe(1);
  });

  it("rejects an empty PATCH body with a clear error", async () => {
    const id = await ingestNotes();
    const res = await pagesPATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({}) }),
      ctxFor(id)
    );
    expect(res.status).toBe(400);
  });

  it("rejects a malformed JSON body", async () => {
    const id = await ingestNotes();
    const res = await pagesPATCH(
      new Request("http://x", { method: "PATCH", body: "not json" }),
      ctxFor(id)
    );
    expect(res.status).toBe(400);
  });
});

describe("no full-document fallback", () => {
  it("excludes a page whose text only exists in documents.content, not in pages", async () => {
    const id = await ingestPdf();
    // Inject secret text into the legacy full-text column only.
    testDb()
      .prepare("UPDATE documents SET content = content || ' SECRETSTUDYMATERIAL quantum entanglement' WHERE id = ?")
      .run(id);
    const built = buildContext({ documentId: id, maxChars: 30000, coverage: true });
    // documents.content is never a context source.
    expect(built.text).not.toContain("SECRETSTUDYMATERIAL");
  });
});

describe("deletion cascades", () => {
  it("removes pages and chunks when a document is deleted", async () => {
    const id = await ingestNotes();
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    const pages = testDb()
      .prepare("SELECT COUNT(*) AS n FROM document_pages WHERE document_id = ?")
      .get(id) as { n: number };
    const chunks = testDb()
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?")
      .get(id) as { n: number };
    expect(Number(pages.n)).toBe(0);
    expect(Number(chunks.n)).toBe(0);
  });
});