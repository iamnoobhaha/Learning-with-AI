import fs from "node:fs";
import path from "node:path";
import { writeFixtures } from "./fixtures/make-fixtures";

/**
 * Runs once before any test file. Fixtures must exist on disk before workers
 * collect test modules, so they are generated here rather than in a per-file
 * setup hook.
 */
export async function setup(): Promise<void> {
  await writeFixtures();
}

export async function teardown(): Promise<void> {
  const tmp = path.join(process.cwd(), ".test-tmp");
  fs.rmSync(tmp, { recursive: true, force: true });
}