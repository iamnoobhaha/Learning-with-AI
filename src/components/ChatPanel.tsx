"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import type { ChatMsg } from "@/lib/types";

const SUGGESTIONS = [
  "Summarise the key ideas of this document",
  "Explain the hardest concept in simple terms",
  "Give me 5 likely exam questions from this",
];

export default function ChatPanel({
  documentId,
  libraryId,
  scopeName,
}: {
  documentId?: string;
  libraryId?: string;
  scopeName?: string;
}) {
  const scopeParam = documentId
    ? `documentId=${documentId}`
    : `libraryId=${libraryId}`;
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToEnd = useCallback((smooth = false) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/chat?${scopeParam}`);
        const data = (await res.json()) as { messages?: ChatMsg[] };
        if (!cancelled) setMessages(data.messages ?? []);
      } catch {
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeParam]);

  useEffect(() => {
    scrollToEnd(messages.length > 0 && streaming);
  }, [messages, streaming, scrollToEnd]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || streaming) return;
    setInput("");
    setError("");
    setMessages((prev) => [...prev, { role: "user", content: message }, { role: "assistant", content: "" }]);
    setStreaming(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, libraryId, message }),
      });
      if (!res.ok || !res.body) {
        throw new Error((await res.text()) || "Request failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          try {
            const payload = JSON.parse(line.slice(5).trim()) as { content?: string };
            if (payload.content) {
              const token = payload.content;
              setMessages((prev) => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  role: "assistant",
                  content: copy[copy.length - 1].content + token,
                };
                return copy;
              });
            }
          } catch {
            // skip malformed line
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat failed");
      setMessages((prev) => prev.filter((m, i) => !(i === prev.length - 1 && !m.content)));
    } finally {
      setStreaming(false);
    }
  }

  async function clearChat() {
    if (messages.length === 0 || streaming) return;
    if (!window.confirm("Clear this conversation permanently?")) return;
    await fetch(`/api/chat?${scopeParam}`, { method: "DELETE" });
    setMessages([]);
    setError("");
  }

  const placeholder = libraryId
    ? `Ask about anything across ${scopeName || "this course"}…`
    : "Ask about your notes…";

  return (
    <div className="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900/50">
      <div ref={scrollRef} className="h-[60vh] space-y-4 overflow-y-auto p-5">
        {!loaded ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Loading conversation…
          </div>
        ) : (
          <>
            {messages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <p className="text-lg font-medium">Your AI tutor is ready</p>
                <p className="max-w-md text-sm text-zinc-500">
                  {libraryId
                    ? "It reads every document in this course and teaches from them — ask anything across all your notes."
                    : "It reads your uploaded notes and teaches from them — ask anything about this document. Conversations are saved automatically."}
                </p>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => void send(s)}
                      className="rounded-full border border-zinc-700 px-3.5 py-1.5 text-sm text-zinc-300 transition hover:border-indigo-500 hover:text-white"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5 text-sm">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex justify-start">
                  <div className="prose-invert max-w-[85%] text-sm text-zinc-200">
                    {m.content ? (
                      <Markdown text={m.content} />
                    ) : (
                      <span className="inline-flex gap-1 py-2">
                        {[0, 1, 2].map((d) => (
                          <span
                            key={d}
                            className="h-2 w-2 animate-bounce rounded-full bg-zinc-600"
                            style={{ animationDelay: `${d * 0.15}s` }}
                          />
                        ))}
                      </span>
                    )}
                  </div>
                </div>
              )
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-center justify-between border-t border-zinc-800 px-4 pt-2 text-xs text-zinc-600">
        <span>
          {messages.length > 0
            ? `${messages.filter((m) => m.role === "user").length} questions asked · saved to this document`
            : "New conversation"}
        </span>
        <button
          onClick={() => void clearChat()}
          disabled={messages.length === 0 || streaming}
          className="rounded-md px-2 py-1 transition hover:bg-zinc-800 hover:text-red-300 disabled:pointer-events-none disabled:opacity-0"
        >
          Clear conversation
        </button>
      </div>

      {error && <p className="mx-5 mb-2 mt-2 rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="flex gap-2 p-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          disabled={streaming}
          className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm outline-none transition placeholder:text-zinc-600 focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={streaming || !input.trim()}
          className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium transition hover:bg-indigo-500 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
