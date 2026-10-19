import JSZip from "jszip";
import {
  MAX_PDF_PAGES,
  MAX_SLIDES,
  MAX_TEXT_CHARS,
  UnsupportedFileTypeError,
} from "./storage";

export interface ExtractedUnit {
  /** 1-based page/slide/section number. Never shifts when text is missing. */
  number: number;
  type: "pdf_page" | "pptx_slide" | "sheet" | "section";
  label: string;
  text: string;
  /** Structured preview data for slides (never used as a visual claim). */
  slide?: SlidePreview;
  status: "ok" | "no_text" | "error";
  error?: string;
}

export interface SlidePreview {
  title: string | null;
  bullets: string[];
  hasImage: boolean;
  hasTable: boolean;
  hasChart: boolean;
  notes: string | null;
}

export interface ExtractResult {
  pageModel: "paginated" | "sectioned";
  pageCount: number | null;
  units: ExtractedUnit[];
  /** Full text, retained for backwards compatibility and search. */
  text: string;
}

export class DocumentExtractionError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "DocumentExtractionError";
    this.status = status;
  }
}

function clean(text: string): string {
  return text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
}

/* ------------------------------------------------------------------ PDF --- */

/**
 * Loads pdfjs-dist's legacy build, which is the Node-compatible entry point.
 * The modern browser build expects browser globals; the legacy build targets
 * Node and is deterministic across repeated calls (unlike the pdf.js copy
 * bundled inside pdf-parse 1.x, which leaks parser state between calls and
 * intermittently fails with "bad XRef entry").
 */
async function getPdfjs() {
  return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument(src: {
      data: Uint8Array;
      isEvalSupported?: boolean;
      useSystemFonts?: boolean;
      verbosity?: number;
    }): { promise: Promise<PdfDocument> };
    version?: string;
  };
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
}

interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
    cleanup?(): void;
  }>;
  destroy(): Promise<void> | void;
}

/**
 * True when pdf.js failed because the *reader* password is missing or wrong.
 *
 * pdf.js signals this with `PasswordException`. Only a real user password
 * produces that: a PDF carrying nothing but an owner password (permission
 * restrictions such as "do not print", which viewers open without prompting) is
 * decrypted transparently and never raises this. This is therefore the only
 * reliable way to tell the two apart — sniffing the trailer for `/Encrypt`
 * rejects perfectly readable documents.
 */
export function isPasswordError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name === "PasswordException") return true;
  return typeof message === "string" && /password/i.test(message);
}

/**
 * Extracts each PDF page individually so page numbers can never shift.
 *
 * Iterating the real page tree (instead of splitting aggregated text on form
 * feeds) guarantees that a page with no text — a diagram, a scan, a blank
 * sheet — still occupies its slot and is reported rather than silently dropped.
 */
export async function extractPdf(buf: Buffer): Promise<ExtractResult> {
  let doc: PdfDocument;
  try {
    const pdfjs = await getPdfjs();
    // pdf.js mutates the typed array it is given; hand it a private copy.
    const data = new Uint8Array(buf);
    const task = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    });
    doc = (await task.promise) as PdfDocument;
  } catch (err) {
    if (isPasswordError(err)) {
      throw new DocumentExtractionError(
        "This PDF is password protected. Remove the password and upload it again.",
        422
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new DocumentExtractionError(
      `Could not read this PDF — it appears to be corrupt or not a real PDF (${detail}).`,
      422
    );
  }

  const totalPages = doc.numPages;
  if (!totalPages || totalPages < 1) {
    throw new DocumentExtractionError("This PDF reports zero pages.");
  }
  if (totalPages > MAX_PDF_PAGES) {
    throw new DocumentExtractionError(
      `This PDF has ${totalPages} pages, above the ${MAX_PDF_PAGES}-page limit. Split it into parts and upload them separately.`,
      413
    );
  }

  const units: ExtractedUnit[] = [];
  for (let n = 1; n <= totalPages; n++) {
    try {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // Rebuild line breaks from the text matrix so paragraphs survive.
      let text = "";
      let lastY: number | null = null;
      for (const item of content.items) {
        const y = item.transform?.[5];
        if (lastY === null || y === lastY) text += item.str ?? "";
        else text += `\n${item.str ?? ""}`;
        lastY = y ?? lastY;
        if (item.hasEOL) text += "\n";
      }
      const cleaned = clean(text.replace(/[ \t]{2,}/g, " "));
      page.cleanup?.();
      units.push({
        number: n,
        type: "pdf_page",
        label: `Page ${n}`,
        text: cleaned,
        status: cleaned.length > 0 ? "ok" : "no_text",
      });
    } catch (err) {
      // Record the failure but keep the page slot: numbering must not shift.
      units.push({
        number: n,
        type: "pdf_page",
        label: `Page ${n}`,
        text: "",
        status: "error",
        error: err instanceof Error ? err.message : "Failed to read page",
      });
    }
  }
  await doc.destroy();

  const text = units
    .map((u) => (u.text ? `[${u.label}]\n${u.text}` : ""))
    .filter(Boolean)
    .join("\n\n");

  if (!text.trim()) {
    throw new DocumentExtractionError(
      "No selectable text found on any page — this looks like a scanned PDF. StudyForge has no OCR yet, so run OCR on the file first.",
      422
    );
  }

  return {
    pageModel: "paginated",
    pageCount: totalPages,
    units,
    text: text.slice(0, MAX_TEXT_CHARS),
  };
}

/* ------------------------------------------------------------- PowerPoint -- */

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Pulls paragraph text in document order, preserving <a:p> boundaries. */
function slideParagraphs(xml: string): string[] {
  const out: string[] = [];
  for (const p of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
    const runs = [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((m) => decodeXmlEntities(m[1]).trim())
      .filter(Boolean);
    if (runs.length) out.push(runs.join(" "));
  }
  return out;
}

export async function extractPptx(buf: Buffer): Promise<ExtractResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new DocumentExtractionError("This PPTX file could not be opened — it may be corrupt.");
  }

  const slideFiles = Object.keys(zip.files)
    .map((name) => {
      const m = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      return m ? { name, n: Number(m[1]) } : null;
    })
    .filter((x): x is { name: string; n: number } => x !== null)
    .sort((a, b) => a.n - b.n);

  if (!slideFiles.length) {
    throw new DocumentExtractionError("No slides were found in this PowerPoint file.");
  }
  if (slideFiles.length > MAX_SLIDES) {
    throw new DocumentExtractionError(
      `This deck has ${slideFiles.length} slides, above the ${MAX_SLIDES}-slide limit.`
    );
  }

  const notesBySlide = new Map<number, string>();
  const noteFiles = Object.keys(zip.files)
    .map((name) => {
      const m = name.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
      return m ? { name, n: Number(m[1]) } : null;
    })
    .filter((x): x is { name: string; n: number } => x !== null);
  for (const nf of noteFiles) {
    try {
      const xml = await zip.file(nf.name)!.async("string");
      const paragraphs = slideParagraphs(xml)
        .map((t) => t.trim())
        // PowerPoint stores the slide image placeholder as literal text
        .filter((t) => t && !/^\d+$/.test(t));
      if (paragraphs.length) notesBySlide.set(nf.n, paragraphs.join("\n"));
    } catch {
      // notes are optional; a failure here must not drop the slide
    }
  }

  const units: ExtractedUnit[] = [];
  for (const slide of slideFiles) {
    let paragraphs: string[] = [];
    let hasImage = false;
    let hasTable = false;
    let hasChart = false;
    let status: ExtractedUnit["status"] = "no_text";
    let error: string | undefined;

    try {
      const xml = await zip.file(slide.name)!.async("string");
      paragraphs = slideParagraphs(xml);
      hasImage = /<p:pic>|<a:blip/.test(xml);
      hasTable = /<a:tbl>/.test(xml);
      hasChart = /<c:chart|<p:graphicFrame[^>]*>\s*<a:graphicData[^>]*uri="[^"]*chart/i.test(xml);
      status = paragraphs.length ? "ok" : "no_text";
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : "Failed to read slide";
    }

    const notes = notesBySlide.get(slide.n) ?? null;
    // Slide body text is what drives study material; notes are kept separate
    // and only appended for context, clearly labelled.
    const bodyText = paragraphs.join("\n");
    const text = notes ? `${bodyText}\n\n[Speaker notes]\n${notes}`.trim() : bodyText;

    units.push({
      number: slide.n,
      type: "pptx_slide",
      label: `Slide ${slide.n}`,
      text,
      status,
      error,
      slide: {
        title: paragraphs[0] ?? null,
        bullets: paragraphs.slice(1, 14),
        hasImage,
        hasTable,
        hasChart,
        notes,
      },
    });
  }

  const text = units
    .map((u) => (u.text ? `[${u.label}]\n${u.text}` : ""))
    .filter(Boolean)
    .join("\n\n");

  if (!text.trim()) {
    throw new DocumentExtractionError(
      "No text found on any slide. Slides made only of images cannot be studied without OCR.",
      422
    );
  }

  return {
    pageModel: "paginated",
    pageCount: slideFiles.length,
    units,
    text: text.slice(0, MAX_TEXT_CHARS),
  };
}

/* ------------------------------------------------------------- Spreadsheet -- */

export async function extractXlsx(buf: Buffer): Promise<ExtractResult> {
  const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
  const api = XLSX as unknown as {
    read(buf: Buffer, opts: { type: string }): {
      SheetNames: string[];
      Sheets: Record<string, Record<string, unknown> | undefined>;
    };
    utils: {
      sheet_to_csv(sheet: Record<string, unknown>, opts: { blankrows: boolean }): string;
    };
  };
  let wb: ReturnType<typeof api.read>;
  try {
    wb = api.read(buf, { type: "buffer" });
  } catch {
    throw new DocumentExtractionError("This workbook could not be read — it may be corrupt.");
  }

  const units: ExtractedUnit[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const csv = api.utils.sheet_to_csv(sheet, { blankrows: false });
    if (!csv.trim()) continue;
    units.push({
      number: units.length + 1,
      type: "sheet",
      label: `Sheet: ${name}`,
      text: csv,
      status: "ok",
    });
  }

  if (!units.length) {
    throw new DocumentExtractionError("No data was found in this workbook.");
  }
  const text = units.map((u) => `[${u.label}]\n${u.text}`).join("\n\n");
  return {
    pageModel: "paginated",
    pageCount: units.length,
    units,
    text: text.slice(0, MAX_TEXT_CHARS),
  };
}

/* ----------------------------------------------------------- Word / text --- */

function splitByHeadings(text: string): ExtractedUnit[] {
  const lines = text.split("\n");
  const units: ExtractedUnit[] = [];
  let current: string[] = [];
  let heading = "";

  const isHeading = (line: string) => {
    const t = line.trim();
    if (!t || t.length > 80) return false;
    if (/^#{1,6}\s+\S/.test(t)) return true;
    if (/^(lecture|class|tutorial|session|chapter|topic|unit|week|part)\b[\s#:.-]*\d*\b/i.test(t)) {
      return true;
    }
    return /^[A-Z0-9][A-Z0-9 ,&'()\-]{3,60}$/.test(t) && /[A-Z]{3}/.test(t);
  };

  const flush = () => {
    const body = current.join("\n").trim();
    if (body) {
      units.push({
        number: units.length + 1,
        type: "section",
        label: heading || `Section ${units.length + 1}`,
        text: body,
        status: "ok",
      });
    }
    current = [];
  };

  for (const line of lines) {
    if (isHeading(line) && current.join("\n").trim()) {
      flush();
      heading = line.trim().replace(/^#+\s*/, "").slice(0, 80);
    }
    current.push(line);
  }
  flush();

  if (!units.length && text.trim()) {
    units.push({
      number: 1,
      type: "section",
      label: "Document",
      text: text.trim(),
      status: "ok",
    });
  }
  return units;
}

export function extractPlain(buf: Buffer): ExtractResult {
  const text = clean(buf.toString("utf8"));
  if (!text) throw new DocumentExtractionError("The file appears to be empty.");
  const units = splitByHeadings(text);
  return {
    pageModel: "sectioned",
    pageCount: units.length,
    units,
    text: text.slice(0, MAX_TEXT_CHARS),
  };
}

export async function extractDocx(buf: Buffer): Promise<ExtractResult> {
  const mammoth = (await import("mammoth")).default;
  let value: string;
  try {
    ({ value } = await mammoth.extractRawText({ buffer: buf }));
  } catch {
    throw new DocumentExtractionError("This Word document could not be read.");
  }
  const text = clean(value);
  if (!text) {
    throw new DocumentExtractionError(
      "No text found in this Word document (it may be image-only, which needs OCR).",
      422
    );
  }
  const units = splitByHeadings(text);
  return {
    pageModel: "sectioned",
    pageCount: units.length,
    units,
    text: text.slice(0, MAX_TEXT_CHARS),
  };
}

export async function extractDoc(buf: Buffer): Promise<ExtractResult> {
  const WordExtractor = (await import("word-extractor")).default;
  type Extracted = {
    getBody(): string;
    getTextboxes?(): string;
    getFootnotes?(): string;
  };
  let text: string;
  try {
    const doc = (await new WordExtractor().extract(buf)) as unknown as Extracted;
    const parts = [doc.getBody()];
    try {
      parts.push(doc.getTextboxes?.() ?? "");
    } catch {}
    text = clean(parts.filter(Boolean).join("\n\n"));
  } catch {
    throw new DocumentExtractionError("This legacy .doc file could not be read.");
  }
  if (!text) throw new DocumentExtractionError("No readable text found in this .doc file.");
  const units = splitByHeadings(text);
  return {
    pageModel: "sectioned",
    pageCount: units.length,
    units,
    text: text.slice(0, MAX_TEXT_CHARS),
  };
}

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i + 1).toLowerCase();
}

export async function extractFile(filename: string, mimeType: string, buf: Buffer): Promise<ExtractResult> {
  const ext = extensionOf(filename);
  if (ext === "pdf" || mimeType === "application/pdf") return extractPdf(buf);
  if (ext === "docx") return extractDocx(buf);
  if (ext === "doc") return extractDoc(buf);
  if (ext === "pptx") return extractPptx(buf);
  if (ext === "xlsx" || ext === "xls") return extractXlsx(buf);
  if (["txt", "md", "markdown", "csv"].includes(ext)) return extractPlain(buf);
  if (ext === "ppt") {
    throw new UnsupportedFileTypeError();
  }
  throw new UnsupportedFileTypeError();
}