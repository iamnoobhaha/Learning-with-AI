import { describe, it, expect } from "vitest";
import {
  sanitizeFilename,
  extensionOf,
  detectMime,
  assertSupported,
  assertSafeArchiveSize,
  assertNotEncryptedPdf,
  UploadValidationError,
  MAX_UPLOAD_BYTES,
} from "@/lib/storage";

const PDF_HEADER = Buffer.from("%PDF-1.4\n", "latin1");
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const OLE_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

describe("filename safety", () => {
  it("strips directory components to prevent traversal", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\windows\\system32\\cmd.exe")).toBe("cmd.exe");
    expect(sanitizeFilename("/absolute/path/file.pdf")).toBe("file.pdf");
  });

  it("removes unsafe characters and never returns an empty name", () => {
    expect(sanitizeFilename("notes;rm -rf.pdf")).not.toContain(";");
    expect(sanitizeFilename("")).toBe("upload");
    expect(sanitizeFilename("...")).toBe("upload");
  });

  it("extracts extensions case-insensitively", () => {
    expect(extensionOf("Report.PDF")).toBe("pdf");
    expect(extensionOf("noext")).toBe("");
  });
});

describe("content signature validation", () => {
  it("detects PDF, zip-based office and OLE office by content", () => {
    expect(detectMime("a.pdf", PDF_HEADER)).toBe("application/pdf");
    expect(detectMime("a.pptx", ZIP_HEADER)).toBe("application/zip");
    expect(detectMime("a.doc", OLE_HEADER)).toBe("application/x-ole-storage");
    expect(detectMime("a.txt", Buffer.from("hello"))).toBe("text/plain");
  });

  it("rejects a file whose contents do not match its extension", () => {
    // A renamed executable must not be accepted as a PDF.
    expect(() => assertSupported("evil.pdf", Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toThrow(
      UploadValidationError
    );
  });

  it("rejects unsupported extensions", () => {
    expect(() => assertSupported("script.exe", Buffer.from([0x4d, 0x5a]))).toThrow(
      /unsupported file type/i
    );
  });

  it("rejects an empty file", () => {
    expect(() => assertSupported("a.pdf", Buffer.alloc(0))).toThrow(/empty/i);
  });

  it("accepts a valid PDF", () => {
    expect(() => assertSupported("a.pdf", PDF_HEADER)).not.toThrow();
  });

  it("rejects legacy .ppt with a helpful message", () => {
    expect(() => assertSupported("deck.ppt", OLE_HEADER)).toThrow(/pptx/i);
  });
});

describe("archive and encryption guards", () => {
  it("rejects an obviously zip-bomb-shaped archive", () => {
    // Build a small buffer whose central directory claims a huge offset.
    const buf = Buffer.alloc(200);
    buf.write("PK\u0003\u0004", 0, "latin1");
    // EOCD at the end
    const eocd = buf.length - 22;
    buf.writeUInt32LE(0x06054b50, eocd);
    buf.writeUInt16LE(1, eocd + 8); // entries
    buf.writeUInt32LE(0xfffff0, eocd + 12); // cd size (huge)
    buf.writeUInt32LE(10, eocd + 16); // cd offset small -> ratio enormous
    expect(() => assertSafeArchiveSize(buf, 50)).toThrow(/unsafe size|zip bomb/i);
  });

  it("allows a normal archive", () => {
    const buf = Buffer.alloc(200);
    buf.write("PK\u0003\u0004", 0, "latin1");
    const eocd = buf.length - 22;
    buf.writeUInt32LE(0x06054b50, eocd);
    buf.writeUInt16LE(3, eocd + 8);
    buf.writeUInt32LE(50, eocd + 12);
    buf.writeUInt32LE(100, eocd + 16);
    expect(() => assertSafeArchiveSize(buf, 120)).not.toThrow();
  });

  it("detects encrypted PDFs", () => {
    const enc = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /Standard >>\ntrailer << /Encrypt 9 0 R >>\n%%EOF");
    expect(() => assertNotEncryptedPdf(enc)).toThrow(/password/i);
  });

  it("allows an unencrypted PDF", () => {
    expect(() => assertNotEncryptedPdf(PDF_HEADER)).not.toThrow();
  });

  it("exposes a sane default upload limit", () => {
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBeLessThanOrEqual(200 * 1024 * 1024);
  });
});