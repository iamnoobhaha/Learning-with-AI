import db from "@/lib/db";
import {
  buildContext,
  documentScopeName,
  libraryScopeName,
  NoIncludedContentError,
  summariseSources,
} from "@/lib/ai-context";
import { tutorMessages } from "@/lib/prompts";
import { aiStream, type AiMessage } from "@/lib/ai";
import type { ChatMsg } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function sse(gen: AsyncGenerator<string>) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async pull(controller) {
        const { done, value } = await gen.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: value })}\n\n`));
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    }
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const documentId = url.searchParams.get("documentId");
  const libraryId = url.searchParams.get("libraryId");
  if (!documentId && !libraryId) return new Response("scope required", { status: 400 });
  const messages = (
    documentId
      ? db
          .prepare(
            "SELECT role, content FROM chat_messages WHERE document_id = ? ORDER BY id ASC LIMIT 200"
          )
          .all(documentId)
      : db
          .prepare(
            "SELECT role, content FROM chat_messages WHERE library_id = ? ORDER BY id ASC LIMIT 200"
          )
          .all(libraryId)
  ) as ChatMsg[];
  return Response.json({ messages });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const documentId = url.searchParams.get("documentId");
  const libraryId = url.searchParams.get("libraryId");
  if (!documentId && !libraryId) return new Response("scope required", { status: 400 });
  if (documentId) {
    db.prepare("DELETE FROM chat_messages WHERE document_id = ?").run(documentId);
  } else {
    db.prepare("DELETE FROM chat_messages WHERE library_id = ?").run(libraryId);
  }
  return Response.json({ ok: true });
}

export async function POST(req: Request) {
  if (!process.env.NVIDIA_NIM_API_KEY) {
    return new Response(
      "NVIDIA_NIM_API_KEY is not set. Copy .env.example to .env and add your key from https://build.nvidia.com",
      { status: 500 }
    );
  }
  try {
    const { documentId, libraryId, message } = (await req.json()) as {
      documentId?: string;
      libraryId?: string;
      message: string;
    };
    if ((!documentId && !libraryId) || (documentId && libraryId)) {
      return new Response("Provide exactly one of documentId or libraryId", { status: 400 });
    }
    if (!message?.trim()) {
      return new Response("Bad request", { status: 400 });
    }

    // Query-aware retrieval through the single context service: it can only see
    // pages the user has included, and it refuses when nothing is selected.
    let title: string;
    let context: string;
    let citations: string;
    try {
      const built = buildContext({
        documentId,
        libraryId,
        query: message.trim(),
        maxChars: 22000,
        coverage: false,
        scopeName: documentId ? documentScopeName(documentId) : libraryScopeName(libraryId!),
      });
      title = documentId
        ? documentScopeName(documentId).replace(/"/g, "")
        : libraryScopeName(libraryId!).replace(/"/g, "");
      context = built.text;
      citations = summariseSources(built.sources);
    } catch (err) {
      if (err instanceof NoIncludedContentError) {
        return new Response(err.message, { status: 400 });
      }
      if (err instanceof Error && /not found/i.test(err.message)) {
        return new Response(err.message, { status: 404 });
      }
      return new Response("Could not read the selected pages", { status: 400 });
    }

    const trimmed = message.trim().slice(0, 4000);
    if (documentId) {
      db.prepare(
        "INSERT INTO chat_messages (document_id, role, content) VALUES (?, 'user', ?)"
      ).run(documentId, trimmed);
    } else {
      db.prepare(
        "INSERT INTO chat_messages (library_id, role, content) VALUES (?, 'user', ?)"
      ).run(libraryId, trimmed);
    }

    const history = (
      documentId
        ? db
            .prepare(
              "SELECT role, content FROM chat_messages WHERE document_id = ? ORDER BY id DESC LIMIT 10"
            )
            .all(documentId)
        : db
            .prepare(
              "SELECT role, content FROM chat_messages WHERE library_id = ? ORDER BY id DESC LIMIT 10"
            )
            .all(libraryId)
    ).reverse() as ChatMsg[];

    const messages: AiMessage[] = tutorMessages({
      title,
      context,
      history,
      message: trimmed,
    });

    // Provenance for this answer, appended as a short footer so the student can
    // see which included pages supported it.
    const sourceFooter = citations ? `\n\n_Sources: ${citations}_` : "";

    let full = "";
    async function* capped(): AsyncGenerator<string> {
      try {
        for await (const token of aiStream(messages, { temperature: 0.5, maxTokens: 2048 })) {
          full += token;
          yield token;
        }
        if (sourceFooter) yield sourceFooter;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "stream failed";
        yield `\n\n**[AI error] ${msg}**`;
      }
      if (full) {
        if (documentId) {
          db.prepare(
            "INSERT INTO chat_messages (document_id, role, content) VALUES (?, 'assistant', ?)"
          ).run(documentId, full);
        } else {
          db.prepare(
            "INSERT INTO chat_messages (library_id, role, content) VALUES (?, 'assistant', ?)"
          ).run(libraryId, full);
        }
      }
    }

    return sse(capped());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chat failed";
    return new Response(message, { status: 500 });
  }
}
