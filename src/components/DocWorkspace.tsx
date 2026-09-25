"use client";

import { useState } from "react";
import ChatPanel from "@/components/ChatPanel";
import QuizPanel from "@/components/QuizPanel";
import FlashcardsPanel from "@/components/FlashcardsPanel";
import PaperPanel from "@/components/PaperPanel";
import SectionSelector from "@/components/SectionSelector";
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
  const [refreshKey, setRefreshKey] = useState(0);

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

      {doc.kind === "notes" && (
        <SectionSelector
          key={refreshKey}
          documentId={doc.id}
          onChange={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {tab === "learn" && <ChatPanel documentId={doc.id} />}
      {tab === "quiz" && <QuizPanel documentId={doc.id} />}
      {tab === "cards" && <FlashcardsPanel documentId={doc.id} title={doc.title} />}
      {tab === "paper" && <PaperPanel documentId={doc.id} title={doc.title} />}
    </div>
  );
}
