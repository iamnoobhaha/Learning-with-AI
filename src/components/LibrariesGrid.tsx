"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { LibraryMeta } from "@/lib/types";

export default function LibrariesGrid({ libraries }: { libraries: LibraryMeta[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await fetch("/api/libraries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      setName("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function rename(id: string) {
    if (!renameValue.trim()) return;
    await fetch(`/api/libraries/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: renameValue.trim() }),
    });
    setRenaming(null);
    router.refresh();
  }

  async function remove(lib: LibraryMeta) {
    const msg =
      lib.docCount > 0
        ? `Delete library "${lib.name}"? Its ${lib.docCount} document(s) will be moved back to your main library.`
        : `Delete empty library "${lib.name}"?`;
    if (!window.confirm(msg)) return;
    await fetch(`/api/libraries/${lib.id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">
          Courses <span className="ml-1 text-sm font-normal text-zinc-500">group notes &amp; past papers per subject</span>
        </h2>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
            placeholder="New course, e.g. ABC101"
            className="w-44 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none transition placeholder:text-zinc-600 focus:border-indigo-500 sm:w-56"
          />
          <button
            onClick={create}
            disabled={busy || !name.trim()}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium transition hover:bg-indigo-500 disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </div>

      {libraries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
          No courses yet — create one above, or just type its name while uploading to group files
          automatically.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {libraries.map((lib) =>
            renaming === lib.id ? (
              <div key={lib.id} className="rounded-2xl border border-indigo-600/60 bg-zinc-900/50 p-5">
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rename(lib.id);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => void rename(lib.id)}
                    className="flex-1 rounded-lg bg-indigo-600 py-1.5 text-sm font-medium hover:bg-indigo-500"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setRenaming(null)}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:text-white"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div
                key={lib.id}
                className="group relative rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 transition hover:border-violet-500/60"
              >
                <Link href={`/libraries/${lib.id}`} className="block">
                  <span className="inline-block rounded-full bg-violet-950 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">
                    Course
                  </span>
                  <h3 className="mt-3 line-clamp-2 font-semibold leading-snug">{lib.name}</h3>
                  <p className="mt-1.5 text-xs text-zinc-500">
                    {lib.notesCount} note{lib.notesCount === 1 ? "" : "s"} ·{" "}
                    {lib.papersCount} paper{lib.papersCount === 1 ? "" : "s"}
                  </p>
                  <p className="mt-3 line-clamp-1 text-sm text-violet-400/90 group-hover:text-violet-300">
                    Open course workspace →
                  </p>
                </Link>
                <div className="absolute right-3 top-3 flex gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    onClick={() => {
                      setRenaming(lib.id);
                      setRenameValue(lib.name);
                    }}
                    className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-400 transition hover:text-white"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => void remove(lib)}
                    className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-400 transition hover:bg-red-900/60 hover:text-red-200"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
}
