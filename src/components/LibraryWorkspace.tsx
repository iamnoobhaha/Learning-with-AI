"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Uploader from "@/components/Uploader";
import DocumentCard from "@/components/DocumentCard";
import ChatPanel from "@/components/ChatPanel";
import QuizPanel from "@/components/QuizPanel";
import FlashcardsPanel from "@/components/FlashcardsPanel";
import PageSelector from "@/components/PageSelector";
import type { DocMeta } from "@/lib/types";

type Tab = "docs" | "content" | "tutor" | "quiz" | "cards";

export default function LibraryWorkspace({
  libraryId,
  name,
  docs,
}: {
  libraryId: string;
  name: string;
  docs: DocMeta[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("docs");

  async function unlink(doc: DocMeta) {
    if (
      !window.confirm(`Move "${doc.title}" out of ${name} and back to your main library?`)
    ) {
      return;
    }
    await fetch(`/api/documents/${doc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryId: null }),
    });
    router.refresh();
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "docs", label: `Documents (${docs.length})` },
    { id: "content", label: "Content" },
    { id: "tutor", label: "Tutor (all notes)" },
    { id: "quiz", label: "Quizzes" },
    { id: "cards", label: "Flashcards" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex gap-1 rounded-xl border border-zinc-800 bg-zinc-900/50 p-1 text-sm">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-lg px-4 py-2 font-medium transition ${
              tab === t.id
                ? "bg-violet-600 text-white"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "docs" && (
        <div className="space-y-6">
          <Uploader fixedLibraryId={libraryId} fixedLibraryName={name} />
          {docs.length ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {docs.map((d) => (
                <DocumentCard key={d.id} doc={d} onUnlink={() => void unlink(d)} />
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
              No documents in this course yet — drop your notes and past papers above. The tutor,
              quizzes and flashcards will draw on all of them together.
            </p>
          )}
        </div>
      )}
      {tab === "content" && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-500">
            Choose which pages the AI may study. Excluded pages are skipped by the tutor, quiz
            generator and flashcard generator for this whole course.
          </p>
          {docs.length ? (
            docs.map((d) => (
              <div key={d.id}>
                <p className="mb-1.5 text-sm font-medium text-zinc-300">
                  <Link href={`/docs/${d.id}`} className="hover:text-indigo-300">
                    {d.title}
                  </Link>
                </p>
                <PageSelector
                  documentId={d.id}
                  pageModel={d.page_model === "paginated" ? "paginated" : "sectioned"}
                />
              </div>
            ))
          ) : (
            <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
              Upload documents first to choose which pages to include.
            </p>
          )}
        </div>
      )}
      {tab === "tutor" && <ChatPanel libraryId={libraryId} scopeName={`${name} — all documents`} />}
      {tab === "quiz" && <QuizPanel libraryId={libraryId} />}
      {tab === "cards" && <FlashcardsPanel libraryId={libraryId} title={name} />}
    </div>
  );
}
