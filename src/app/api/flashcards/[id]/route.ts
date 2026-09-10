import { NextResponse } from "next/server";
import db from "@/lib/db";
import { nextSchedule, boxFor, type SrsState } from "@/lib/srs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json()) as { result?: string };
  const row = db
    .prepare("SELECT interval, ease, reps, lapses FROM flashcards WHERE id = ?")
    .get(id) as SrsState | undefined;
  if (!row) return NextResponse.json({ error: "Card not found" }, { status: 404 });
  const result = body.result === "know" ? "know" : "again";
  const sched = nextSchedule(row, result);
  db.prepare(
    `UPDATE flashcards
     SET box = ?, due_at = ?, interval = ?, ease = ?, reps = ?, lapses = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(boxFor(sched.interval), sched.dueAt, sched.interval, sched.ease, sched.reps, sched.lapses, id);
  return NextResponse.json({ ok: true, box: boxFor(sched.interval), ...sched });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  db.prepare("DELETE FROM flashcards WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
