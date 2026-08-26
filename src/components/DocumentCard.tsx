"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { DocMeta } from "@/lib/types";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentCard({
  doc,
  onUnlink,
}: {
  doc: DocMeta;
  onUnlink?: () => void;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    if (!window.confirm(`Delete "${doc.title}" and all its quizzes, cards and chats?`)) return;
    setDeleting(true);
    await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
    setDeleting(false);
    router.refresh();
  }

  const isPaper = doc.kind === "past_paper";
  return (
    <div className="group relative rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 transition hover:border-indigo-600/60">
      <Link href={`/docs/${doc.id}`} className="block">
        <span
          className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
            isPaper ? "bg-amber-950 text-amber-300" : "bg-indigo-950 text-indigo-300"
          }`}
        >
          {isPaper ? "Past paper" : "Notes"}
        </span>
        <h3 className="mt-3 line-clamp-2 font-semibold leading-snug">{doc.title}</h3>
        <p className="mt-1.5 truncate text-xs text-zinc-500">
          {doc.filename} · {fmtSize(doc.size)}
          {doc.pages ? ` · ${doc.pages} pages` : ""}
        </p>
        <p className="mt-1 text-[11px] text-zinc-600">
          Added {doc.created_at.slice(0, 10)}
        </p>
        <p className="mt-3 line-clamp-1 text-sm text-indigo-400/90 group-hover:text-indigo-300">
          {isPaper ? "Write reference answers →" : "Study, quiz & flashcards →"}
        </p>
      </Link>
      <div className="absolute right-3 top-3 flex gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
        {onUnlink && (
          <button
            onClick={onUnlink}
            className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-400 transition hover:text-white"
          >
            Move out
          </button>
        )}
        <button
          onClick={remove}
          disabled={deleting}
          className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-400 transition hover:bg-red-900/60 hover:text-red-200"
        >
          {deleting ? "…" : "Delete"}
        </button>
      </div>
    </div>
  );
}
