import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FILES_DIR } from "./db";

export const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_MB ? Number(process.env.MAX_UPLOAD_MB) * 1024 * 1024 : 25 * 1024 * 1024
);
export const MAX_PDF_PAGES = 500;
export const MAX_SLIDES = 400;
export const MAX_TEXT_CHARS = 400_000;

export interface StoredFile {
  storedName: string;
  absPath: string;
  mime: string;
  size: number;
}

/** File signatures we trust more than the client-supplied mime/extension. */
const SIGNATURES: { ext: string[]; mime: string; bytes: number[]; offset?: number }[] = [
  { ext: ["pdf"], mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { ext: ["docx", "pptx", "xlsx"], mime: "application/zip", bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK.. (also doc/ppt/xls OLE below)
  { ext: ["doc", "ppt", "xls"], mime: "application/x-ole-storage", bytes: [0xd0, 0xcf, 0x11, 0xe0] },
];

export const SUPPORTED_EXTENSIONS = [
  "pdf",
  "txt",
  "md",
  "markdown",
  "csv",
  "doc",
  "docx",
  "pptx",
  "xlsx",
  "xls",
] as const;

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i + 1).toLowerCase();
}

/** Strips directory components and anything unsafe; never returns a path. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "upload";
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  return cleaned || "upload";
}

export function detectMime(filename: string, buf: Buffer): string | null {
  const ext = extensionOf(filename);
  for (const sig of SIGNATURES) {
    if (!sig.ext.includes(ext)) continue;
    const start = sig.offset ?? 0;
    const slice = buf.subarray(start, start + sig.bytes.length);
    if (sig.bytes.every((b, i) => slice[i] === b)) return sig.mime;
  }
  if (["txt", "md", "markdown", "csv"].includes(ext)) return "text/plain";
  return null;
}

export function assertSupported(filename: string, buf: Buffer): { mime: string } {
  const ext = extensionOf(filename);
  if (!SUPPORTED_EXTENSIONS.includes(ext as (typeof SUPPORTED_EXTENSIONS)[number])) {
    throw new UploadValidationError(
      `Unsupported file type ".${ext || "?"}". Upload PDF, DOC, DOCX, PPTX, XLSX, XLS, TXT, MD or CSV.`,
      415
    );
  }
  if (!buf.length) throw new UploadValidationError("The uploaded file is empty.", 422);
  const mime = detectMime(filename, buf);
  if (!mime) {
    throw new UploadValidationError(
      "That file's contents do not match its extension — the file may be corrupt or renamed.",
      415
    );
  }
  return { mime };
}

export class UploadValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "UploadValidationError";
    this.status = status;
  }
}

export class UnsupportedFileTypeError extends UploadValidationError {
  constructor() {
    super(
      "Unsupported file type. Upload PDF, DOC, DOCX, PPTX, XLSX, XLS, TXT, MD or CSV. Legacy .ppt is not supported — re-save it as .pptx.",
      415
    );
    this.name = "UnsupportedFileTypeError";
  }
}

/**
 * Persists the original upload outside the public directory so that page
 * previews can be re-rendered later. Returns paths only; nothing is served
 * statically.
 */
export function storeOriginal(filename: string, buf: Buffer, mime: string): StoredFile {
  const ext = extensionOf(sanitizeFilename(filename)) || "bin";
  const storedName = `${randomUUID()}.${ext}`;
  const absPath = path.join(FILES_DIR, storedName);
  fs.writeFileSync(absPath, buf, { mode: 0o600 });
  return { storedName, absPath, mime, size: buf.length };
}

export function readOriginal(storedName: string): Buffer | null {
  // Defence in depth: never allow traversal out of the files directory.
  const safe = path.basename(storedName);
  const absPath = path.join(FILES_DIR, safe);
  if (!absPath.startsWith(FILES_DIR)) return null;
  try {
    return fs.readFileSync(absPath);
  } catch {
    return null;
  }
}

export function deleteOriginal(storedName: string | null): void {
  if (!storedName) return;
  const safe = path.basename(storedName);
  try {
    fs.unlinkSync(path.join(FILES_DIR, safe));
  } catch {
    // already gone — nothing to clean up
  }
}

/**
 * Guards against zip bombs in Office containers before we hand the buffer to a
 * decompressing library (JSZip / mammoth / xlsx).
 */
export function assertSafeArchiveSize(buf: Buffer, limitRatio = 120): void {
  // EOCD signature, last 22+ bytes
  const tail = buf.subarray(Math.max(0, buf.length - 66_000));
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return; // not a zip we can measure
  const entries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (entries > 20_000) {
    throw new UploadValidationError("That Office file contains too many internal entries.", 422);
  }
  const declared = cdOffset + cdSize;
  if (declared > 0 && buf.length > 0 && declared / buf.length > limitRatio) {
    throw new UploadValidationError(
      "That Office file expands to an unsafe size (possible zip bomb) and was rejected.",
      422
    );
  }
}

export function assertNotEncryptedPdf(buf: Buffer): void {
  // /Encrypt in the trailer means content is password protected.
  const tail = buf.subarray(Math.max(0, buf.length - 4096)).toString("latin1");
  if (/\/Encrypt\b/.test(tail)) {
    throw new UploadValidationError(
      "This PDF is password protected. Remove the password and upload it again.",
      422
    );
  }
}