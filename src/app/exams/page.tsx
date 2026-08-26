"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DocMeta, ExamListItem, LibraryMeta } from "@/lib/types";

export default function ExamLabPage() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [libraries, setLibraries] = useState<LibraryMeta[]>([]);
  const [exams, setExams] = useState<ExamListItem[]>([]);
  const [source, setSource] = useState("");
  const [sampleDocId, setSampleDocId] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [dRes, eRes, lRes] = await Promise.all([
      fetch("/api/documents"),
      fetch("/api/exam"),
      fetch("/api/libraries"),
    ]);
    const dData = (await dRes.json()) as { documents?: DocMeta[] };
    const eData = (await eRes.json()) as { exams?: ExamListItem[] };
    const lData = (await lRes.json()) as { libraries?: LibraryMeta[] };
    setDocs(dData.documents ?? []);
    setExams(eData.exams ?? []);
    setLibraries(lData.libraries ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const papers = docs.filter((d) => d.kind === "past_paper");
  const notesSources =
    docs.filter((d) => d.kind === "notes").length + libraries.filter((l) => l.notesCount > 0).length;

  async function generateMock() {
    if (!source || !sampleDocId) return;
    setBusy(true);
    setError("");
    try {
      const isLibrary = source.startsWith("lib:");
      const bodyPayload = {
        sourceDocId: isLibrary ? undefined : source,
        sourceLibraryId: isLibrary ? source.slice(4) : undefined,
        sampleDocId,
        topic,
      };
      const res = await fetch("/api/exam/mock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });
      const data = (await res.json()) as { examId?: string; error?: string };
      if (!res.ok || !data.examId) throw new Error(data.error || "Generation failed");
      router.push(`/exams/${data.examId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
      setBusy(false);
    }
  }

  async function removeExam(id: string) {
    await fetch(`/api/exam/${id}`, { method: "DELETE" });
    void load();
  }

  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-3xl font-bold tracking-tight">Exam Lab</h1>
        <p className="mt-2 max-w-2xl text-zinc-400">
          Pick a past paper as your style template, pick the notes to be examined on — a single
          document or an entire course library — and the AI writes a brand-new mock exam that
          mirrors the real thing.
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="font-semibold">Create a mock exam</h2>
        {notesSources === 0 || papers.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">
            You need at least one{" "}
            <Link href="/" className="text-indigo-400 hover:underline">
              lecture notes source
            </Link>{" "}
            and one{" "}
            <Link href="/" className="text-indigo-400 hover:underline">
              past paper
            </Link>{" "}
            uploaded. Missing:{" "}
            {[notesSources === 0 && "lecture notes", papers.length === 0 && "past paper"]
              .filter(Boolean)
              .join(" and ")}
            .
          </div>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1.5 block text-zinc-400">Exam me on these notes</span>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2.5 outline-none focus:border-indigo-500"
              >
                <option value="">Select notes…</option>
                {libraries.filter((l) => l.notesCount > 0).length > 0 && (
                  <optgroup label="Course libraries (all notes)">
                    {libraries
                      .filter((l) => l.notesCount > 0)
                      .map((l) => (
                        <option key={l.id} value={`lib:${l.id}`}>
                          {l.name} — {l.docCount} document{l.docCount === 1 ? "" : "s"}
                        </option>
                      ))}
                  </optgroup>
                )}
                {docs.some((d) => d.kind === "notes") && (
                  <optgroup label="Single documents">
                    {docs
                      .filter((d) => d.kind === "notes")
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.title}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1.5 block text-zinc-400">Copy the style of this past paper</span>
              <select
                value={sampleDocId}
                onChange={(e) => setSampleDocId(e.target.value)}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2.5 outline-none focus:border-indigo-500"
              >
                <option value="">Select past paper…</option>
                {papers.map((d) => (
                  <option key={d.id} value={d.id}>{d.title}</option>
                ))}
              </select>
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="mb-1.5 block text-zinc-400">Focus topic (optional)</span>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. Chapters 1–3, or 'photosynthesis'"
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2.5 outline-none placeholder:text-zinc-600 focus:border-indigo-500"
              />
            </label>
          </div>
        )}
        {notesSources > 0 && papers.length > 0 && (
          <button
            onClick={generateMock}
            disabled={busy || !source || !sampleDocId}
            className="mt-5 rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? "Writing your mock exam… (1–2 minutes)" : "Generate mock exam"}
          </button>
        )}
        {error && (
          <p className="mt-3 rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>
        )}
      </section>

      {exams.length > 0 && (
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
          <h2 className="font-semibold">Generated exams & answer sets</h2>
          <ul className="mt-3 divide-y divide-zinc-800">
            {exams.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div>
                  <Link href={`/exams/${e.id}`} className="font-medium hover:text-indigo-300">
                    {e.title}
                  </Link>
                  <p className="text-xs text-zinc-500">
                    <span
                      className={`mr-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        e.kind === "mock" ? "bg-emerald-950 text-emerald-300" : "bg-sky-950 text-sky-300"
                      }`}
                    >
                      {e.kind === "mock" ? "Mock exam" : "Reference answers"}
                    </span>
                    {e.createdAt.slice(0, 16).replace("T", " ")}
                    {e.sampleTitle ? ` · sample: ${e.sampleTitle}` : ""}
                  </p>
                </div>
                <button
                  onClick={() => void removeExam(e.id)}
                  className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition hover:bg-red-900/60 hover:text-red-200"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
