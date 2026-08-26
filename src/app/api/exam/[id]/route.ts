import { NextResponse } from "next/server";
import db, { type ExamRow } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = db.prepare("SELECT * FROM exams WHERE id = ?").get(id) as ExamRow | undefined;
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ exam: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  db.prepare("DELETE FROM exams WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
