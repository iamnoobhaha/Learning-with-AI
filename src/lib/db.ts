import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATABASE_PATH
  ? path.dirname(process.env.DATABASE_PATH)
  : path.join(process.cwd(), "data");
export const FILES_DIR =
  process.env.UPLOADS_DIR ?? path.join(DATA_DIR, "files");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

const DB_FILE = process.env.DATABASE_PATH ?? path.join(DATA_DIR, "studyforge.db");

export const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 15000");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_libraries_name ON libraries(lower(name));
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('notes','past_paper')),
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  pages INTEGER,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  best REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('mcq','short')),
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,
  answer TEXT NOT NULL,
  explanation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  score_pct REAL NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS flashcards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  box INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS exams (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('mock','answers')),
  title TEXT NOT NULL,
  source_doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sample_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function columnsOf(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

if (!columnsOf("documents").has("library_id")) {
  db.exec(
    "ALTER TABLE documents ADD COLUMN library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL"
  );
}
db.exec("CREATE INDEX IF NOT EXISTS idx_documents_library ON documents(library_id)");

type Pick = (name: string, fallback?: string) => string;

/**
 * Rebuilds a table that predates library scoping, preserving existing rows.
 *
 * `cols` is the *old* table's column set, so any column introduced by a later
 * migration may not exist yet on a brand-new database. `pick` therefore emits
 * `NULL` for absent columns instead of referencing them, which keeps the
 * migration valid on both fresh and long-lived databases.
 */
function migrateScopedTable(
  table: string,
  rebuild: (oldCols: string[], pick: Pick) => string
) {
  const cols = [...columnsOf(table)];
  if (cols.includes("library_id")) return;
  const pick: Pick = (name, fallback = "NULL") => (cols.includes(name) ? name : fallback);
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec(rebuild(cols, pick));
  })();
  db.pragma("foreign_keys = ON");
}

migrateScopedTable("chat_messages", (_cols, pick) => `
  CREATE TABLE chat_messages_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((document_id IS NULL) <> (library_id IS NULL))
  );
  INSERT INTO chat_messages_new (id, document_id, library_id, role, content, created_at)
    SELECT id, document_id, NULL, role, content, ${pick("created_at", "datetime('now')")}
    FROM chat_messages;
  DROP TABLE chat_messages;
  ALTER TABLE chat_messages_new RENAME TO chat_messages;
`);

migrateScopedTable("quizzes", (_cols, pick) => `
  CREATE TABLE quizzes_new (
    id TEXT PRIMARY KEY,
    document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    best REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((document_id IS NULL) <> (library_id IS NULL))
  );
  INSERT INTO quizzes_new (id, document_id, library_id, title, difficulty, best, created_at)
    SELECT id, document_id, NULL, title, difficulty, best, ${pick("created_at", "datetime('now')")}
    FROM quizzes;
  DROP TABLE quizzes;
  ALTER TABLE quizzes_new RENAME TO quizzes;
`);

migrateScopedTable("flashcards", (_cols, pick) => `
  CREATE TABLE flashcards_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE,
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    box INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deck_id TEXT,
    due_at TEXT,
    interval INTEGER NOT NULL DEFAULT 0,
    ease REAL NOT NULL DEFAULT 2.5,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    CHECK ((document_id IS NULL) <> (library_id IS NULL))
  );
  INSERT INTO flashcards_new (id, document_id, library_id, front, back, box, updated_at, created_at, deck_id, due_at, interval, ease, reps, lapses)
    SELECT id, document_id, NULL, front, back, box,
           ${pick("updated_at", "datetime('now')")},
           COALESCE(${pick("created_at")}, ${pick("updated_at", "datetime('now')")}),
           ${pick("deck_id")}, ${pick("due_at")},
           COALESCE(${pick("interval")}, 0), COALESCE(${pick("ease")}, 2.5),
           COALESCE(${pick("reps")}, 0), COALESCE(${pick("lapses")}, 0)
    FROM flashcards;
  DROP TABLE flashcards;
  ALTER TABLE flashcards_new RENAME TO flashcards;
`);

if (!columnsOf("flashcards").has("created_at")) {
  db.exec("ALTER TABLE flashcards ADD COLUMN created_at TEXT");
  db.exec("UPDATE flashcards SET created_at = COALESCE(updated_at, datetime('now')) WHERE created_at IS NULL");
}
if (!columnsOf("flashcards").has("deck_id")) {
  db.exec("ALTER TABLE flashcards ADD COLUMN deck_id TEXT");
  db.exec(
    "UPDATE flashcards SET deck_id = 'legacy-' || substr(COALESCE(created_at, updated_at), 1, 10) WHERE deck_id IS NULL"
  );
}
if (!columnsOf("flashcards").has("interval")) {
  db.exec("ALTER TABLE flashcards ADD COLUMN interval INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE flashcards ADD COLUMN ease REAL NOT NULL DEFAULT 2.5");
  db.exec("ALTER TABLE flashcards ADD COLUMN reps INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE flashcards ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE flashcards ADD COLUMN due_at TEXT");
}
db.exec(
  "UPDATE flashcards SET interval = CASE box WHEN 5 THEN 60 WHEN 4 THEN 21 WHEN 3 THEN 7 WHEN 2 THEN 3 WHEN 1 THEN 1 ELSE 0 END WHERE interval = 0 AND box > 0"
);
db.exec(
  "UPDATE flashcards SET due_at = CASE WHEN interval > 0 THEN datetime('now', '+' || interval || ' days') ELSE COALESCE(due_at, datetime('now')) END WHERE due_at IS NULL"
);
db.exec("CREATE INDEX IF NOT EXISTS idx_flashcards_deck ON flashcards(deck_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_flashcards_scope ON flashcards(document_id, library_id)");

if (!columnsOf("chunks").has("block_index")) {
  db.exec("ALTER TABLE chunks ADD COLUMN block_index INTEGER NOT NULL DEFAULT 0");
}
if (!columnsOf("chunks").has("included")) {
  db.exec("ALTER TABLE chunks ADD COLUMN included INTEGER NOT NULL DEFAULT 1");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_block ON chunks(document_id, block_index)");

/* ---------------------------------------------------------------------------
 * Page-aware model
 *
 * document_pages is the durable unit of user selection: one row per real PDF
 * page / PPTX slide / semantic section. `included` is the ONLY switch that
 * decides whether content may reach an AI feature. Selection state lives here,
 * independently from derived chunks, so re-chunking never destroys a selection.
 * ------------------------------------------------------------------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS document_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  page_type TEXT NOT NULL CHECK(page_type IN ('pdf_page','pptx_slide','sheet','section')),
  label TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  included INTEGER NOT NULL DEFAULT 1,
  suggested_exclude INTEGER NOT NULL DEFAULT 0,
  exclusion_reason TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'ok'
    CHECK(extraction_status IN ('ok','no_text','error','pending')),
  extraction_error TEXT,
  structured_preview TEXT,
  text_length INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_doc_number ON document_pages(document_id, page_number);
CREATE INDEX IF NOT EXISTS idx_pages_doc_included ON document_pages(document_id, included);
`);

if (!columnsOf("documents").has("page_model")) {
  db.exec("ALTER TABLE documents ADD COLUMN page_model TEXT NOT NULL DEFAULT 'sectioned'");
}
if (!columnsOf("documents").has("selection_revision")) {
  db.exec("ALTER TABLE documents ADD COLUMN selection_revision INTEGER NOT NULL DEFAULT 1");
}
if (!columnsOf("documents").has("original_path")) {
  db.exec("ALTER TABLE documents ADD COLUMN original_path TEXT");
}
if (!columnsOf("documents").has("original_mime")) {
  db.exec("ALTER TABLE documents ADD COLUMN original_mime TEXT");
}
if (!columnsOf("documents").has("needs_reprocessing")) {
  db.exec("ALTER TABLE documents ADD COLUMN needs_reprocessing INTEGER NOT NULL DEFAULT 0");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_documents_reprocessing ON documents(needs_reprocessing)");

// chunks keep provenance back to their source page; block_index is retained for
// backwards compatibility but is no longer the user-facing selection unit.
if (!columnsOf("chunks").has("page_id")) {
  db.exec("ALTER TABLE chunks ADD COLUMN page_id INTEGER REFERENCES document_pages(id) ON DELETE CASCADE");
}
if (!columnsOf("chunks").has("page_number")) {
  db.exec("ALTER TABLE chunks ADD COLUMN page_number INTEGER");
}
if (!columnsOf("chunks").has("token_estimate")) {
  db.exec("ALTER TABLE chunks ADD COLUMN token_estimate INTEGER NOT NULL DEFAULT 0");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_id)");

// Generated artifacts record the selection revision they were built from so
// they can be flagged stale when the user changes their page selection.
for (const table of ["quizzes", "flashcards", "exams"]) {
  if (!columnsOf(table).has("selection_revision")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN selection_revision INTEGER`);
  }
}

// Attach source provenance to flashcards generated from specific pages.
if (!columnsOf("flashcards").has("source_pages")) {
  db.exec("ALTER TABLE flashcards ADD COLUMN source_pages TEXT");
}
if (!columnsOf("questions").has("source_pages")) {
  db.exec("ALTER TABLE questions ADD COLUMN source_pages TEXT");
}

/*
 * Legacy backfill: documents uploaded before the page model have chunks grouped
 * by `block_index`. Those boundaries were produced by the same extractors, so
 * for sectioned/slide documents they are a faithful unit. We migrate them into
 * document_pages rather than discarding user data, and mark documents whose
 * page boundaries cannot be verified (paginated PDFs whose originals were not
 * retained) as needing reprocessing instead of inventing page numbers.
 */
db.transaction(() => {
  const docs = db
    .prepare(
      `SELECT id, filename, page_model FROM documents d
       WHERE NOT EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id)`
    )
    .all() as { id: string; filename: string; page_model: string }[];

  const blockRows = db.prepare(
    "SELECT block_index, MIN(idx) AS first_idx, SUM(LENGTH(text)) AS chars FROM chunks WHERE document_id = ? GROUP BY block_index ORDER BY block_index"
  );
  const insertPage = db.prepare(
    `INSERT INTO document_pages
       (document_id, page_number, page_type, label, text, included, extraction_status, text_length)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  );
  const pageOf = db.prepare(
    "UPDATE chunks SET page_id = ?, page_number = ? WHERE document_id = ? AND block_index = ?"
  );
  const markStale = db.prepare("UPDATE documents SET needs_reprocessing = 1 WHERE id = ?");

  for (const doc of docs) {
    const lower = doc.filename.toLowerCase();
    const paginated = lower.endsWith(".pdf") || lower.endsWith(".pptx");
    const pageType = lower.endsWith(".pdf")
      ? "pdf_page"
      : lower.endsWith(".pptx")
        ? "pptx_slide"
        : lower.endsWith(".xlsx") || lower.endsWith(".xls")
          ? "sheet"
          : "section";

    const blocks = blockRows.all(doc.id) as {
      block_index: number;
      first_idx: number;
      chars: number;
    }[];
    if (!blocks.length) continue;

    const textStmt = db.prepare(
      "SELECT text FROM chunks WHERE document_id = ? AND block_index = ? ORDER BY idx"
    );
    blocks.forEach((b, i) => {
      const text = (textStmt.all(doc.id, b.block_index) as { text: string }[])
        .map((r) => r.text)
        .join("\n");
      const label =
        pageType === "pdf_page"
          ? `Page ${b.block_index + 1}`
          : pageType === "pptx_slide"
            ? `Slide ${b.block_index + 1}`
            : pageType === "sheet"
              ? `Section ${b.block_index + 1}`
              : `Section ${b.block_index + 1}`;
      const status = text.trim() ? "ok" : "no_text";
      const info = insertPage.run(
        doc.id,
        b.block_index + 1,
        pageType,
        label,
        text,
        status,
        text.length
      );
      const pageId = Number(info.lastInsertRowid);
      pageOf.run(pageId, b.block_index + 1, doc.id, b.block_index);
      void i;
    });

    // Originals were never retained, so visual previews cannot be produced for
    // pre-existing uploads. Flag them for reprocessing rather than faking it.
    if (paginated) markStale.run(doc.id);
  }
})();

export interface DocumentRow {
  id: string;
  kind: "notes" | "past_paper";
  title: string;
  filename: string;
  size: number;
  pages: number | null;
  content: string;
  library_id: string | null;
  created_at: string;
  page_model: string;
  selection_revision: number;
  original_path: string | null;
  original_mime: string | null;
  needs_reprocessing: number;
}

export interface LibraryRow {
  id: string;
  name: string;
  created_at: string;
}

export interface QuizRow {
  id: string;
  document_id: string | null;
  library_id: string | null;
  title: string;
  difficulty: string;
  best: number | null;
  created_at: string;
  selection_revision: number | null;
}

export interface QuestionRow {
  id: number;
  quiz_id: string;
  ord: number;
  type: "mcq" | "short";
  prompt: string;
  options: string;
  answer: string;
  explanation: string;
}

export interface ExamRow {
  id: string;
  kind: "mock" | "answers";
  title: string;
  source_doc_id: string;
  sample_doc_id: string | null;
  content: string;
  created_at: string;
}

export interface DocumentPageRow {
  id: number;
  document_id: string;
  page_number: number;
  page_type: "pdf_page" | "pptx_slide" | "sheet" | "section";
  label: string;
  text: string;
  included: number;
  suggested_exclude: number;
  exclusion_reason: string | null;
  extraction_status: "ok" | "no_text" | "error" | "pending";
  extraction_error: string | null;
  structured_preview: string | null;
  text_length: number;
  updated_at: string;
}

export default db;