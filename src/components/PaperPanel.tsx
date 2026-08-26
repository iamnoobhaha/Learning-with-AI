"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ExamListItem } from "@/lib/types";

export default function PaperPanel({ documentId, title }: { documentId: string; title: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answersList, setAnswersList] = useState<ExamListItem[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/exam?documentId=${documentId}&kind=answers`);
    const data = (await res.json()) as { exams?: ExamListItem[] };
    setAnswersList((data.exams ?? []).filter((e) => e.kind === "answers"));
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/exam/answers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId }),
      });
      const data = (await res.json()) as { examId?: string; error?: string };
      if (!res.ok || !data.examId) throw new Error(data.error || "Generation failed");
      window.location.href = `/exams/${data.examId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="text-lg font-semibold">Reference answers for this paper</h2>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          The AI reads <span className="text-zinc-300">{title}</span>, identifies every question in
          order and writes full mark-scheme style model answers with mark allocations — like your
          school&apos;s official answer key.
        </p>
        <button
          onClick={generate}
          disabled={busy}
          className="mt-5 rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? "Reading the paper & writing answers… (this can take a minute)" : "Generate reference answers"}
        </button>
        {error && (
          <p className="mt-3 rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>
        )}
      </div>

      {answersList.length > 0 && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
          <h3 className="font-semibold">Saved answer sets</h3>
          <ul className="mt-3 divide-y divide-zinc-800">
            {answersList.map((e) => (
              <li key={e.id} className="flex items-center justify-between py-2.5">
                <div>
                  <p className="font-medium">{e.title}</p>
                  <p className="text-xs text-zinc-500">{e.createdAt.slice(0, 16).replace("T", " ")}</p>
                </div>
                <Link
                  href={`/exams/${e.id}`}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm transition hover:border-indigo-500"
                >
                  View
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
