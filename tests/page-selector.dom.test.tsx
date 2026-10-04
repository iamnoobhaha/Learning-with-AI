// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PageSelector, { type PagesPayload } from "@/components/PageSelector";

/**
 * Component coverage for the page selector: visual states, click and keyboard
 * toggling, bulk actions, optimistic rollback on API failure, accessible labels
 * and modal navigation.
 */

const PAGES: PagesPayload = {
  documentId: "doc-1",
  documentTitle: "OS Notes",
  filename: "lecture.pdf",
  pageModel: "paginated",
  pageCount: 3,
  selectionRevision: 1,
  needsReprocessing: false,
  hasOriginal: false,
  visualPreviewAvailable: false,
  visualPreviewReason: "Previews unavailable for this test.",
  includedCount: 2,
  excludedCount: 1,
  includedChars: 300,
  totalChars: 400,
  noTextCount: 1,
  errorCount: 0,
  pages: [
    {
      id: 1,
      pageNumber: 1,
      pageType: "pdf_page",
      label: "Page 1",
      included: true,
      suggestedExclude: false,
      exclusionReason: null,
      extractionStatus: "ok",
      extractionError: null,
      textLength: 200,
      preview: "A process is a program in execution.",
      hasStructuredPreview: false,
      hasImage: false,
      hasNotes: false,
      charCount: 200,
    },
    {
      id: 2,
      pageNumber: 2,
      pageType: "pdf_page",
      label: "Page 2",
      included: true,
      suggestedExclude: true,
      exclusionReason: "Looks like a timetable entry",
      extractionStatus: "ok",
      extractionError: null,
      textLength: 100,
      preview: "Monday 14:00 - 15:30",
      hasStructuredPreview: false,
      hasImage: false,
      hasNotes: false,
      charCount: 100,
    },
    {
      id: 3,
      pageNumber: 3,
      pageType: "pdf_page",
      label: "Page 3",
      included: false,
      suggestedExclude: false,
      exclusionReason: null,
      extractionStatus: "no_text",
      extractionError: null,
      textLength: 0,
      preview: "",
      hasStructuredPreview: false,
      hasImage: false,
      hasNotes: false,
      charCount: 0,
    },
  ],
};

function mockFetch(patchImpl?: (init: RequestInit) => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (init?.method === "PATCH") {
      return patchImpl
        ? patchImpl(init)
        : new Response(
            JSON.stringify({ ok: true, changed: 1, selectionRevision: 2 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
    }
    if (url.includes("/pages")) {
      return new Response(JSON.stringify(PAGES), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  });
}

beforeEach(() => {
  // jsdom lacks these; the component uses them for PDF.js lazily.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // Default to a successful page fetch; individual tests override.
  vi.stubGlobal("fetch", mockFetch());
});

describe("PageSelector rendering", () => {
  it("shows a skeleton while loading and then the page grid", async () => {
    render(<PageSelector documentId="doc-1" />);
    expect(screen.getByText(/loading pages/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Page 1/)).toBeInTheDocument());
    expect(screen.getByText(/Page 2/)).toBeInTheDocument();
    expect(screen.getByText(/Page 3/)).toBeInTheDocument();
  });

  it("summarises how many pages are included", async () => {
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() => expect(screen.getByText(/Included: 2 of 3 pages/i)).toBeInTheDocument());
  });

  it("labels the excluded page visually (not colour alone)", async () => {
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() => expect(screen.getByLabelText("Page 3, excluded")).toBeInTheDocument());
    // The excluded card carries an explicit textual overlay, not just opacity.
    const excludedOverlay = screen.getAllByText("Excluded").find((el) =>
      el.className.includes("uppercase")
    );
    expect(excludedOverlay).toBeTruthy();
    // And the excluded card is visually de-emphasised.
    const card = screen.getByLabelText("Page 3, excluded").closest("div.group");
    expect(card?.className).toMatch(/opacity-/);
  });

  it("marks a page with no extractable text", async () => {
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() =>
      expect(screen.getByText(/no extractable text on this page/i)).toBeInTheDocument()
    );
  });

  it("shows the suggested-exclusion hint without hiding the page", async () => {
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() => expect(screen.getByText(/Suggested exclude/i)).toBeInTheDocument());
    // It remains included until the user acts.
    expect(screen.getByLabelText("Page 2, included")).toBeChecked();
  });

  it("surfaces the partial/preview warning", async () => {
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() =>
      expect(screen.getByText(/Previews unavailable for this test/i)).toBeInTheDocument()
    );
  });
});

describe("PageSelector interaction", () => {
  it("toggles a page via its accessible checkbox", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() => expect(screen.getByLabelText("Page 1, included")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Page 1, included"));
    await waitFor(() => {
      // After toggling, the checkbox is unchecked and re-labelled as excluded.
      const el = screen.getByLabelText("Page 1, excluded") as HTMLInputElement;
      expect(el.checked).toBe(false);
    });
    // It issued exactly one PATCH carrying that page's own intent.
    const patchCalls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patchCalls).toHaveLength(1);
    const body = JSON.parse((patchCalls[0][1] as RequestInit).body as string);
    expect(body.excludeNumbers).toEqual([1]);
  });

  it("supports keyboard toggling on the checkbox", async () => {
    const user = userEvent.setup();
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() => expect(screen.getByLabelText("Page 1, included")).toBeInTheDocument());

    const cb = screen.getByLabelText("Page 1, included");
    cb.focus();
    await user.keyboard(" ");
    await waitFor(() => {
      expect((screen.getByLabelText("Page 1, excluded") as HTMLInputElement).checked).toBe(false);
    });
  });

  it("runs a bulk include-all via a single batched request", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() => expect(screen.getByText(/Included: 2 of 3/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /include all/i }));
    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patches).toHaveLength(1);
    });
    const body = JSON.parse(
      (fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")![1] as RequestInit)
        .body as string
    );
    expect(body.allIncluded).toBe(true);
  });

  it("rolls back the optimistic update when the API fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      mockFetch(() => new Response(JSON.stringify({ error: "Save failed" }), { status: 500 }))
    );
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() => expect(screen.getByLabelText("Page 1, included")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Page 1, included"));
    // Optimistic flip happens then reverts; the checkbox returns to included.
    await waitFor(() => expect(screen.getByLabelText("Page 1, included")).toBeChecked());
    expect(await screen.findByRole("alert")).toHaveTextContent(/save failed/i);
  });

  it("rejects a zero-page selection with the server's explanation", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      mockFetch(
        () =>
          new Response(
            JSON.stringify({ error: "At least one page with study content must stay included." }),
            { status: 400 }
          )
      )
    );
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() => expect(screen.getByLabelText("Page 1, included")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /exclude all/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least one page/i);
  });
});

describe("PageSelector modal", () => {
  it("opens a larger preview and navigates with keyboard", async () => {
    const user = userEvent.setup();
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() => expect(screen.getByLabelText("Page 1, included")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Open larger preview of Page 1"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("1 of 3")).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Page 2 preview"));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("PageSelector error and empty states", () => {
  it("shows a retry affordance when loading pages fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 }))
    );
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() => expect(screen.getByText(/could not load pages/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("handles a document with no pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ...PAGES, pages: [], pageCount: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    render(<PageSelector documentId="doc-1" />);
    await waitFor(() => expect(screen.getByText(/no pages to select/i)).toBeInTheDocument());
  });
});