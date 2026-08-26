"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import type { AttemptResult, QuizFull, QuizHistoryItemV2 } from "@/lib/types";

type Stage = "setup" | "generating" | "active" | "grading" | "result";

function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function QuizPanel({
  documentId,
  libraryId,
}: {
  documentId?: string;
  libraryId?: string;
}) {
  const scopeParam = documentId
    ? `documentId=${documentId}`
    : `libraryId=${libraryId}`;
  const [stage, setStage] = useState<Stage>("setup");
  const [error, setError] = useState("");
  const [count, setCount] = useState(8);
  const [difficulty, setDifficulty] = useState("medium");
  const [mcqRatio, setMcqRatio] = useState(0.7);
  const [history, setHistory] = useState<QuizHistoryItemV2[]>([]);
  const [quiz, setQuiz] = useState<QuizFull | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number>(0);

  const loadHistory = useCallback(async () => {
    const res = await fetch(`/api/quiz?${scopeParam}`);
    const data = (await res.json()) as { quizzes?: QuizHistoryItemV2[] };
    setHistory(data.quizzes ?? []);
  }, [scopeParam]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (stage !== "active") return;
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [stage]);

  function saveProgress(quizId: string, nextAnswers: Record<number, string>, startedAt: number) {
    try {
      localStorage.setItem(
        `sf-quiz-${quizId}`,
        JSON.stringify({ answers: nextAnswers, startedAt })
      );
    } catch {
      // storage unavailable — ignore
    }
  }

  async function generate() {
    setStage("generating");
    setError("");
    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, libraryId, count, difficulty, mcqRatio }),
      });
      const data = (await res.json()) as { quizId?: string; error?: string };
      if (!res.ok || !data.quizId) throw new Error(data.error || "Generation failed");
      await openQuiz(data.quizId, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
      setStage("setup");
    }
  }

  async function openQuiz(quizId: string, fresh: boolean) {
    setError("");
    try {
      const res = await fetch(`/api/quiz/${quizId}`);
      const data = (await res.json()) as { quiz?: QuizFull; error?: string };
      if (!res.ok || !data.quiz) throw new Error(data.error || "Could not load quiz");
      const q = data.quiz;
      setQuiz(q);
      let nextAnswers: Record<number, string> = {};
      let startedAt = Date.now();
      if (!fresh) {
        try {
          const saved = localStorage.getItem(`sf-quiz-${q.id}`);
          if (saved) {
            const parsed = JSON.parse(saved) as {
              answers: Record<number, string>;
              startedAt: number;
            };
            const savedIds = new Set(q.questions.map((x) => x.id));
            nextAnswers = Object.fromEntries(
              Object.entries(parsed.answers ?? {}).filter(([k]) => savedIds.has(Number(k)))
            );
            if (parsed.startedAt && Object.keys(nextAnswers).length > 0) {
              startedAt = Number(parsed.startedAt) || Date.now();
            }
          }
        } catch {
          // corrupted save — start fresh
        }
      } else {
        try {
          localStorage.removeItem(`sf-quiz-${q.id}`);
        } catch {}
      }
      setAnswers(nextAnswers);
      startedAtRef.current = startedAt;
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
      setResult(null);
      setStage("active");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    }
  }

  function updateAnswer(questionId: number, value: string) {
    if (!quiz) return;
    setAnswers((prev) => {
      const next = { ...prev, [questionId]: value };
      saveProgress(quiz.id, next, startedAtRef.current);
      return next;
    });
  }

  async function submit() {
    if (!quiz) return;
    const answeredCount = quiz.questions.filter((q) => answers[q.id]?.trim()).length;
    const missing = quiz.questions.length - answeredCount;
    if (missing > 0 && !window.confirm(`${missing} question(s) are blank. Submit anyway?`)) {
      return;
    }
    setStage("grading");
    setError("");
    try {
      const res = await fetch(`/api/quiz/${quiz.id}/attempt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: quiz.questions.map((q) => ({ questionId: q.id, value: answers[q.id] ?? "" })),
        }),
      });
      const data = (await res.json()) as AttemptResult & { error?: string };
      if (!res.ok) throw new Error(data.error || "Grading failed");
      try {
        localStorage.removeItem(`sf-quiz-${quiz.id}`);
      } catch {}
      setResult(data);
      setStage("result");
      void loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Grading failed");
      setStage("active");
    }
  }

  if (stage === "setup" || stage === "generating") {
    const taken = history.reduce((n, h) => n + h.attemptCount, 0);
    return (
      <div className="space-y-6">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
          <h2 className="text-lg font-semibold">Generate a quiz</h2>
          <p className="mt-1 text-sm text-zinc-500">
            The AI writes fresh questions{" "}
            {libraryId
              ? "drawn from every document in this course"
              : "from your notes"}
            . Short answers are marked by AI with feedback. Progress is auto-saved if you leave
            mid-quiz.
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <label className="text-sm">
              <span className="mb-1.5 block text-zinc-400">Questions</span>
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-indigo-500"
              >
                {[4, 6, 8, 10, 12, 15, 20].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1.5 block text-zinc-400">Difficulty</span>
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value)}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-indigo-500"
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1.5 block text-zinc-400">Multiple choice share</span>
              <select
                value={mcqRatio}
                onChange={(e) => setMcqRatio(Number(e.target.value))}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-indigo-500"
              >
                <option value={1}>All MCQ</option>
                <option value={0.75}>75% MCQ</option>
                <option value={0.5}>Half &amp; half</option>
                <option value={0}>All short answer</option>
              </select>
              <span className="mt-1 block text-xs text-zinc-600">Split is enforced exactly.</span>
            </label>
          </div>
          <button
            onClick={generate}
            disabled={stage === "generating"}
            className="mt-5 rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {stage === "generating" ? "Writing your quiz…" : "Generate quiz"}
          </button>
          {error && (
            <p className="mt-3 rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>
          )}
        </div>

        {history.length > 0 && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Your quizzes</h3>
              <span className="text-xs text-zinc-500">
                {history.length} quiz{history.length === 1 ? "" : "zes"} · {taken} attempt{taken === 1 ? "" : "s"}
              </span>
            </div>
            <ul className="mt-3 divide-y divide-zinc-800">
              {history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{h.title}</p>
                    <p className="text-xs text-zinc-500">
                      {h.questionCount} questions · {h.difficulty} ·{" "}
                      {h.createdAt.slice(0, 16).replace("T", " ")}
                      {h.attemptCount > 0 && ` · ${h.attemptCount} attempt${h.attemptCount === 1 ? "" : "s"}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {h.recentScores.length > 0 && (
                      <span
                        className="flex items-end gap-[3px]"
                        title={`Recent attempts: ${[...h.recentScores].reverse().join("%, ")}%`}
                      >
                        {[...h.recentScores].reverse().map((s, i) => (
                          <span
                            key={i}
                            className={`w-1.5 rounded-sm ${
                              s >= 80 ? "bg-emerald-500" : s >= 50 ? "bg-amber-500" : "bg-red-500"
                            }`}
                            style={{ height: `${Math.max(4, Math.round((s / 100) * 24))}px` }}
                          />
                        ))}
                      </span>
                    )}
                    {h.best !== null && (
                      <span
                        className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
                          h.best >= 80
                            ? "bg-emerald-950 text-emerald-300"
                            : h.best >= 50
                              ? "bg-amber-950 text-amber-300"
                              : "bg-red-950 text-red-300"
                        }`}
                      >
                        Best {Math.round(h.best)}%
                      </span>
                    )}
                    <button
                      onClick={() => void openQuiz(h.id, false)}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm transition hover:border-indigo-500"
                    >
                      {h.recentScores.length > 0 ? "Retake / resume" : "Start"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  if ((stage === "active" || stage === "grading") && quiz) {
    const answeredCount = quiz.questions.filter((q) => answers[q.id]?.trim()).length;
    return (
      <div className="space-y-4">
        <div className="sticky top-16 z-30 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/95 px-5 py-4 backdrop-blur">
          <div>
            <h2 className="font-semibold">{quiz.title}</h2>
            <p className="text-xs text-zinc-500">
              {answeredCount}/{quiz.questions.length} answered · {quiz.difficulty}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-sm tabular-nums text-zinc-300">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 3" strokeLinecap="round" />
              </svg>
              {fmtTime(elapsed)}
            </span>
            <button
              onClick={submit}
              disabled={stage === "grading"}
              className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {stage === "grading" ? "Marking with AI…" : "Submit for marking"}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
          {quiz.questions.map((q, qi) => {
            const done = Boolean(answers[q.id]?.trim());
            return (
              <a
                key={q.id}
                href={`#q-${q.id}`}
                title={`Question ${qi + 1}${done ? " — answered" : ""}`}
                className={`flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold transition ${
                  done
                    ? "bg-indigo-600 text-white hover:bg-indigo-500"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                }`}
              >
                {qi + 1}
              </a>
            );
          })}
          <span className="ml-auto self-center text-xs text-zinc-600">
            Progress is saved automatically on this device
          </span>
        </div>

        {quiz.questions.map((q, qi) => (
          <div key={q.id} id={`q-${q.id}`} className="scroll-mt-40 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
            <p className="flex gap-2 font-medium leading-relaxed">
              <span className="shrink-0 rounded-md bg-zinc-800 px-2 py-0.5 text-xs uppercase text-zinc-400">
                {q.type === "mcq" ? "MCQ" : "Short"}
              </span>
              <span>{`Q${qi + 1}. ${q.prompt}`}</span>
            </p>
            {q.type === "mcq" ? (
              <div className="mt-3 space-y-2">
                {q.options.map((opt, oi) => (
                  <label
                    key={oi}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-2.5 text-sm transition ${
                      answers[q.id] === String(oi)
                        ? "border-indigo-500 bg-indigo-950/40"
                        : "border-zinc-800 hover:border-zinc-600"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`q-${q.id}`}
                      checked={answers[q.id] === String(oi)}
                      onChange={() => updateAnswer(q.id, String(oi))}
                      className="accent-indigo-500"
                    />
                    <span className="font-mono text-xs text-zinc-500">{"ABCD"[oi]}</span>
                    {opt}
                  </label>
                ))}
              </div>
            ) : (
              <textarea
                value={answers[q.id] ?? ""}
                onChange={(e) => updateAnswer(q.id, e.target.value)}
                rows={4}
                placeholder="Type your answer…"
                className="mt-3 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm outline-none transition placeholder:text-zinc-600 focus:border-indigo-500"
              />
            )}
          </div>
        ))}

        {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}
        <button
          onClick={submit}
          disabled={stage === "grading"}
          className="w-full rounded-xl bg-indigo-600 py-3 font-medium transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {stage === "grading" ? "Marking with AI…" : `Submit (${answeredCount}/${quiz.questions.length} answered)`}
        </button>
      </div>
    );
  }

  if (stage === "result" && result && quiz) {
    const good = result.scorePct >= 80;
    const correctCount = result.details.filter((d) => d.correct === true).length;
    const partialCount = result.details.filter((d) => d.correct === null && (d.score ?? 0) > 0).length;
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
          <div className="flex items-center gap-5">
            <ScoreRing pct={result.scorePct} />
            <div>
              <p className="font-semibold">{good ? "Excellent work!" : result.scorePct >= 50 ? "Solid effort" : "Keep practising"}</p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {correctCount} fully correct · {partialCount} partial credit · finished in {fmtTime(elapsed)}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void openQuiz(quiz.id, true)}
              className="rounded-xl border border-zinc-700 px-5 py-2.5 text-sm transition hover:border-indigo-500"
            >
              Retake fresh
            </button>
            <button
              onClick={() => setStage("setup")}
              className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium transition hover:bg-indigo-500"
            >
              Back to quizzes
            </button>
          </div>
        </div>

        {quiz.questions.map((q, qi) => {
          const d = result.details.find((x) => x.questionId === q.id);
          const revealBits = [
            d?.modelAnswer
              ? `**${q.type === "mcq" ? "Correct answer" : "Model answer"}:** ${d.modelAnswer}`
              : "",
            d?.explanation || q.explanation || "",
          ]
            .filter(Boolean)
            .join("\n\n");
          return (
            <div key={q.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
              <p className="font-medium leading-relaxed">
                {`Q${qi + 1}. ${q.prompt}`}
              </p>
              {q.type === "mcq" && d && (
                <p className="mt-2 text-sm text-zinc-400">
                  Your answer:{" "}
                  <span className={d.correct ? "text-emerald-300" : "text-red-300"}>
                    {d.yourAnswer
                      ? d.correct
                        ? `${"ABCD"[Number(d.yourAnswer)]} — ${d.modelAnswer}`
                        : "ABCD"[Number(d.yourAnswer)]
                      : "(blank)"}
                  </span>
                  {!d.correct && (
                    <>
                      {" · "}Correct:{" "}
                      <span className="text-emerald-300">{d.modelAnswer}</span>
                    </>
                  )}
                </p>
              )}
              {q.type === "short" && d && (
                <div className="mt-2 space-y-1.5 text-sm">
                  <p className="text-zinc-400">
                    Your answer: <span className="whitespace-pre-wrap text-zinc-200">{d.yourAnswer || "(blank)"}</span>
                  </p>
                  <p>
                    Score:{" "}
                    <span className={d.score !== null && d.score >= 0.7 ? "text-emerald-300" : d.score !== null && d.score >= 0.4 ? "text-amber-300" : "text-red-300"}>
                      {d.score !== null ? Math.round(d.score * 100) : 0}%
                    </span>{" "}
                    — {d.feedback}
                  </p>
                </div>
              )}
              {revealBits && (
                <details className="group mt-3">
                  <summary className="cursor-pointer text-sm text-indigo-400 hover:text-indigo-300">
                    Show model answer / explanation
                  </summary>
                  <div className="mt-2 rounded-xl bg-zinc-950/60 p-4 text-sm text-zinc-300">
                    <Markdown text={revealBits} />
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return null;
}

function ScoreRing({ pct }: { pct: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const color = pct >= 80 ? "#34d399" : pct >= 50 ? "#fbbf24" : "#f87171";
  return (
    <div className="relative h-20 w-20 shrink-0">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="#27272a" strokeWidth="7" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(100, Math.max(0, pct)) / 100)}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center text-lg font-bold tabular-nums"
        style={{ color }}
      >
        {Math.round(pct)}
      </span>
    </div>
  );
}
