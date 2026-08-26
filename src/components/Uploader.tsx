"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface UploadState {
  name: string;
  status: "uploading" | "done" | "error";
  message?: string;
}

export default function Uploader({
  fixedLibraryId,
  fixedLibraryName,
}: {
  fixedLibraryId?: string;
  fixedLibraryName?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<"notes" | "past_paper">("notes");
  const [dragging, setDragging] = useState(false);
  const [jobs, setJobs] = useState<UploadState[]>([]);
  const [busyCount, setBusyCount] = useState(0);
  const [library, setLibrary] = useState("");
  const [existingNames, setExistingNames] = useState<string[]>([]);

  useEffect(() => {
    if (fixedLibraryId) return;
    (async () => {
      try {
        const res = await fetch("/api/libraries");
        const data = (await res.json()) as { libraries?: { name: string }[] };
        setExistingNames((data.libraries ?? []).map((l) => l.name));
      } catch {
        // suggestions are optional
      }
    })();
  }, [fixedLibraryId]);

  function update(name: string, patch: Partial<UploadState>) {
    setJobs((prev) => prev.map((j) => (j.name === name ? { ...j, ...patch } : j)));
  }

  async function upload(file: File) {
    setJobs((prev) => [
      ...prev.filter((j) => j.name !== file.name),
      { name: file.name, status: "uploading" },
    ]);
    setBusyCount((n) => n + 1);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      if (fixedLibraryId) {
        form.append("libraryId", fixedLibraryId);
      } else if (library.trim()) {
        form.append("libraryName", library.trim());
      }
      const res = await fetch("/api/documents", { method: "POST", body: form });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Upload failed");
      update(file.name, { status: "done" });
      router.refresh();
    } catch (err) {
      update(file.name, {
        status: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    } finally {
      setBusyCount((n) => Math.max(0, n - 1));
    }
  }

  async function uploadMany(files: FileList | null) {
    if (!files?.length) return;
    await Promise.all(Array.from(files).map((f) => upload(f)));
  }

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex rounded-xl border border-zinc-700 p-1 text-sm">
          {(
            [
              ["notes", "Lecture notes"],
              ["past_paper", "Past paper"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setKind(value)}
              className={`rounded-lg px-3 py-1.5 transition ${
                kind === value ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {!fixedLibraryId ? (
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <input
              value={library}
              onChange={(e) => setLibrary(e.target.value)}
              list="sf-library-names"
              placeholder="Course / library (optional)"
              className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none transition placeholder:text-zinc-600 focus:border-indigo-500"
            />
            <datalist id="sf-library-names">
              {existingNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>
        ) : (
          <span className="rounded-full bg-indigo-950 px-3 py-1 text-xs font-semibold text-indigo-300">
            Adding to {fixedLibraryName}
          </span>
        )}
        <span className="text-xs text-zinc-500">
          PDF, Word (.doc/.docx), PowerPoint (.pptx), Excel (.xlsx/.xls), TXT, MD · several at once
        </span>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void uploadMany(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
          dragging ? "border-indigo-500 bg-indigo-950/30" : "border-zinc-700 hover:border-zinc-500"
        }`}
      >
        <p className="font-medium">
          {busyCount > 0
            ? `Uploading & extracting ${busyCount} file${busyCount === 1 ? "" : "s"}…`
            : `Drop ${kind === "notes" ? "lecture notes" : "a past paper"} here, or click to browse`}
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          {library.trim() && !fixedLibraryId
            ? `New uploads will join the "${library.trim()}" course`
            : "Your files are parsed locally into a searchable study library"}
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.txt,.md,.markdown,.csv,.doc,.docx,.pptx,.xlsx,.xls,application/pdf"
        hidden
        onChange={(e) => {
          void uploadMany(e.target.files);
          e.target.value = "";
        }}
      />

      {jobs.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {jobs.slice(-5).map((j) => (
            <li
              key={j.name}
              className="flex items-center justify-between gap-3 rounded-lg bg-zinc-900 px-3 py-2 text-sm"
            >
              <span className="truncate text-zinc-300">{j.name}</span>
              <span
                className={
                  j.status === "done"
                    ? "text-emerald-400"
                    : j.status === "error"
                      ? "text-red-400"
                      : "animate-pulse text-indigo-300"
                }
              >
                {j.status === "done"
                  ? "Added"
                  : j.status === "error"
                    ? j.message || "Failed"
                    : "Processing…"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
