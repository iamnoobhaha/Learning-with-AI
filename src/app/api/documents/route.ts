import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { chunkText } from "@/lib/context";
import { findOrCreateLibrary } from "@/lib/libraries";
import { extractFile, UnsupportedFileTypeError } from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = db
    .prepare(
      `SELECT id, kind, title, filename, size, pages, library_id, created_at
       FROM documents ORDER BY created_at DESC, id DESC`
    )
    .all();
  return NextResponse.json({ documents: rows });
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    const kind = form.get("kind") === "past_paper" ? "past_paper" : "notes";
    const title =
      String(form.get("title") || "").trim() || file.name.replace(/\.[^.]+$/, "");

    let libraryId: string | null = null;
    const rawLibraryId = String(form.get("libraryId") || "").trim();
    const libraryName = String(form.get("libraryName") || "").trim();
    if (rawLibraryId) {
      const lib = db
        .prepare("SELECT id FROM libraries WHERE id = ?")
        .get(rawLibraryId) as { id: string } | undefined;
      if (!lib) return NextResponse.json({ error: "Library not found" }, { status: 404 });
      libraryId = lib.id;
    } else if (libraryName) {
      libraryId = findOrCreateLibrary(libraryName).id;
    }

    let text = "";
    let pages: number | null = null;
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const result = await extractFile(file.name, file.type, buf);
      text = result.text;
      pages = result.pages;
    } catch (err) {
      if (err instanceof UnsupportedFileTypeError) {
        return NextResponse.json({ error: err.message }, { status: 415 });
      }
      const message = err instanceof Error ? err.message : "Could not read the file";
      return NextResponse.json(
        { error: message.startsWith("No ") || message.includes("extract") ? message : `Could not read the file: ${message}` },
        { status: 422 }
      );
    }

    if (!text) {
      return NextResponse.json(
        { error: "Could not extract any text from this file." },
        { status: 422 }
      );
    }

    const id = randomUUID();
    db.prepare(
      "INSERT INTO documents (id, kind, title, filename, size, pages, content, library_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, kind, title, file.name, file.size, pages, text, libraryId);

    const chunks = chunkText(text);
    const ins = db.prepare("INSERT INTO chunks (document_id, idx, text) VALUES (?, ?, ?)");
    db.transaction(() => chunks.forEach((t, i) => ins.run(id, i, t)))();

    return NextResponse.json({ id, libraryId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
