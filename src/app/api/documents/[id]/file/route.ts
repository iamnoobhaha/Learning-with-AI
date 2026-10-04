import { NextResponse } from "next/server";
import db from "@/lib/db";
import { readOriginal } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams the stored original so the browser can render page previews with
 * PDF.js. The file lives in data/files (never under public/), so this is the
 * only way to reach it. Range requests are honoured because PDF.js fetches
 * documents in chunks for large files.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const doc = db
    .prepare("SELECT original_path, original_mime, filename FROM documents WHERE id = ?")
    .get(id) as
    | { original_path: string | null; original_mime: string | null; filename: string }
    | undefined;

  if (!doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  if (!doc.original_path) {
    return NextResponse.json(
      {
        error:
          "The original file for this document is not available (it was uploaded before previews were introduced). Re-upload it to enable visual page previews.",
      },
      { status: 404 }
    );
  }

  const buf = readOriginal(doc.original_path);
  if (!buf) {
    return NextResponse.json(
      { error: "The stored file is missing. Re-upload the document to restore previews." },
      { status: 410 }
    );
  }

  const mime = doc.original_mime || "application/octet-stream";
  const range = req.headers.get("range");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : buf.length - 1;
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        end < buf.length &&
        start <= end
      ) {
        const slice = buf.subarray(start, end + 1);
        return new NextResponse(new Uint8Array(slice), {
          status: 206,
          headers: {
            "Content-Type": mime,
            "Content-Length": String(slice.length),
            "Content-Range": `bytes ${start}-${end}/${buf.length}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": `inline; filename="${encodeURIComponent(doc.filename)}"`,
          },
        });
      }
    }
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${buf.length}` },
    });
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(buf.length),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${encodeURIComponent(doc.filename)}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}