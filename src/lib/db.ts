import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "studyforge.db"));
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deck_id TEXT,
  due_at TEXT,
  interval INTEGER NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0
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

function migrateScopedTable(
  table: string,
  rebuild: (oldCols: string[]) => string
) {
  const cols = [...columnsOf(table)];
  if (cols.includes("library_id")) return;
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec(rebuild(cols));
  })();
  db.pragma("foreign_keys = ON");
}

migrateScopedTable("chat_messages", () => `
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
    SELECT id, document_id, NULL, role, content, created_at FROM chat_messages;
  DROP TABLE chat_messages;
  ALTER TABLE chat_messages_new RENAME TO chat_messages;
`);

migrateScopedTable("quizzes", () => `
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
    SELECT id, document_id, NULL, title, difficulty, best, created_at FROM quizzes;
  DROP TABLE quizzes;
  ALTER TABLE quizzes_new RENAME TO quizzes;
`);

migrateScopedTable("flashcards", () => `
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
  INSERT INTO flashcards_new (id, document_id, library_id, front, back, box, updated_at, created_at, deck_id)
    SELECT id, document_id, NULL, front, back, box, updated_at, created_at, deck_id FROM flashcards;
  DROP TABLE flashcards;
  ALTER TABLE flashcards_new RENAME TO flashcards;
`);

if (!columnsOf("flashcards").has("created_at")) {
  db.exec("ALTER TABLE flashcards ADD COLUMN created_at TEXT");
  db.exec("UPDATE flashcards SET created_at = datetime('now') WHERE created_at IS NULL");
}
if (!columnsOf("flashcards").has("deck_id")) {
  db.exec("ALTER TABLE flashcards ADD COLUMN deck_id TEXT");
  db.exec(
    "UPDATE flashcards SET deck_id = 'legacy-' || substr(created_at, 1, 10) WHERE deck_id IS NULL"
  );
}
db.exec("UPDATE flashcards SET created_at = datetime('now') WHERE created_at IS NULL");
db.exec("CREATE INDEX IF NOT EXISTS idx_flashcards_deck ON flashcards(deck_id)");

if (!columnsOf("flashcards").has("interval")) {
  db.exec("ALTER TABLE flashcards ADD COLUMN interval INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE flashcards ADD COLUMN ease REAL NOT NULL DEFAULT 2.5");
  db.exec("ALTER TABLE flashcards ADD COLUMN reps INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE flashcards ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE flashcards ADD COLUMN due_at TEXT");
  db.exec(
    "UPDATE flashcards SET interval = CASE box WHEN 5 THEN 60 WHEN 4 THEN 21 WHEN 3 THEN 7 WHEN 2 THEN 3 WHEN 1 THEN 1 ELSE 0 END"
  );
  db.exec(
    "UPDATE flashcards SET due_at = CASE WHEN interval > 0 THEN datetime('now', '+' || interval || ' days') ELSE datetime('now') END WHERE due_at IS NULL"
  );
}

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

export default db;
