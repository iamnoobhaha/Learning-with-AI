import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { evenContext, evenLibraryContext, docIdsInLibrary } from "@/lib/context";
import { quizMessages } from "@/lib/prompts";
import { aiComplete, extractJson } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface GeneratedQuestion {
  type: "mcq" | "short";
  prompt: string;
  options?: string[];
  answer_index?: number;
  answer?: string;
  explanation?: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const documentId = url.searchParams.get("documentId");
  const libraryId = url.searchParams.get("libraryId");
  if (!documentId && !libraryId) {
    return NextResponse.json({ error: "documentId or libraryId required" }, { status: 400 });
  }
  const where = documentId ? "q.document_id = ?" : "q.library_id = ?";
  const scopeVal = documentId ?? libraryId;
  const rows = db
    .prepare(
      `SELECT q.id, q.title, q.difficulty, q.best, q.created_at, COUNT(qu.id) AS question_count
       FROM quizzes q LEFT JOIN questions qu ON qu.quiz_id = q.id
       WHERE ${where} GROUP BY q.id ORDER BY q.created_at DESC, q.id DESC`
    )
    .all(scopeVal) as {
    id: string;
    title: string;
    difficulty: string;
    best: number | null;
    created_at: string;
    question_count: number;
  }[];

  const attemptRows = db
    .prepare(
      `SELECT a.quiz_id, a.score_pct FROM attempts a
       JOIN quizzes q ON q.id = a.quiz_id
       WHERE ${where}
       ORDER BY a.id DESC`
    )
    .all(scopeVal) as { quiz_id: string; score_pct: number }[];
  const byQuiz = new Map<string, { count: number; scores: number[] }>();
  for (const r of attemptRows) {
    const e = byQuiz.get(r.quiz_id) ?? { count: 0, scores: [] };
    e.count += 1;
    if (e.scores.length < 6) e.scores.push(Math.round(Number(r.score_pct)));
    byQuiz.set(r.quiz_id, e);
  }

  return NextResponse.json({
    quizzes: rows.map((r) => {
      const att = byQuiz.get(r.id);
      return {
        id: r.id,
        title: r.title,
        difficulty: r.difficulty,
        best: r.best,
        createdAt: r.created_at,
        questionCount: Number(r.question_count),
        attemptCount: att?.count ?? 0,
        recentScores: [...(att?.scores ?? [])].reverse(),
      };
    }),
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      documentId?: string;
      libraryId?: string;
      count?: number;
      mcqRatio?: number;
      difficulty?: string;
    };
    if (!body.documentId && !body.libraryId) {
      return NextResponse.json(
        { error: "documentId or libraryId required" },
        { status: 400 }
      );
    }

    let context: string;
    let sourceTitle: string;
    if (body.documentId) {
      const doc = db
        .prepare("SELECT id, title FROM documents WHERE id = ?")
        .get(body.documentId) as { id: string; title: string } | undefined;
      if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });
      sourceTitle = doc.title;
      context = evenContext(doc.id, 30000);
    } else {
      const lib = db
        .prepare("SELECT id, name FROM libraries WHERE id = ?")
        .get(body.libraryId!) as { id: string; name: string } | undefined;
      if (!lib) return NextResponse.json({ error: "Library not found" }, { status: 404 });
      const docIds = docIdsInLibrary(lib.id);
      if (!docIds.length) {
        return NextResponse.json(
          { error: "This library has no documents yet — upload some notes first." },
          { status: 400 }
        );
      }
      sourceTitle = `${lib.name} (${docIds.length} documents)`;
      context = evenLibraryContext(lib.id, 34000);
    }

    const count = Math.min(Math.max(body.count ?? 8, 3), 20);
    const mcqRatio = Math.min(Math.max(body.mcqRatio ?? 0.7, 0), 1);
    const difficulty = ["easy", "medium", "hard"].includes(String(body.difficulty))
      ? String(body.difficulty)
      : "medium";
    const mcqCount = Math.round(count * mcqRatio);
    const shortCount = count - mcqCount;

    const raw = await aiComplete(
      quizMessages({ title: sourceTitle, context, mcqCount, shortCount, difficulty }),
      { temperature: 0.6, maxTokens: 6000 }
    );
    const parsed = extractJson<{ title?: string; questions: GeneratedQuestion[] }>(raw);
    if (!Array.isArray(parsed.questions)) {
      throw new Error("Model returned no questions");
    }

    // normalize + validate each candidate before enforcing counts
    const validMcqs: { prompt: string; options: string[]; answerIndex: number; explanation: string }[] = [];
    const validShorts: { prompt: string; answer: string; explanation: string }[] = [];
    for (const q of parsed.questions) {
      const prompt = String(q.prompt ?? "").trim();
      if (!prompt) continue;
      const explanation = String(q.explanation ?? "").trim();
      if (q.type === "mcq") {
        let opts = Array.isArray(q.options)
          ? q.options.map((o) => String(o ?? "").trim()).filter(Boolean)
          : [];
        const seen = new Set<string>();
        opts = opts.filter((o) => {
          const k = o.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        if (opts.length < 2) continue;
        if (opts.length > 4) opts = opts.slice(0, 4);
        const idx = Number(q.answer_index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= opts.length) continue;
        validMcqs.push({ prompt, options: opts, answerIndex: idx, explanation });
      } else {
        const answer = String(q.answer ?? "").trim();
        if (!answer) continue;
        validShorts.push({ prompt, answer, explanation });
      }
    }
    if (validMcqs.length + validShorts.length === 0) {
      throw new Error("Model returned no usable questions — please try again");
    }

    // enforce the requested mcq/short split; cross-fill from the surplus type on shortfall
    let pickedMcq = validMcqs.slice(0, mcqCount);
    let pickedShort = validShorts.slice(0, shortCount);
    if (pickedMcq.length < mcqCount) {
      pickedShort = pickedShort.slice(
        0,
        Math.min(pickedShort.length, count - pickedMcq.length)
      );
    } else if (pickedShort.length < shortCount) {
      pickedMcq = pickedMcq.slice(
        0,
        Math.min(pickedMcq.length, count - pickedShort.length)
      );
    }

    // interleave types so they appear mixed
    const ordered: (
      | { type: "mcq"; prompt: string; options: string[]; answerIndex: number; explanation: string }
      | { type: "short"; prompt: string; answer: string; explanation: string }
    )[] = [];
    let mi = 0;
    let si = 0;
    while (mi < pickedMcq.length || si < pickedShort.length) {
      if (mi < pickedMcq.length) ordered.push({ type: "mcq", ...pickedMcq[mi++] });
      if (si < pickedShort.length) ordered.push({ type: "short", ...pickedShort[si++] });
    }
    if (!ordered.length) throw new Error("Model returned no usable questions — please try again");

    const quizId = randomUUID();
    const insertQuiz = db.prepare(
      "INSERT INTO quizzes (id, document_id, library_id, title, difficulty) VALUES (?, ?, ?, ?, ?)"
    );
    const insertQ = db.prepare(
      "INSERT INTO questions (quiz_id, ord, type, prompt, options, answer, explanation) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    db.transaction(() => {
      insertQuiz.run(
        quizId,
        body.documentId ?? null,
        body.libraryId ?? null,
        parsed.title?.slice(0, 200) || `${sourceTitle} quiz`,
        difficulty
      );
      ordered.forEach((q, i) => {
        const isMcq = q.type === "mcq";
        insertQ.run(
          quizId,
          i,
          q.type,
          q.prompt,
          JSON.stringify(isMcq ? q.options : []),
          isMcq ? String((q as { answerIndex: number }).answerIndex) : (q as { answer: string }).answer,
          q.explanation
        );
      });
    })();

    return NextResponse.json({
      quizId,
      questionCount: ordered.length,
      mcqCount: pickedMcq.length,
      shortCount: pickedShort.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
