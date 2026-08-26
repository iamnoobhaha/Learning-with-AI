"use client";

import { useMemo, useState } from "react";
import DocumentCard from "@/components/DocumentCard";
import type { DocMeta } from "@/lib/types";

type Filter = "all" | "notes" | "past_paper";

export default function LibraryBrowser({ docs }: { docs: DocMeta[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return docs.filter((d) => {
      if (filter !== "all" && d.kind !== filter) return false;
      if (!q) return true;
      return (
        d.title.toLowerCase().includes(q) || d.filename.toLowerCase().includes(q)
      );
    });
  }, [docs, filter, query]);

  const tabs: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: docs.length },
    { id: "notes", label: "Notes", n: docs.filter((d) => d.kind === "notes").length },
    { id: "past_paper", label: "Past papers", n: docs.filter((d) => d.kind === "past_paper").length },
  ];

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-xl border border-zinc-800 bg-zinc-900/50 p-1 text-sm">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setFilter(t.id)}
              className={`rounded-lg px-3.5 py-1.5 font-medium transition ${
                filter === t.id
                  ? "bg-indigo-600 text-white"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
              }`}
            >
              {t.label}
              <span className={`ml-1.5 text-xs ${filter === t.id ? "text-indigo-200" : "text-zinc-500"}`}>
                {t.n}
              </span>
            </button>
          ))}
        </div>
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <svg
            viewBox="0 0 24 24"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your library…"
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900 py-2 pl-9 pr-3 text-sm outline-none transition placeholder:text-zinc-600 focus:border-indigo-500"
          />
        </div>
      </div>

      {filtered.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((doc) => (
            <DocumentCard key={doc.id} doc={doc} />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
          {docs.length === 0
            ? "Nothing here yet — upload a document above to get started."
            : `No documents match "${query}".`}
        </p>
      )}
    </section>
  );
}
