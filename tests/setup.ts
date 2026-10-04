import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Per-file test bootstrap.
 *
 * Every test file gets a throwaway SQLite database so the developer's real
 * data/studyforge.db is never touched, and stored uploads go to a temp dir.
 * Fixtures are written once in tests/global-setup.ts before collection.
 */

const TMP_ROOT = path.join(process.cwd(), ".test-tmp");
const DB_PATH = path.join(TMP_ROOT, "test.db");
const FILES_DIR = path.join(TMP_ROOT, "files");

process.env.DATABASE_PATH = DB_PATH;
process.env.UPLOADS_DIR = FILES_DIR;
process.env.NVIDIA_NIM_API_KEY = "test-key-not-real";
process.env.NVIDIA_NIM_BASE_URL = "http://127.0.0.1:9/v1";

fs.mkdirSync(FILES_DIR, { recursive: true });

/** Direct database handle for assertions (bypasses the app singleton). */
export function testDb(): Database.Database {
  return new Database(DB_PATH);
}

export function fixturesDir(): string {
  return path.join(process.cwd(), "tests", "fixtures");
}

export function fixture(name: string): Buffer {
  return fs.readFileSync(path.join(fixturesDir(), name));
}

export const TMP_ROOT_PATH = TMP_ROOT;