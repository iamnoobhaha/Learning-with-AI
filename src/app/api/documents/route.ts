import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { chunkBlocks, isLowValueBlock, stripJunkLines } from "@/lib/context";
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
    let blocks: { label: string; text: string }[] = [];
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const result = await extractFile(file.name, file.type, buf);
      text = result.text;
      pages = result.pages;
      blocks = result.blocks;
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

    if (!blocks.length) blocks = [{ label: "Document", text }];

    // drop admin-only sections entirely, and strip logistics lines from mixed ones
    const MIN_BLOCK_CHARS = 120;
    const keptBlocks: { label: string; text: string }[] = [];
    const junkBlocks = new Set<number>();
    blocks.forEach((b, i) => {
      if (isLowValueBlock(b.text)) {
        junkBlocks.add(i);
        return;
      }
      const stripped = stripJunkLines(b.text);
      if (stripped.trim().length < MIN_BLOCK_CHARS) {
        junkBlocks.add(i);
        return;
      }
      keptBlocks.push({ label: b.label, text: stripped });
    });
    if (!keptBlocks.length) {
      return NextResponse.json(
        {
          error:
            "No study content found in this file — it appears to contain only a title, schedule or admin details.",
        },
        { status: 422 }
      );
    }

    const pieces = chunkBlocks(keptBlocks);
    const ins = db.prepare(
      "INSERT INTO chunks (document_id, idx, text, block_index, included) VALUES (?, ?, ?, ?, ?)"
    );
    db.transaction(() =>
      pieces.forEach((p, i) => ins.run(id, i, p.text, p.blockIndex, 1))
    )();

    return NextResponse.json({
      id,
      libraryId,
      blocks: keptBlocks.length,
      autoExcluded: junkBlocks.size,
      excludedLabels: [...junkBlocks]
        .map((i) => blocks[i]?.label)
        .filter(Boolean)
        .slice(0, 8),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
