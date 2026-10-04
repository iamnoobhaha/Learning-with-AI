import { NextResponse } from "next/server";
import db from "@/lib/db";
import { gradeMessages } from "@/lib/prompts";
import { aiComplete, extractJson } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface GradedItem {
  index: number;
  score: number;
  feedback: string;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as {
      answers?: { questionId: number; value: string }[];
    };
    const answers = new Map<number, string>();
    for (const a of body.answers ?? []) answers.set(Number(a.questionId), String(a.value ?? ""));

    const quiz = db.prepare("SELECT id, best FROM quizzes WHERE id = ?").get(id) as
      | { id: string; best: number | null }
      | undefined;
    if (!quiz) return NextResponse.json({ error: "Quiz not found" }, { status: 404 });

    const questions = db
      .prepare("SELECT id, ord, type, prompt, options, answer, explanation FROM questions WHERE quiz_id = ? ORDER BY ord")
      .all(id) as {
      id: number;
      ord: number;
      type: "mcq" | "short";
      prompt: string;
      options: string;
      answer: string;
      explanation: string;
    }[];
    if (!questions.length) return NextResponse.json({ error: "Quiz has no questions" }, { status: 400 });

    const mcqItems = questions.filter((q) => q.type === "mcq");
    for (const q of mcqItems) {
      if (!answers.has(q.id)) answers.set(q.id, "");
    }

    const shorts = questions.filter((q) => q.type === "short");
    const toGrade = shorts.filter((q) => (answers.get(q.id) ?? "").trim());
    const aiGrades = new Map<number, { score: number; feedback: string }>();
    if (toGrade.length) {
      const raw = await aiComplete(
        gradeMessages(
          toGrade.map((q) => ({
            prompt: q.prompt,
            modelAnswer: q.answer || "(none)",
            studentAnswer: answers.get(q.id) || "",
          }))
        ),
        { temperature: 0.1, maxTokens: 2500 }
      );
      const parsed = extractJson<GradedItem[]>(raw);
      toGrade.forEach((q, i) => {
        const g = parsed.find((p) => Number(p.index) === i) ?? parsed[i];
        if (g) {
          aiGrades.set(q.id, {
            score: Math.max(0, Math.min(1, Number(g.score) || 0)),
            feedback: String(g.feedback || ""),
          });
        }
      });
    }
    for (const q of shorts) {
      if (!aiGrades.has(q.id)) {
        aiGrades.set(q.id, { score: 0, feedback: "No answer provided" });
      }
    }

    let earned = 0;
    const details = questions.map((q) => {
      const yourAnswer = answers.get(q.id) ?? "";
      if (q.type === "mcq") {
        const correct = yourAnswer.trim() === q.answer.trim();
        if (correct) earned += 1;
        return {
          questionId: q.id,
          type: q.type,
          correct,
          score: correct ? 1 : 0,
          feedback: correct ? "Correct" : "Incorrect",
          yourAnswer,
          modelAnswer:
            (JSON.parse(q.options) as string[])[Number(q.answer)] ?? q.answer,
        };
      }
      const g = aiGrades.get(q.id);
      const score = g?.score ?? 0;
      earned += score;
      return {
        questionId: q.id,
        type: q.type,
        correct: null,
        score,
        feedback: g?.feedback || "No feedback returned",
        yourAnswer,
        modelAnswer: q.answer,
      };
    });

    const total = questions.length;
    const scorePct = Math.round((earned / total) * 1000) / 10;

    const result = db
      .prepare("INSERT INTO attempts (quiz_id, score_pct, details) VALUES (?, ?, ?)")
      .run(id, scorePct, JSON.stringify(details));
    if (quiz.best === null || scorePct > quiz.best) {
      db.prepare("UPDATE quizzes SET best = ? WHERE id = ?").run(scorePct, id);
    }

    return NextResponse.json({
      attemptId: Number(result.lastInsertRowid),
      scorePct,
      details: details.map((d) => ({
        ...d,
        explanation:
          questions.find((q) => q.id === d.questionId)?.explanation ?? "",
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Grading failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
