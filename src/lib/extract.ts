import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import * as XLSX from "xlsx";
import JSZip from "jszip";

const MAX_TEXT = 400_000;
const MAX_BLOCK_CHARS = 6000;

export interface ContentBlock {
  label: string;
  text: string;
}

export interface ExtractResult {
  text: string;
  pages: number | null;
  blocks: ContentBlock[];
}

export class UnsupportedFileTypeError extends Error {
  constructor() {
    super("Unsupported file type. Upload PDF, DOC, DOCX, PPTX, XLSX, XLS, TXT or MD.");
  }
}

function clean(text: string): string {
  return text.replace(/\u0000/g, "").replace(/\r/g, "").trim();
}

function cap(text: string): string {
  return text.slice(0, MAX_TEXT);
}

function capBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  let total = 0;
  for (const b of blocks) {
    const room = MAX_TEXT - total;
    if (room <= 0) break;
    const text = b.text.slice(0, room);
    if (!text.trim()) continue;
    out.push({ label: b.label, text });
    total += text.length;
  }
  return out;
}

function splitByHeadings(text: string, label: string): ContentBlock[] {
  const lines = text.split("\n");
  const blocks: ContentBlock[] = [];
  let current: string[] = [];
  let heading = label;
  const flush = () => {
    const body = current.join("\n").trim();
    if (body) blocks.push({ label: heading, text: body });
    current = [];
  };
  const isHeading = (line: string) => {
    const t = line.trim();
    if (!t || t.length > 80) return false;
    if (/^#{1,6}\s+\S/.test(t)) return true;
    if (/^(page|slide|sheet)\s+\d+\b/i.test(t)) return true;
    if (/^(lecture|class|tutorial|session|chapter|topic|unit|week)\b[\s#:.-]*\d*\b/i.test(t)) return true;
    if (/^[A-Z0-9][A-Z0-9 ,&'()\-]{3,60}$/.test(t) && /[A-Z]{3}/.test(t)) return true;
    return false;
  };
  for (const line of lines) {
    if (isHeading(line) && current.join("\n").trim()) {
      flush();
      heading = line.trim().replace(/^#+\s*/, "").slice(0, 80);
    }
    current.push(line);
  }
  flush();
  if (!blocks.length && text.trim()) blocks.push({ label, text: text.trim() });
  return blocks;
}

function packBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.text.length <= MAX_BLOCK_CHARS) {
      out.push(block);
      continue;
    }
    const parts = Math.ceil(block.text.length / MAX_BLOCK_CHARS);
    const size = Math.ceil(block.text.length / parts);
    for (let i = 0; i < parts; i++) {
      out.push({
        label: parts > 1 ? `${block.label} (part ${i + 1}/${parts})` : block.label,
        text: block.text.slice(i * size, (i + 1) * size),
      });
    }
  }
  return out;
}

export async function extractPdf(buf: Buffer): Promise<ExtractResult> {
  const out = await pdfParse(buf);
  const text = clean(out.text);
  if (!text) throw new Error("Could not extract any text. Is the PDF scanned images?");
  const pages: string[] = text.split("\f").map((p) => p.trim());
  const numbered = pages.some((p) => p.length > 0);
  const blocks = numbered
    ? packBlocks(
        pages
          .map((p, i) => ({ label: `Page ${i + 1}`, text: p }))
          .filter((b) => b.text.length > 0)
      )
    : splitByHeadings(text, "Document");
  return { text: cap(text), pages: out.numpages ?? null, blocks: capBlocks(blocks) };
}

export function extractPlain(buf: Buffer): ExtractResult {
  const text = clean(buf.toString("utf8"));
  if (!text) throw new Error("The file appears to be empty.");
  const blocks = packBlocks(splitByHeadings(text, "Notes"));
  return { text: cap(text), pages: null, blocks: capBlocks(blocks) };
}

const wordExtractor = new WordExtractor();

export async function extractDocx(buf: Buffer): Promise<ExtractResult> {
  const { value } = await mammoth.extractRawText({ buffer: buf });
  const text = clean(value);
  if (!text) throw new Error("No text found in the Word document (is it image-only?)");
  const blocks = packBlocks(splitByHeadings(text, "Document"));
  return { text: cap(text), pages: null, blocks: capBlocks(blocks) };
}

export async function extractDoc(buf: Buffer): Promise<ExtractResult> {
  const doc = await wordExtractor.extract(buf);
  const parts = [doc.getBody()];
  try {
    parts.push(doc.getTextboxes());
  } catch {}
  try {
    parts.push(doc.getFootnotes());
  } catch {}
  const text = clean(parts.filter(Boolean).join("\n\n"));
  if (!text) throw new Error("No readable text found in the legacy .doc file");
  const blocks = packBlocks(splitByHeadings(text, "Document"));
  return { text: cap(text), pages: null, blocks: capBlocks(blocks) };
}

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

export async function extractPptx(buf: Buffer): Promise<ExtractResult> {
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(
      (a, b) =>
        Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1])
    );
  if (!slideNames.length) {
    throw new Error("Not a valid PowerPoint file (no slides found)");
  }

  const blocks: ContentBlock[] = [];
  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.file(slideNames[i])!.async("string");
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((m) => decodeXmlEntities(m[1]).trim())
      .filter(Boolean);
    if (!runs.length) continue;
    blocks.push({ label: `Slide ${i + 1}`, text: runs.join("\n") });
  }
  const text = clean(blocks.map((b) => `[${b.label}]\n${b.text}`).join("\n\n"));
  if (!text) throw new Error("No text found in the presentation (is it image-only?)");
  return { text: cap(text), pages: slideNames.length, blocks: capBlocks(blocks) };
}

export async function extractXlsx(buf: Buffer): Promise<ExtractResult> {
  const wb = XLSX.read(buf, { type: "buffer" });
  const blocks: ContentBlock[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (!csv.trim()) continue;
    blocks.push({ label: `Sheet: ${name}`, text: csv });
  }
  const text = clean(blocks.map((b) => `[${b.label}]\n${b.text}`).join("\n\n"));
  if (!text) throw new Error("No data found in the workbook");
  return { text: cap(text), pages: null, blocks: capBlocks(blocks) };
}

export async function extractFile(
  filename: string,
  mimeType: string,
  buf: Buffer
): Promise<ExtractResult> {
  const name = filename.toLowerCase();
  if (name.endsWith(".pdf") || mimeType === "application/pdf") return extractPdf(buf);
  if (name.endsWith(".docx")) return extractDocx(buf);
  if (name.endsWith(".doc")) return extractDoc(buf);
  if (name.endsWith(".pptx")) return extractPptx(buf);
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return extractXlsx(buf);
  if (/\.(txt|md|markdown|csv)$/.test(name)) return extractPlain(buf);
  throw new UnsupportedFileTypeError();
}
