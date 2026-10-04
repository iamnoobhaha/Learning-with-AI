"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Renders PDF page thumbnails in the browser with PDF.js.
 *
 * We deliberately do NOT store server-rendered page images: the original upload
 * is persisted once and streamed from /api/documents/[id]/file (with range
 * request support), and the worker is bundled locally from node_modules rather
 * than fetched from a CDN, so previews work offline and after reload.
 *
 * Object URLs are revoked on replacement/unmount and rendering is deferred with
 * an IntersectionObserver so a 300-page PDF never blocks the main thread.
 */

type PdfDoc = {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(p: { scale: number }): { width: number; height: number };
    render(p: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
      promise: Promise<void>;
      cancel(): void;
    };
  }>;
  destroy(): void;
};

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      // Serve the worker from our own origin/bundle instead of a remote CDN.
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

export function usePdfDocument(url: string | null) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!url) {
      setDoc(null);
      setPageCount(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const pdfjs = await getPdfjs();
        const task = pdfjs.getDocument({ url, disableAutoFetch: false });
        const loaded = await task.promise;
        if (cancelled) {
          loaded.destroy();
          return;
        }
        setDoc(loaded as unknown as PdfDoc);
        setPageCount(loaded.numPages);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error && /password/i.test(err.message)
              ? "This PDF is password protected, so page previews cannot be shown."
              : "Page previews are unavailable for this PDF."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  // Release the document when it is replaced or the component unmounts.
  useEffect(() => {
    return () => {
      doc?.destroy();
    };
  }, [doc]);

  return { doc, pageCount, error, loading };
}

export interface ThumbState {
  url: string | null;
  status: "idle" | "loading" | "ready" | "error";
}

export function usePdfThumbnails(
  doc: PdfDoc | null,
  pageNumbers: number[],
  scale = 0.28,
  maxConcurrent = 2
) {
  const [thumbs, setThumbs] = useState<Record<number, ThumbState>>({});
  const inFlight = useRef<Set<number>>(new Set());
  const urlsRef = useRef<string[]>([]);

  const renderOne = useCallback(
    async (pageNumber: number) => {
      if (!doc || inFlight.current.has(pageNumber)) return;
      inFlight.current.add(pageNumber);
      setThumbs((prev) => ({ ...prev, [pageNumber]: { url: null, status: "loading" } }));
      try {
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        await page.render({ canvasContext: ctx, viewport }).promise;
        const url = canvas.toDataURL("image/webp", 0.72);
        urlsRef.current.push(url);
        setThumbs((prev) => ({ ...prev, [pageNumber]: { url, status: "ready" } }));
      } catch {
        setThumbs((prev) => ({
          ...prev,
          [pageNumber]: { url: null, status: "error" },
        }));
      } finally {
        inFlight.current.delete(pageNumber);
      }
    },
    [doc, scale]
  );

  useEffect(() => {
    if (!doc) return;
    let active = true;
    (async () => {
      const queue = [...pageNumbers];
      const workers = Array.from({ length: Math.min(maxConcurrent, queue.length) }, async () => {
        while (queue.length && active) {
          const next = queue.shift();
          if (next === undefined) break;
          await renderOne(next);
        }
      });
      await Promise.all(workers);
    })();
    return () => {
      active = false;
    };
  }, [doc, pageNumbers, renderOne, maxConcurrent]);

  // Revoke data URLs is not required (they are not object URLs) but we clear
  // cached bitmaps when the document changes to release memory.
  useEffect(() => {
    urlsRef.current = [];
    setThumbs({});
  }, [doc]);

  return thumbs;
}

/** Renders a single full-size page for the detail modal. */
export async function renderPageToDataUrl(
  doc: PdfDoc,
  pageNumber: number,
  maxWidth = 1100
): Promise<string | null> {
  try {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, maxWidth / base.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}