import { NextResponse } from "next/server";
import db from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const lib = db
    .prepare("SELECT id, name, created_at FROM libraries WHERE id = ?")
    .get(id) as { id: string; name: string; created_at: string } | undefined;
  if (!lib) return NextResponse.json({ error: "Library not found" }, { status: 404 });

  const docs = db
    .prepare(
      `SELECT id, kind, title, filename, size, pages, library_id, created_at
       FROM documents WHERE library_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(id);
  return NextResponse.json({ library: lib, documents: docs });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });
  const row = db.prepare("SELECT id FROM libraries WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "Library not found" }, { status: 404 });
  try {
    db.prepare("UPDATE libraries SET name = ? WHERE id = ?").run(name.slice(0, 120), id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "A library with that name already exists" }, { status: 409 });
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const withDocs = new URL(req.url).searchParams.get("withDocs") === "1";
  const lib = db
    .prepare("SELECT id FROM libraries WHERE id = ?")
    .get(id) as { id: string } | undefined;
  if (!lib) return NextResponse.json({ error: "Library not found" }, { status: 404 });
  if (withDocs) {
    db.prepare("DELETE FROM documents WHERE library_id = ?").run(id);
  }
  db.prepare("DELETE FROM libraries WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
