import { NextResponse } from "next/server";
import db from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const quiz = db
    .prepare("SELECT id, document_id, title, difficulty, best, created_at FROM quizzes WHERE id = ?")
    .get(id) as
    | { id: string; document_id: string; title: string; difficulty: string; best: number | null; created_at: string }
    | undefined;
  if (!quiz) return NextResponse.json({ error: "Quiz not found" }, { status: 404 });

  const rows = db
    .prepare("SELECT id, ord, type, prompt, options FROM questions WHERE quiz_id = ? ORDER BY ord")
    .all(id) as { id: number; ord: number; type: "mcq" | "short"; prompt: string; options: string }[];

  return NextResponse.json({
    quiz: {
      id: quiz.id,
      title: quiz.title,
      difficulty: quiz.difficulty,
      documentId: quiz.document_id,
      questions: rows.map((r) => ({
        id: r.id,
        ord: r.ord,
        type: r.type,
        prompt: r.prompt,
        options: JSON.parse(r.options) as string[],
      })),
    },
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  db.prepare("DELETE FROM quizzes WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
