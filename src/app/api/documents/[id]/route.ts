import { NextResponse } from "next/server";
import db from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    libraryId?: string | null;
    title?: string;
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
