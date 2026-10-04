"use client";

import ChatPanel from "@/components/ChatPanel";
import QuizPanel from "@/components/QuizPanel";
import FlashcardsPanel from "@/components/FlashcardsPanel";
import PaperPanel from "@/components/PaperPanel";
import PageSelector from "@/components/PageSelector";
import { useState } from "react";
import type { DocMeta } from "@/lib/types";

type Tab = "learn" | "quiz" | "cards" | "paper";

export default function DocWorkspace({ doc }: { doc: DocMeta }) {
  const tabs: { id: Tab; label: string }[] =
    doc.kind === "past_paper"
      ? [
          { id: "learn", label: "Ask the tutor" },
          { id: "paper", label: "Reference answers" },
        ]
      : [
          { id: "learn", label: "Learn with AI" },
          { id: "quiz", label: "Quizzes" },
          { id: "cards", label: "Flashcards" },
        ];
  const [tab, setTab] = useState<Tab>("learn");
  const [revision, setRevision] = useState<number | null>(null);
  const pageModel = doc.page_model === "paginated" ? "paginated" : "sectioned";

  return (
    <div>
      <div className="mb-5 flex gap-1 rounded-xl border border-zinc-800 bg-zinc-900/50 p-1 text-sm">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-lg px-4 py-2 font-medium transition ${
              tab === t.id ? "bg-indigo-600 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <PageSelector
        key={`${doc.id}-${revision ?? 0}`}
        documentId={doc.id}
        pageModel={pageModel}
        onSelectionChanged={(rev) => setRevision(rev)}
        staleWarning={
          revision !== null ? (
            <p className="mx-4 mb-3 rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
              You changed your page selection (revision {revision}). Quizzes, flashcards and exams
              generated before this change are based on an older selection — regenerate them to use
              your new pages.
            </p>
          ) : null
        }
      />

      {tab === "learn" && <ChatPanel documentId={doc.id} />}
      {tab === "quiz" && <QuizPanel documentId={doc.id} />}
      {tab === "cards" && <FlashcardsPanel documentId={doc.id} title={doc.title} />}
      {tab === "paper" && <PaperPanel documentId={doc.id} title={doc.title} />}
    </div>
  );
}