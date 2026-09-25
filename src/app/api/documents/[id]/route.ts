import { NextResponse } from "next/server";
import db from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const doc = db.prepare("SELECT id FROM documents WHERE id = ?").get(id);
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const rows = db
    .prepare(
      `SELECT block_index, COUNT(*) AS chunk_count, MIN(idx) AS first_idx,
              SUM(LENGTH(text)) AS chars, MAX(included) AS included
       FROM chunks WHERE document_id = ?
       GROUP BY block_index ORDER BY block_index ASC`
    )
    .all(id) as {
    block_index: number;
    chunk_count: number;
    first_idx: number;
    chars: number;
    included: number;
  }[];

  const previews = db
    .prepare(
      `SELECT block_index, text FROM chunks
       WHERE document_id = ? AND idx IN (
         SELECT MIN(idx) FROM chunks WHERE document_id = ? GROUP BY block_index
       ) ORDER BY block_index ASC`
    )
    .all(id, id) as { block_index: number; text: string }[];
  const previewByBlock = new Map(previews.map((p) => [p.block_index, p.text]));

  const labels = db
    .prepare("SELECT pages FROM documents WHERE id = ?")
    .get(id) as { pages: number | null } | undefined;

  const blocks = rows.map((r) => {
    const text = previewByBlock.get(r.block_index) ?? "";
    return {
      index: r.block_index,
      label: deriveLabel(text, r.block_index),
      preview: text.replace(/\s+/g, " ").slice(0, 220),
      chars: Number(r.chars ?? 0),
      included: Number(r.included ?? 1) === 1,
    };
  });

  return NextResponse.json({
    blocks,
    totalChars: blocks.reduce((n, b) => n + (b.included ? b.chars : 0), 0),
    allChars: blocks.reduce((n, b) => n + b.chars, 0),
    pages: labels?.pages ?? null,
  });
}

function deriveLabel(text: string, index: number): string {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (/^(page|slide|sheet)\b/i.test(first)) return first.slice(0, 60);
  if (first.length > 0 && first.length <= 70) return first;
  return `Section ${index + 1}`;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    libraryId?: string | null;
    title?: string;
    blockIndex?: number;
    included?: boolean;
    allIncluded?: boolean;
    blocks?: { index: number; included: boolean }[];
  };

  const doc = db.prepare("SELECT id FROM documents WHERE id = ?").get(id);
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  if (body.libraryId !== undefined) {
    if (body.libraryId === null || body.libraryId === "") {
      db.prepare("UPDATE documents SET library_id = NULL WHERE id = ?").run(id);
    } else {
      const lib = db
        .prepare("SELECT id FROM libraries WHERE id = ?")
        .get(String(body.libraryId)) as { id: string } | undefined;
      if (!lib) return NextResponse.json({ error: "Library not found" }, { status: 404 });
      db.prepare("UPDATE documents SET library_id = ? WHERE id = ?").run(lib.id, id);
    }
  }

  if (body.title !== undefined) {
    const title = String(body.title).trim().slice(0, 250);
    if (title) db.prepare("UPDATE documents SET title = ? WHERE id = ?").run(title, id);
  }

  if (typeof body.blockIndex === "number" && typeof body.included === "boolean") {
    db.prepare("UPDATE chunks SET included = ? WHERE document_id = ? AND block_index = ?").run(
      body.included ? 1 : 0,
      id,
      body.blockIndex
    );
  }

  if (Array.isArray(body.blocks)) {
    const update = db.prepare(
      "UPDATE chunks SET included = ? WHERE document_id = ? AND block_index = ?"
    );
    db.transaction(() => {
      for (const b of body.blocks!) update.run(b.included ? 1 : 0, id, b.index);
    })();
  }

  if (typeof body.allIncluded === "boolean") {
    db.prepare("UPDATE chunks SET included = ? WHERE document_id = ?").run(
      body.allIncluded ? 1 : 0,
      id
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
