"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  usePdfDocument,
  usePdfThumbnails,
  renderPageToDataUrl,
} from "@/components/PdfThumbnails";

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
  title?: string | null;
  bullets?: string[];
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

type UnitNoun = "page" | "slide" | "sheet" | "section";

export default function PageSelector({
  documentId,
  pageModel = "paginated",
  onSelectionChanged,
  staleWarning,
}: {
  documentId: string;
  pageModel?: "paginated" | "sectioned";
  onSelectionChanged?: (revision: number) => void;
  /** Rendered when generated material may predate the current selection. */
  staleWarning?: React.ReactNode;
}) {
  const [data, setData] = useState<PagesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [modalPage, setModalPage] = useState<PageSummary | null>(null);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  const noun = pageModel === "paginated" ? "page" : "section";
  const plural = pageModel === "paginated" ? "pages" : "sections";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${documentId}/pages`);
      if (!res.ok) throw new Error("Could not load pages");
      setData((await res.json()) as PagesPayload);
    } catch {
      setError("Could not load pages for this document. Try reloading the page.");
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // PDF rendering is only attempted when the server confirms a stored original.
  const pdfUrl =
    data?.visualPreviewAvailable && pageModel === "paginated" && data.filename.toLowerCase().endsWith(".pdf")
      ? `/api/documents/${documentId}/file`
      : null;
  const { doc: pdfDoc, error: pdfError } = usePdfDocument(pdfUrl);
  const visiblePageNumbers = useMemo(
    () => (data ? data.pages.map((p) => p.pageNumber) : []),
    [data]
  );
  const thumbs = usePdfThumbnails(pdfDoc, visiblePageNumbers);

  /**
   * Persists a selection change in as few requests as possible.
   *
   * Toggling sends the page's own new state; bulk actions send a single
   * instruction. All writes are optimistic and roll back to the previous state
   * if the server rejects them.
   */
  const commit = useCallback(
    async (mutate: (pages: PageSummary[]) => PageSummary[], successMsg: string) => {
      if (!data) return;
      const previous = data;
      const nextPages = mutate(data.pages);
      if (nextPages === previous.pages) return;

      const changed = nextPages.filter((p, i) => p !== previous.pages[i]);
      const payload: Record<string, unknown> = changed.length
        ? // Per-page intents: group by resulting state so one request covers a
          // mixed batch correctly.
          changed.reduce<Record<string, unknown>>((acc, p) => {
            const key = p.included ? "includeNumbers" : "excludeNumbers";
            acc[key] = [...((acc[key] as number[]) ?? []), p.pageNumber];
            return acc;
          }, {})
        : {};

      // Optimistic: reflect the change immediately, roll back on failure.
      setData({
        ...data,
        pages: nextPages,
        includedCount: nextPages.filter((p) => p.included).length,
        excludedCount: nextPages.filter((p) => !p.included).length,
      });
      setSaving(true);
      setSaveError(null);
      try {
        const res = await fetch(`/api/documents/${documentId}/pages`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await res.json()) as {
          error?: string;
          selectionRevision?: number;
        };
        if (!res.ok) throw new Error(body.error || "Could not save selection");
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1800);
        setStatusMessage(successMsg);
        if (body.selectionRevision) {
          setData((cur) =>
            cur ? { ...cur, selectionRevision: body.selectionRevision! } : cur
          );
          onSelectionChanged?.(body.selectionRevision);
        }
      } catch (err) {
        setData(previous);
        setSaveError(err instanceof Error ? err.message : "Could not save selection");
      } finally {
        setSaving(false);
      }
    },
    [data, documentId, onSelectionChanged]
  );

  const togglePage = useCallback(
    (page: PageSummary) => {
      void commit(
        (pages) =>
          pages.map((p) => (p.id === page.id ? { ...p, included: !p.included } : p)),
        `${page.label} ${page.included ? "excluded" : "included"}`
      );
    },
    [commit]
  );

  const bulk = useCallback(
    async (payload: Record<string, unknown>, message: string) => {
      if (!data) return;
      setSaving(true);
      setSaveError(null);
      const previous = data;
      // Optimistic bulk update
      setData({
        ...data,
        pages: data.pages.map((p) => {
          if (payload.allIncluded === true) return { ...p, included: true };
          if (payload.allIncluded === false) return { ...p, included: false };
          if (payload.invert) return { ...p, included: !p.included };
          if (payload.applySuggestions && p.suggestedExclude) return { ...p, included: false };
          if (payload.range) {
            const r = payload.range as { from: number; to: number; included: boolean };
            const inRange = p.pageNumber >= r.from && p.pageNumber <= r.to;
            return inRange ? { ...p, included: r.included } : p;
          }
          return p;
        }),
      });
      try {
        const res = await fetch(`/api/documents/${documentId}/pages`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await res.json()) as { error?: string; selectionRevision?: number };
        if (!res.ok) throw new Error(body.error || "Could not save selection");
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1800);
        setStatusMessage(message);
        if (body.selectionRevision) {
          setData((cur) =>
            cur ? { ...cur, selectionRevision: body.selectionRevision! } : cur
          );
          onSelectionChanged?.(body.selectionRevision);
        }
      } catch (err) {
        setData(previous);
        setSaveError(err instanceof Error ? err.message : "Could not save selection");
      } finally {
        setSaving(false);
      }
    },
    [data, documentId, onSelectionChanged]
  );

  if (loading) return <PageSelectorSkeleton noun={noun} />;

  if (error || !data) {
    return (
      <div className="mb-5 rounded-2xl border border-red-900/50 bg-red-950/20 p-5 text-sm text-red-200">
        <p className="font-medium">{error ?? "Could not load pages."}</p>
        <button
          onClick={() => void load()}
          className="mt-3 rounded-lg border border-red-800 px-3 py-1.5 text-xs transition hover:bg-red-900/40"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data.pages.length) {
    return (
      <div className="mb-5 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400">
        This document has no pages to select. Re-upload it to rebuild its content.
      </div>
    );
  }

  const included = data.includedCount;
  const excluded = data.excludedCount;
  const pct = data.totalChars ? Math.round((data.includedChars / data.totalChars) * 100) : 0;
  const charLabel = `${(data.includedChars / 1000).toFixed(1)}k of ${(
    data.totalChars / 1000
  ).toFixed(1)}k characters`;

  return (
    <section
      className="mb-5 rounded-2xl border border-zinc-800 bg-zinc-900/50"
      aria-labelledby="page-selector-heading"
    >
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="page-selector-heading" className="text-sm font-semibold text-zinc-100">
              Included: {included} of {data.pageCount} {data.pageCount === 1 ? noun : plural}
              <span className="ml-2 font-normal text-zinc-500">
                {excluded} excluded · {pct}% of text · {charLabel}
              </span>
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              The AI will study only included {plural}. Excluded {plural} remain in your document
              but will not be sent to the AI.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs">
            {saving && <span className="text-zinc-500">Saving…</span>}
            {savedFlash && !saving && (
              <span className="rounded-full bg-emerald-950 px-2 py-0.5 font-medium text-emerald-300">
                Selection saved
              </span>
            )}
            {!data.hasOriginal && (
              <span className="rounded-full border border-amber-800 bg-amber-950/40 px-2 py-0.5 text-amber-300">
                Previews unavailable
              </span>
            )}
          </div>
        </div>

        {/* Partial extraction + reprocessing notices */}
        {(data.noTextCount > 0 || data.errorCount > 0 || data.needsReprocessing) && (
          <div className="mt-3 space-y-1.5 text-xs">
            {data.needsReprocessing && (
              <p className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-amber-200">
                This document was uploaded before page previews existed and its original file was
                not stored, so visual thumbnails are unavailable. Text-based {plural} still work
                exactly as before. Re-upload the file to enable visual previews.
              </p>
            )}
            {data.noTextCount > 0 && (
              <p className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-300">
                {data.noTextCount} {data.noTextCount === 1 ? noun : plural} contain no extractable
                text — usually diagrams or scans. They are shown but contribute nothing until OCR is
                available.
              </p>
            )}
            {data.errorCount > 0 && (
              <p className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-red-200">
                {data.errorCount} {data.errorCount === 1 ? noun : plural} failed to extract and
                will be skipped by the AI.
              </p>
            )}
          </div>
        )}

        {data.visualPreviewReason && !data.visualPreviewAvailable && !data.needsReprocessing && (
          <p className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
            {data.visualPreviewReason}
          </p>
        )}
        {pdfError && (
          <p className="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            {pdfError} Text previews below are still accurate.
          </p>
        )}

        {/* Bulk controls */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <BulkButton onClick={() => void bulk({ allIncluded: true }, "All pages included")}>
            Include all
          </BulkButton>
          <BulkButton onClick={() => void bulk({ invert: true }, "Selection inverted")}>
            Invert
          </BulkButton>
          <BulkButton onClick={() => void bulk({ allIncluded: false }, "All pages excluded")}>
            Exclude all
          </BulkButton>
          {data.pages.some((p) => p.suggestedExclude) && (
            <BulkButton
              onClick={() =>
                void bulk({ applySuggestions: true }, "Suggested pages excluded")
              }
              tone="amber"
            >
              Exclude suggested ({data.pages.filter((p) => p.suggestedExclude).length})
            </BulkButton>
          )}

          <div className="ml-auto flex items-center gap-1.5 text-xs">
            <label className="sr-only" htmlFor={`range-from-${documentId}`}>
              Range start {noun} number
            </label>
            <input
              id={`range-from-${documentId}`}
              type="number"
              min={1}
              max={data.pageCount}
              value={rangeFrom}
              onChange={(e) => setRangeFrom(e.target.value)}
              placeholder="from"
              className="w-16 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 outline-none focus:border-indigo-500"
            />
            <span aria-hidden="true" className="text-zinc-600">
              –
            </span>
            <label className="sr-only" htmlFor={`range-to-${documentId}`}>
              Range end {noun} number
            </label>
            <input
              id={`range-to-${documentId}`}
              type="number"
              min={1}
              max={data.pageCount}
              value={rangeTo}
              onChange={(e) => setRangeTo(e.target.value)}
              placeholder="to"
              className="w-16 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 outline-none focus:border-indigo-500"
            />
            <BulkButton
              onClick={() => {
                const from = Number(rangeFrom);
                const to = Number(rangeTo);
                if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
                  setSaveError("Enter a valid range, for example 3 to 7.");
                  return;
                }
                void bulk({ range: { from, to, included: true } }, `Included ${from}–${to}`);
                setRangeFrom("");
                setRangeTo("");
              }}
            >
              Include range
            </BulkButton>
          </div>
        </div>

        {saveError && (
          <p role="alert" className="mt-2 rounded-lg bg-red-950/60 px-3 py-2 text-xs text-red-300">
            {saveError}
          </p>
        )}
        <p aria-live="polite" className="sr-only">
          {statusMessage}
        </p>
      </div>

      {staleWarning}

      <ul className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
        {data.pages.map((page) => (
          <li key={page.id}>
            <PageCard
              page={page}
              noun={noun}
              thumb={thumbs[page.pageNumber]?.url ?? null}
              thumbStatus={thumbs[page.pageNumber]?.status ?? "idle"}
              pdfAvailable={Boolean(pdfDoc)}
              onToggle={() => togglePage(page)}
              onOpen={() => setModalPage(page)}
            />
          </li>
        ))}
      </ul>

      {modalPage && (
        <PageModal
          page={modalPage}
          pages={data.pages}
          noun={noun}
          doc={pdfDoc}
          onClose={() => setModalPage(null)}
          onNavigate={(p) => setModalPage(p)}
          onToggle={() => togglePage(modalPage)}
        />
      )}
    </section>
  );
}

function BulkButton({
  children,
  onClick,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "default" | "amber";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
        tone === "amber"
          ? "border-amber-800 text-amber-200 hover:bg-amber-950/40"
          : "border-zinc-700 text-zinc-200 hover:border-indigo-500 hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

function PageCard({
  page,
  noun,
  thumb,
  thumbStatus,
  pdfAvailable,
  onToggle,
  onOpen,
}: {
  page: PageSummary;
  noun: UnitNoun;
  thumb: string | null;
  thumbStatus: "idle" | "loading" | "ready" | "error";
  pdfAvailable: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const stateText = page.included ? "included" : "excluded";
  return (
    <div
      className={`group relative overflow-hidden rounded-xl border transition ${
        page.included
          ? "border-indigo-600/70 bg-zinc-950/60"
          : "border-zinc-800 bg-zinc-950/30 opacity-70 hover:opacity-100"
      }`}
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-zinc-900">
        {/* Visual preview: real PDF render, slide structure card, or text preview */}
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt={`Preview of ${page.label}`}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : thumbStatus === "loading" || (pdfAvailable && thumbStatus === "idle") ? (
          <div className="flex h-full w-full animate-pulse items-center justify-center text-[10px] text-zinc-600">
            Rendering…
          </div>
        ) : page.extractionStatus === "no_text" ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-3 text-center">
            <span aria-hidden="true" className="text-lg">
              🖼
            </span>
            <span className="text-[10px] leading-tight text-zinc-500">
              No extractable text on this {noun}
            </span>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col gap-1 p-3">
            {page.hasStructuredPreview && (
              <>
                <p className="text-xs font-semibold leading-tight text-zinc-200">
                  {page.title || page.label}
                </p>
                <ul className="space-y-0.5">
                  {(page.bullets ?? []).slice(0, 5).map((b, i) => (
                    <li key={i} className="truncate text-[10px] leading-tight text-zinc-400">
                      • {b}
                    </li>
                  ))}
                </ul>
                <div className="mt-auto flex flex-wrap gap-1">
                  {page.hasImage && (
                    <span className="rounded bg-zinc-800 px-1 text-[9px] text-zinc-400">image</span>
                  )}
                  {page.hasNotes && (
                    <span className="rounded bg-zinc-800 px-1 text-[9px] text-zinc-400">notes</span>
                  )}
                </div>
              </>
            )}
            {!page.hasStructuredPreview && (
              <p className="line-clamp-8 text-[10px] leading-snug text-zinc-400">
                {page.preview || <span className="text-zinc-600">No text</span>}
              </p>
            )}
          </div>
        )}

        {/* Excluded overlay: not colour alone — explicit label + icon */}
        {!page.included && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/70 backdrop-grayscale">
            <span className="flex items-center gap-1 rounded-full bg-zinc-900 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-200 ring-1 ring-zinc-600">
              <span aria-hidden="true">🚫</span> Excluded
            </span>
          </div>
        )}

        {page.suggestedExclude && page.included && (
          <span
            className="absolute left-1.5 top-1.5 rounded bg-amber-950/90 px-1.5 py-0.5 text-[9px] font-medium text-amber-300"
            title={page.exclusionReason ?? "Suggested exclusion"}
          >
            Suggested exclude
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-2.5 py-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={page.included}
            onChange={onToggle}
            className="h-4 w-4 shrink-0 accent-indigo-600"
            aria-label={`${page.label}, ${stateText}`}
          />
          <span className="truncate font-medium text-zinc-200">{page.label}</span>
        </label>
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition hover:text-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          aria-label={`Open larger preview of ${page.label}`}
        >
          View
        </button>
      </div>
    </div>
  );
}

function PageModal({
  page,
  pages,
  noun,
  doc,
  onClose,
  onNavigate,
  onToggle,
}: {
  page: PageSummary;
  pages: PageSummary[];
  noun: UnitNoun;
  doc: Awaited<ReturnType<typeof usePdfDocument>>["doc"];
  onClose: () => void;
  onNavigate: (p: PageSummary) => void;
  onToggle: () => void;
}) {
  const [image, setImage] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const index = pages.findIndex((p) => p.id === page.id);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && index < pages.length - 1) onNavigate(pages[index + 1]);
      if (e.key === "ArrowLeft" && index > 0) onNavigate(pages[index - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, pages, onClose, onNavigate]);

  useEffect(() => {
    let cancelled = false;
    if (doc) {
      void renderPageToDataUrl(doc, page.pageNumber).then((url) => {
        if (!cancelled) setImage(url);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [doc, page.pageNumber]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${page.label} preview`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/85 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100">{page.label}</h3>
            <p className="text-xs text-zinc-500">
              {page.charCount} characters ·{" "}
              {page.included ? "included in AI context" : "excluded from AI context"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggle}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium transition hover:border-indigo-500"
            >
              {page.included ? "Exclude" : "Include"} this {noun}
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs transition hover:border-indigo-500"
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-zinc-950 p-4">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt={`Full page preview of ${page.label}`}
              className="mx-auto w-full max-w-2xl rounded shadow-lg"
            />
          ) : page.extractionStatus === "no_text" ? (
            <p className="py-10 text-center text-sm text-zinc-400">
              This {noun} contains no extractable text. It is likely a diagram, chart or scanned
              image. It stays visible here, but contributes no text to the AI until OCR support is
              added.
            </p>
          ) : (
            <div className="prose-invert max-w-none text-sm leading-relaxed text-zinc-200">
              <pre className="whitespace-pre-wrap font-sans">{page.preview}</pre>
            </div>
          )}
          {page.hasStructuredPreview && (
            <div className="mx-auto mt-4 max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-xs">
              <p className="font-medium text-zinc-300">Structured slide summary</p>
              <p className="mt-1 text-zinc-500">
                PowerPoint is rendered as a structured summary rather than a pixel-accurate image.
                {page.hasImage && " This slide contains images."}
                {page.hasNotes && " Speaker notes are stored separately and included in AI context."}
              </p>
            </div>
          )}
          {page.suggestedExclude && page.exclusionReason && (
            <p className="mx-auto mt-3 max-w-2xl rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
              Suggested for exclusion: {page.exclusionReason}. This is only a suggestion — the page
              is included and nothing was deleted.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-2 text-xs text-zinc-500">
          <button
            type="button"
            disabled={index <= 0}
            onClick={() => onNavigate(pages[index - 1])}
            className="rounded px-2 py-1 disabled:opacity-30 enabled:hover:text-zinc-200"
          >
            ← Previous
          </button>
          <span>
            {index + 1} of {pages.length}
          </span>
          <button
            type="button"
            disabled={index >= pages.length - 1}
            onClick={() => onNavigate(pages[index + 1])}
            className="rounded px-2 py-1 disabled:opacity-30 enabled:hover:text-zinc-200"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}

function PageSelectorSkeleton({ noun }: { noun: UnitNoun }) {
  return (
    <div className="mb-5 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="h-4 w-56 animate-pulse rounded bg-zinc-800" />
      <div className="mt-2 h-3 w-80 animate-pulse rounded bg-zinc-800/70" />
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i}>
            <div className="aspect-[3/4] animate-pulse rounded-xl bg-zinc-800/60" />
            <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-zinc-800/60" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading {noun}s…</span>
    </div>
  );
}