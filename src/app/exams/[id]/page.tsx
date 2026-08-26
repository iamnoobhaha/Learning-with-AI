import { notFound } from "next/navigation";
import db, { type ExamRow } from "@/lib/db";
import { AnswersView, MockExamView, PrintButton } from "@/components/ExamViews";
import type { AnswersContent, MockExamContent } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ExamDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const row = db.prepare("SELECT * FROM exams WHERE id = ?").get(id) as ExamRow | undefined;
  if (!row) notFound();

  if (row.kind === "mock") {
    const exam = JSON.parse(row.content) as MockExamContent;
    return (
      <>
        <PrintButton />
        <MockExamView exam={exam} />
      </>
    );
  }
  const exam = JSON.parse(row.content) as AnswersContent;
  return (
    <>
      <PrintButton />
      <AnswersView exam={exam} />
    </>
  );
}
