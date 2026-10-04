export interface DocMeta {
  id: string;
  kind: "notes" | "past_paper";
  title: string;
  filename: string;
  pages: number | null;
  size: number;
  library_id: string | null;
  created_at: string;
  page_model?: "paginated" | "sectioned";
  selection_revision?: number;
  needs_reprocessing?: number;
}

export interface LibraryMeta {
  id: string;
  name: string;
  createdAt: string;
  docCount: number;
  notesCount: number;
  papersCount: number;
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export interface QuizQuestionView {
  id: number;
  ord: number;
  type: "mcq" | "short";
  prompt: string;
  options: string[];
  answer?: string;
  explanation?: string;
}

export interface QuizFull {
  id: string;
  title: string;
  difficulty: string;
  documentId: string;
  questions: QuizQuestionView[];
}

export interface AttemptDetailItem {
  questionId: number;
  type: "mcq" | "short";
  correct: boolean | null;
  score: number | null;
  feedback: string;
  yourAnswer: string;
  modelAnswer: string;
  explanation?: string;
}

export interface AttemptResult {
  attemptId: number;
  scorePct: number;
  details: AttemptDetailItem[];
}

export interface QuizHistoryItem {
  id: string;
  title: string;
  difficulty: string;
  best: number | null;
  createdAt: string;
  questionCount: number;
}

export interface FlashcardView {
  id: number;
  front: string;
  back: string;
  box: number;
  created_at: string;
  deck_id: string;
  due_at: string | null;
  interval: number;
  ease: number;
  reps: number;
  lapses: number;
}

export interface MockExamContent {
  title: string;
  instructions: string;
  duration_minutes: number;
  total_marks: number;
  sections: { name: string; questions: { number: string; prompt: string; marks: number }[] }[];
}

export interface AnswersContent {
  paper_title: string;
  answers: { number: string; question: string; marks: number; answer: string }[];
}

export interface ExamListItem {
  id: string;
  kind: "mock" | "answers";
  title: string;
  sourceTitle: string;
  sampleTitle: string | null;
  createdAt: string;
}

export interface QuizHistoryItemV2 extends QuizHistoryItem {
  attemptCount: number;
  recentScores: number[];
  /** True when the page selection changed after this quiz was generated. */
  stale?: boolean;
  selectionRevision?: number | null;
  currentRevision?: number;
}

export interface StatsOverview {
  streakDays: number;
  activeToday: boolean;
  totalDocs: number;
  notesCount: number;
  papersCount: number;
  quizzesTaken: number;
  avgScore: number | null;
  bestScore: number | null;
  flashcardsTotal: number;
  flashcardsMastered: number;
  flashcardsDue: number;
}

export interface ScorePoint {
  date: string;
  score: number;
  quizTitle: string;
}

export interface DocProgress {
  id: string;
  title: string;
  kind: "notes" | "past_paper";
  quizCount: number;
  attempts: number;
  avgScore: number | null;
  cardsTotal: number;
  cardsMastered: number;
  chatTurns: number;
}

export interface ActivityItem {
  type: "quiz" | "chat" | "flashcards" | "exam" | "upload";
  label: string;
  detail: string;
  at: string;
}
