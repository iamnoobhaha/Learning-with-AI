import db from "@/lib/db";
import { docContext, libraryContext } from "@/lib/context";
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

    let title: string;
    let context: string;
    if (documentId) {
      const doc = db
        .prepare("SELECT id, title FROM documents WHERE id = ?")
        .get(documentId) as { id: string; title: string } | undefined;
      if (!doc) return new Response("Document not found", { status: 404 });
      title = doc.title;
      context = docContext(doc.id, message.trim());
    } else {
      const lib = db
        .prepare("SELECT id, name FROM libraries WHERE id = ?")
        .get(libraryId!) as { id: string; name: string } | undefined;
      if (!lib) return new Response("Library not found", { status: 404 });
      const nDocs = (
        db.prepare("SELECT COUNT(*) AS n FROM documents WHERE library_id = ?").get(lib.id) as {
          n: number;
        }
      ).n;
      title = `${lib.name} — all ${Number(nDocs)} document(s)`;
      context = libraryContext(lib.id, message.trim());
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

    let full = "";
    async function* capped(): AsyncGenerator<string> {
      try {
        for await (const token of aiStream(messages, { temperature: 0.5, maxTokens: 2048 })) {
          full += token;
          yield token;
        }
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
