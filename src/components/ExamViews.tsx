"use client";

import Link from "next/link";
import Markdown from "@/components/Markdown";
import type { AnswersContent, MockExamContent } from "@/lib/types";

export function MockExamView({ exam }: { exam: MockExamContent }) {
  return (
    <div className="print-sheet mx-auto max-w-3xl rounded-2xl border border-zinc-800 bg-white p-10 text-black">
      <div className="text-center">
        <h1 className="text-xl font-bold uppercase tracking-wide">{exam.title}</h1>
        <p className="mt-1 text-sm">
          Time allowed: {exam.duration_minutes} minutes · Total marks: {exam.total_marks}
        </p>
      </div>
      {exam.instructions && (
        <div className="mt-6 border-y border-black/20 py-4 text-sm leading-relaxed">
          <p className="font-semibold">Instructions</p>
          <Markdown text={exam.instructions} />
        </div>
      )}
      {exam.sections.map((section, si) => (
        <section key={si} className="mt-8">
          <h2 className="mb-3 text-base font-bold">{section.name}</h2>
          <ol className="space-y-5">
            {section.questions.map((q, qi) => (
              <li key={qi} className="leading-relaxed">
                <p className="flex justify-between gap-4">
                  <span>
                    <span className="font-semibold">{q.number}</span> {q.prompt}
                  </span>
                  <span className="shrink-0 font-medium">[{q.marks}]</span>
                </p>
                <div className="mt-2 h-6" />
              </li>
            ))}
          </ol>
        </section>
      ))}
      <p className="mt-10 text-center text-xs text-gray-500">— End of paper —</p>
    </div>
  );
}

export function AnswersView({ exam }: { exam: AnswersContent }) {
  return (
    <div className="print-sheet mx-auto max-w-3xl rounded-2xl border border-zinc-800 bg-white p-10 text-black">
      <div className="border-b border-black/30 pb-4 text-center">
        <h1 className="text-xl font-bold uppercase tracking-wide">{exam.paper_title}</h1>
        <p className="mt-1 text-sm">Reference answers / mark scheme</p>
      </div>
      <ol className="mt-6 space-y-6">
        {exam.answers.map((a, i) => (
          <li key={i} className="leading-relaxed">
            <p className="flex justify-between gap-4">
              <span>
                <span className="font-semibold">{a.number}</span>{" "}
                <span className="italic text-gray-700">{a.question}</span>
              </span>
              <span className="shrink-0 font-medium">[{a.marks}]</span>
            </p>
            <Markdown text={a.answer} />
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PrintButton() {
  return (
    <div className="no-print mb-4 flex items-center gap-2">
      <Link
        href="/exams"
        className="rounded-lg border border-zinc-700 px-3.5 py-2 text-sm transition hover:border-indigo-500"
      >
        ← Exam Lab
      </Link>
      <button
        onClick={() => window.print()}
        className="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium transition hover:bg-indigo-500"
      >
        Print / Save as PDF
      </button>
    </div>
  );
}
