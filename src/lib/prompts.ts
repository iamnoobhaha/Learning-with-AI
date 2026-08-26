import type { AiMessage } from "./ai";

export function tutorMessages(opts: {
  title: string;
  context: string;
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
}): AiMessage[] {
  const system: AiMessage = {
    role: "system",
    content:
      "You are StudyForge, a patient expert tutor helping a student understand their own lecture notes. " +
      "Ground your answers in the NOTE EXCERPTS when relevant, and clearly flag anything beyond the notes. " +
      "Explain step by step with short paragraphs, bullet lists and small worked examples. " +
      "When the student is close but wrong, guide them with hints instead of giving the answer immediately. " +
      "End substantive answers with one short check-understanding question. Use GitHub-flavoured Markdown.",
  };
  const historyText =
    opts.history
      .slice(-8)
      .map((m) => `${m.role === "user" ? "STUDENT" : "TUTOR"}: ${m.content}`)
      .join("\n\n") || "(new conversation)";
  const user: AiMessage = {
    role: "user",
    content:
      `DOCUMENT: ${opts.title}\n\nNOTE EXCERPTS:\n"""\n${opts.context}\n"""\n\n` +
      `RECENT CONVERSATION:\n${historyText}\n\nSTUDENT: ${opts.message}`,
  };
  return [system, user];
}

export function quizMessages(opts: {
  title: string;
  context: string;
  mcqCount: number;
  shortCount: number;
  difficulty: string;
}): AiMessage[] {
  const rubric =
    opts.difficulty === "easy"
      ? "easy = direct recall of facts stated verbatim in the notes; single-step; distractors clearly wrong to anyone who read the notes."
      : opts.difficulty === "hard"
        ? "hard = multi-step reasoning, synthesis across parts of the notes, subtle distinctions or edge cases; distractors very close to the correct answer and individually plausible."
        : "medium = requires understanding or simple application of concepts from the notes (why/how, one-step calculations, comparisons); distractors plausible but distinguishable.";
  const system: AiMessage = {
    role: "system",
    content:
      "You are an expert exam writer. Create original assessment questions strictly based on the provided course notes.\n" +
      `DIFFICULTY TARGET — ${opts.difficulty}: ${rubric}\n` +
      "MCQ RULES:\n" +
      "- Exactly 4 options each, similar in length and style.\n" +
      "- No letter prefixes on options. Never use \"All/None of the above\" or options that combine other options.\n" +
      "- Distractors must be incorrect but believable; only ONE option may be defensibly correct.\n" +
      "- answer_index is the 0-based index of the single correct option.\n" +
      "- Short-answer prompts must be answerable in 1-3 sentences using the notes.\n" +
      'Respond with ONLY valid JSON, no markdown fences and no extra text. Schema:\n' +
      '{"title":string,"questions":[{"type":"mcq","prompt":string,"options":[string,string,string,string],"answer_index":0-3,"explanation":string} | {"type":"short","prompt":string,"answer":string,"explanation":string}]}' +
      `\nCOUNTS ARE STRICT: return EXACTLY ${opts.mcqCount} object(s) with type "mcq"${
        opts.shortCount > 0
          ? ` and EXACTLY ${opts.shortCount} object(s) with type "short"`
          : ' and ZERO objects with type "short"'
      }, interleaved in mixed order.`,
  };
  const user: AiMessage = {
    role: "user",
    content:
      `Course notes: ${opts.title}\n` +
      `Generate EXACTLY ${opts.mcqCount} multiple-choice question(s) and EXACTLY ${opts.shortCount} short-answer question(s). Do not return more or fewer.\n\n` +
      `NOTES:\n"""\n${opts.context}\n"""`,
  };
  return [system, user];
}

export function gradeMessages(
  items: { prompt: string; modelAnswer: string; studentAnswer: string }[]
): AiMessage[] {
  const system: AiMessage = {
    role: "system",
    content:
      "You are a fair exam marker. Grade each student answer against its model answer, awarding partial credit proportional to correctness (0 to 1). " +
      'Ignore trivial wording differences; reward correct concepts. Respond with ONLY a JSON array, one object per item in order:\n' +
      '[{"index":0,"score":0.75,"feedback":"max 40 words"}]',
  };
  const listing = items
    .map(
      (it, i) =>
        `[${i}] QUESTION: ${it.prompt}\nMODEL ANSWER: ${it.modelAnswer}\nSTUDENT ANSWER: ${it.studentAnswer || "(blank)"}`
    )
    .join("\n\n");
  return [
    system,
    { role: "user", content: `Grade all ${items.length} item(s):\n\n${listing}` },
  ];
}

export function flashcardMessages(opts: {
  title: string;
  context: string;
  count: number;
}): AiMessage[] {
  const system: AiMessage = {
    role: "system",
    content:
      "You create high-quality spaced-repetition flashcards from study material. Each card tests ONE atomic idea; mix recall, definition and application prompts. " +
      'Front must be a question or cue (max 25 words); back a crisp answer (max 60 words). Respond with ONLY valid JSON:\n' +
      '{"cards":[{"front":string,"back":string}]}',
  };
  const user: AiMessage = {
    role: "user",
    content: `Material: ${opts.title}\nCreate ${opts.count} flashcards.\n\nMATERIAL:\n"""\n${opts.context}\n"""`,
  };
  return [system, user];
}

export function mockExamMessages(opts: {
  notesTitle: string;
  notesContext: string;
  sampleTitle: string;
  sampleContext: string;
  topic?: string;
}): AiMessage[] {
  const system: AiMessage = {
    role: "system",
    content:
      "You write mock exam papers that faithfully mirror the STRUCTURE of a past paper while asking NEW questions drawn only from the student's course notes. " +
      "Match the sample's section layout, command words (state/explain/discuss/calculate...), mark allocations per part and overall style. " +
      'Respond with ONLY valid JSON, no fences:\n' +
      '{"title":string,"instructions":string,"duration_minutes":number,"total_marks":number,"sections":[{"name":string,"questions":[{"number":string e.g. "1(a)","prompt":string,"marks":number}]}]}\n' +
      "total_marks must equal the sum of all marks. Prompts must be answerable from the notes provided.",
  };
  const user: AiMessage = {
    role: "user",
    content:
      `SAMPLE PAST PAPER (${opts.sampleTitle}) — copy its structure/style only:\n"""\n${opts.sampleContext}\n"""\n\n` +
      `COURSE NOTES (${opts.notesTitle}) — source of new questions${opts.topic ? `, focus topic: ${opts.topic}` : ""}:\n"""\n${opts.notesContext}\n"""`,
  };
  return [system, user];
}

export function referenceAnswersMessages(opts: {
  paperTitle: string;
  paperContext: string;
}): AiMessage[] {
  const system: AiMessage = {
    role: "system",
    content:
      "You produce model reference answers (mark schemes) for an uploaded past paper. Identify every answerable question IN ORDER, restate it briefly, infer sensible marks if unclear, then give a full mark-scheme style answer using bullet points whose allocation sums to the marks. " +
      'Respond with ONLY valid JSON, no fences:\n' +
      '{"paper_title":string,"answers":[{"number":string,"question":string,"marks":number,"answer":string (markdown, bullets like "| 1 mark | point |")}]}',
  };
  const user: AiMessage = {
    role: "user",
    content: `PAST PAPER (${opts.paperTitle}):\n"""\n${opts.paperContext}\n"""`,
  };
  return [system, user];
}
