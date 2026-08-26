import { NextResponse } from "next/server";
import db from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json()) as { result?: string };
  const row = db.prepare("SELECT box FROM flashcards WHERE id = ?").get(id) as
    | { box: number }
    | undefined;
  const box =
    body.result === "know" ? Math.min(5, (row?.box ?? 0) + 1) : 0;
  db.prepare("UPDATE flashcards SET box = ?, updated_at = datetime('now') WHERE id = ?").run(box, id);
  return NextResponse.json({ ok: true, box });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  db.prepare("DELETE FROM flashcards WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
