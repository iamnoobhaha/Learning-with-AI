import { NextResponse } from "next/server";
import db from "@/lib/db";
import type { ExamListItem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const documentId = new URL(req.url).searchParams.get("documentId");
  const rows = (
    documentId
      ? db
          .prepare(
            `SELECT e.id, e.kind, e.title, e.created_at, s.title AS source_title, p.title AS sample_title
             FROM exams e
             JOIN documents s ON s.id = e.source_doc_id
             LEFT JOIN documents p ON p.id = e.sample_doc_id
             WHERE e.source_doc_id = ? OR e.sample_doc_id = ?
             ORDER BY e.created_at DESC, e.id DESC`
          )
          .all(documentId, documentId)
      : db
          .prepare(
            `SELECT e.id, e.kind, e.title, e.created_at, s.title AS source_title, p.title AS sample_title
             FROM exams e
             JOIN documents s ON s.id = e.source_doc_id
             LEFT JOIN documents p ON p.id = e.sample_doc_id
             ORDER BY e.created_at DESC, e.id DESC`
          )
          .all()
  ) as { id: string; kind: "mock" | "answers"; title: string; created_at: string; source_title: string; sample_title: string | null }[];

  const list: ExamListItem[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    sourceTitle: r.source_title,
    sampleTitle: r.sample_title,
    createdAt: r.created_at,
  }));
  return NextResponse.json({ exams: list });
}
