import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import * as XLSX from "xlsx";
import JSZip from "jszip";

const MAX_TEXT = 400_000;

export interface ExtractResult {
  text: string;
  pages: number | null;
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

export async function extractPdf(buf: Buffer): Promise<ExtractResult> {
  const out = await pdfParse(buf);
  const text = clean(out.text);
  if (!text) throw new Error("Could not extract any text. Is the PDF scanned images?");
  return { text: cap(text), pages: out.numpages ?? null };
}

export function extractPlain(buf: Buffer): ExtractResult {
  const text = clean(buf.toString("utf8"));
  if (!text) throw new Error("The file appears to be empty.");
  return { text: cap(text), pages: null };
}

const wordExtractor = new WordExtractor();

export async function extractDocx(buf: Buffer): Promise<ExtractResult> {
  const { value } = await mammoth.extractRawText({ buffer: buf });
  const text = clean(value);
  if (!text) throw new Error("No text found in the Word document (is it image-only?)");
  return { text: cap(text), pages: null };
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
  return { text: cap(text), pages: null };
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

  let out = "";
  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.file(slideNames[i])!.async("string");
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((m) => decodeXmlEntities(m[1]).trim())
      .filter(Boolean);
    if (!runs.length) continue;
    out += `\n\n[Slide ${i + 1}]\n${runs.join("\n")}`;
  }
  const text = clean(out);
  if (!text) throw new Error("No text found in the presentation (is it image-only?)");
  return { text: cap(text), pages: slideNames.length };
}

export async function extractXlsx(buf: Buffer): Promise<ExtractResult> {
  const wb = XLSX.read(buf, { type: "buffer" });
  let out = "";
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (!csv.trim()) continue;
    out += `\n\n[Sheet: ${name}]\n${csv}`;
  }
  const text = clean(out);
  if (!text) throw new Error("No data found in the workbook");
  return { text: cap(text), pages: null };
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
