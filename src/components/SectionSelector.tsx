"use client";

import { useCallback, useEffect, useState } from "react";

interface Block {
  index: number;
  label: string;
  preview: string;
  chars: number;
  included: boolean;
}

interface BlocksPayload {
  blocks: Block[];
  totalChars: number;
  allChars: number;
  pages: number | null;
}

export default function SectionSelector({
  documentId,
  onChange,
}: {
  documentId: string;
  onChange?: () => void;
}) {
  const [data, setData] = useState<BlocksPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/documents/${documentId}`);
    if (!res.ok) return;
    setData((await res.json()) as BlocksPayload);
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(index: number, included: boolean) {
    if (!data) return;
    setData({
      ...data,
      blocks: data.blocks.map((b) => (b.index === index ? { ...b, included } : b)),
    });
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/documents/${documentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockIndex: index, included }),
      });
      if (!res.ok) throw new Error("Could not save");
      onChange?.();
    } catch {
      setError("Could not save — reloading");
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function setAll(included: boolean) {
    if (!data) return;
    setData({ ...data, blocks: data.blocks.map((b) => ({ ...b, included })) });
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/documents/${documentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allIncluded: included }),
      });
      if (!res.ok) throw new Error("Could not save");
      onChange?.();
    } catch {
      setError("Could not save — reloading");
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (!data || !data.blocks.length) return null;

  const includedCount = data.blocks.filter((b) => b.included).length;
  const pct = data.allChars ? Math.round((data.totalChars / data.allChars) * 100) : 100;

  return (
    <div className="mb-5 rounded-2xl border border-zinc-800 bg-zinc-900/50">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-200">
            Study content
            <span className="ml-2 text-xs font-normal text-zinc-500">
              {includedCount}/{data.blocks.length} sections · {pct}% of text used
            </span>
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Exclude schedules, admin pages and anything not worth quizzing.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saving && <span className="text-[10px] text-zinc-600">saving…</span>}
          <span className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300">
            {open ? "Hide" : "Edit"}
          </span>
        </div>
      </button>

      {open && (
        <div className="border-t border-zinc-800 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <button
              onClick={() => setAll(true)}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-zinc-300 transition hover:border-indigo-500"
            >
              Include all
            </button>
            <button
              onClick={() => setAll(false)}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-zinc-300 transition hover:border-indigo-500"
            >
              Exclude all
            </button>
            {includedCount === 0 && (
              <span className="text-amber-400">
                At least one section must stay included.
              </span>
            )}
            {error && <span className="text-red-400">{error}</span>}
          </div>

          <ul className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
            {data.blocks.map((b) => (
              <li key={b.index}>
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition ${
                    b.included
                      ? "border-zinc-700 bg-zinc-950/40"
                      : "border-zinc-800/70 bg-zinc-950/20 opacity-60"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={b.included}
                    onChange={(e) => void toggle(b.index, e.target.checked)}
                    className="mt-1 h-4 w-4 shrink-0 accent-indigo-600"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-medium text-zinc-200">
                        {b.label}
                      </span>
                      <span className="shrink-0 text-[10px] text-zinc-600">
                        {Math.max(1, Math.round(b.chars / 1000))}k chars
                      </span>
                    </span>
                    {b.preview && (
                      <span className="mt-0.5 block truncate text-xs text-zinc-500">
                        {b.preview}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
