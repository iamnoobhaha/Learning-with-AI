import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { quizMessages } from "@/lib/prompts";
import { aiComplete, extractJson } from "@/lib/ai";
import { dedupeAgainst } from "@/lib/dedup";
import {
  buildContext,
  documentScopeName,
  libraryScopeName,
  NoIncludedContentError,
  summariseSources,
} from "@/lib/ai-context";

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

function shuffleMcqOptions(options: string[], answerIndex: number) {
  const correct = options[answerIndex];
  const shuffled = options.map((option, index) => ({ option, index }));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return {
    options: shuffled.map((x) => x.option),
    answerIndex: shuffled.findIndex((x) => x.option === correct && x.index === answerIndex),
  };
}

/** Selection revision of a document, used to mark generated work stale later. */
function currentRevision(documentId: string): number {
  const row = db
    .prepare("SELECT selection_revision FROM documents WHERE id = ?")
    .get(documentId) as { selection_revision: number } | undefined;
  return row?.selection_revision ?? 1;
}

/** For course scope, the newest revision among member documents. */
function maxLibraryRevision(libraryId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(selection_revision), 1) AS m FROM documents WHERE library_id = ?"
    )
    .get(libraryId) as { m: number };
  return Number(row.m) || 1;
}

function currentRevisionOfDocument(documentId: string): number {
  return currentRevision(documentId);
}

function maxRevisionInLibrary(libraryId: string): number {
  return maxLibraryRevision(libraryId);
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
  if (!scopeVal) {
    return NextResponse.json({ error: "documentId or libraryId required" }, { status: 400 });
  }
  const rows = db
    .prepare(
      `SELECT q.id, q.title, q.difficulty, q.best, q.created_at, q.selection_revision,
              COUNT(qu.id) AS question_count
       FROM quizzes q LEFT JOIN questions qu ON qu.quiz_id = q.id
       WHERE ${where} GROUP BY q.id ORDER BY q.created_at DESC, q.id DESC`
    )
    .all(scopeVal) as {
    id: string;
    title: string;
    difficulty: string;
    best: number | null;
    created_at: string;
    selection_revision: number | null;
    question_count: number;
  }[];

  // Current selection revision for the scope, so the client can flag stale work.
  const currentRevision = documentId
    ? currentRevisionOfDocument(documentId)
    : maxRevisionInLibrary(scopeVal);

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
        stale:
          r.selection_revision !== null && r.selection_revision < currentRevision,
        selectionRevision: r.selection_revision,
        currentRevision,
      };
    }),
  });
}

export async function POST(req: Request) {
  try {
    let body: {
      documentId?: string;
      libraryId?: string;
      count?: number;
      mcqRatio?: number;
      difficulty?: string;
      weak?: boolean;
      pageFrom?: number;
      pageTo?: number;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body.documentId && !body.libraryId) {
      return NextResponse.json(
        { error: "documentId or libraryId required" },
        { status: 400 }
      );
    }

    // One authoritative context builder; it can only see included pages.
    let built;
    try {
      built = buildContext({
        documentId: body.documentId,
        libraryId: body.libraryId,
        maxChars: 30000,
        coverage: true,
        pageRange:
          body.pageFrom || body.pageTo
            ? { from: body.pageFrom, to: body.pageTo }
            : undefined,
        scopeName: body.documentId
          ? documentScopeName(body.documentId)
          : libraryScopeName(body.libraryId!),
      });
    } catch (err) {
      if (err instanceof NoIncludedContentError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof Error && /not found/i.test(err.message)) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      return NextResponse.json({ error: "Could not read the selected pages" }, { status: 400 });
    }

    const context = built.text;
    const sourceTitle = body.documentId
      ? documentScopeName(body.documentId).replace(/"/g, "")
      : libraryScopeName(body.libraryId!).replace(/"/g, "");
    // Provenance: which pages this quiz was actually built from.
    const sourcePages = summariseSources(built.sources);

    const count = Math.min(Math.max(body.count ?? 8, 3), 20);
    const mcqRatio = Math.min(Math.max(body.mcqRatio ?? 0.7, 0), 1);
    const difficulty = ["easy", "medium", "hard"].includes(String(body.difficulty))
      ? String(body.difficulty)
      : "medium";
    const mcqCount = Math.round(count * mcqRatio);
    const shortCount = count - mcqCount;

    // ask for a few extra so duplicates can be discarded without returning short
    const surplus = 3;
    const askMcq = mcqCount + Math.min(surplus, Math.ceil(count * 0.25));
    const askShort = shortCount + Math.min(surplus, Math.ceil(count * 0.25));

    // prior questions for this scope: prompt avoidance + hard dedup
    const priorWhere = body.documentId ? "q.document_id = ?" : "q.library_id = ?";
    const priorRows = db
      .prepare(
        `SELECT qu.prompt FROM questions qu
         JOIN quizzes q ON q.id = qu.quiz_id
         WHERE ${priorWhere} ORDER BY qu.id DESC LIMIT 300`
      )
      .all(body.documentId ?? body.libraryId) as { prompt: string }[];
    const priorPrompts = priorRows.map((r) => r.prompt);
    const avoidList = priorPrompts
      .slice(0, 60)
      .map((p) => `- ${p.replace(/\s+/g, " ").slice(0, 120)}`)
      .join("\n");

    // targeted practice: mine recent attempts for missed questions
    let focus = "";
    if (body.weak) {
      const where = body.documentId ? "q.document_id = ?" : "q.library_id = ?";
      const scopeVal = body.documentId ?? body.libraryId;
      const attempts = db
        .prepare(
          `SELECT a.details FROM attempts a
           JOIN quizzes q ON q.id = a.quiz_id
           WHERE ${where} ORDER BY a.id DESC LIMIT 12`
        )
        .all(scopeVal) as { details: string }[];
      const missedQids: number[] = [];
      for (const a of attempts) {
        try {
          const dets = JSON.parse(a.details) as {
            questionId?: number;
            score?: number;
            correct?: boolean | null;
          }[];
          for (const d of dets) {
            const failed = d.correct === false || (d.score ?? 1) < 1;
            if (failed && d.questionId) missedQids.push(Number(d.questionId));
          }
        } catch {
          // ignore malformed stored details
        }
      }
      const unique = [...new Set(missedQids)].slice(0, 12);
      if (unique.length) {
        const qs = db
          .prepare(
            `SELECT id, prompt, answer, explanation FROM questions WHERE id IN (${unique.map(() => "?").join(",")})`
          )
          .all(...unique) as {
          id: number;
          prompt: string;
          answer: string;
          explanation: string;
        }[];
        const byId = new Map(qs.map((q) => [q.id, q]));
        focus = unique
          .map((qid, i) => {
            const q = byId.get(qid);
            if (!q) return "";
            return `${i + 1}. Prompt: ${q.prompt.slice(0, 220)}\n   Correct answer: ${q.answer.slice(0, 160)}`;
          })
          .filter(Boolean)
          .join("\n");
      }
      if (!focus) {
        return NextResponse.json(
          { error: "No weak spots found — you've answered everything correctly. Keep it up!" },
          { status: 400 }
        );
      }
    }

    const raw = await aiComplete(
      quizMessages({
        title: sourceTitle,
        context,
        mcqCount: askMcq,
        shortCount: askShort,
        difficulty,
        focus: focus || undefined,
        avoid: avoidList || undefined,
      }),
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
        validMcqs.push({ prompt, ...shuffleMcqOptions(opts, idx), explanation });
      } else {
        const answer = String(q.answer ?? "").trim();
        if (!answer) continue;
        validShorts.push({ prompt, answer, explanation });
      }
    }
    if (validMcqs.length + validShorts.length === 0) {
      throw new Error("Model returned no usable questions — please try again");
    }

    // drop anything the student has already been asked (exact or near-duplicate)
    const mcqDedup = dedupeAgainst(validMcqs, (q) => q.prompt, priorPrompts, 0.72);
    const shortDedup = dedupeAgainst(validShorts, (q) => q.prompt, priorPrompts, 0.72);
    const candidates = [...mcqDedup.fresh, ...shortDedup.fresh];
    const duplicatesRemoved = mcqDedup.duplicatesRemoved + shortDedup.duplicatesRemoved;

    // enforce the requested mcq/short split; cross-fill from the surplus type on shortfall
    let pickedMcq = candidates.filter((q) => "answerIndex" in q).slice(0, mcqCount) as typeof validMcqs;
    let pickedShort = candidates.filter((q) => "answer" in q).slice(0, shortCount) as typeof validShorts;
    if (pickedMcq.length < mcqCount) {
      const extra = candidates.filter((q) => "answer" in q) as typeof validShorts;
      pickedShort = extra.slice(0, Math.min(extra.length, count - pickedMcq.length));
    } else if (pickedShort.length < shortCount) {
      const extra = candidates.filter((q) => "answerIndex" in q) as typeof validMcqs;
      pickedMcq = extra.slice(0, Math.min(extra.length, count - pickedShort.length));
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
      "INSERT INTO quizzes (id, document_id, library_id, title, difficulty, selection_revision) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertQ = db.prepare(
      "INSERT INTO questions (quiz_id, ord, type, prompt, options, answer, explanation, source_pages) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    db.transaction(() => {
      insertQuiz.run(
        quizId,
        body.documentId ?? null,
        body.libraryId ?? null,
        body.weak
          ? `Weak-spot practice — ${sourceTitle}`
          : parsed.title?.slice(0, 200) || `${sourceTitle} quiz`,
        difficulty,
        body.documentId
          ? currentRevision(body.documentId)
          : maxLibraryRevision(body.libraryId!)
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
          q.explanation,
          sourcePages || null
        );
      });
    })();

    return NextResponse.json({
      quizId,
      questionCount: ordered.length,
      mcqCount: pickedMcq.length,
      shortCount: pickedShort.length,
      duplicatesRemoved,
      sourcePages: sourcePages || null,
      pagesUsed: built.sources.length,
      pagesIncluded: built.includedPages,
      truncated: built.truncated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
