# StudyForge

An AI study platform that turns your lecture notes and past papers into a tutor, quizzes,
flashcards with spaced repetition, and mock exams — with **you** in control of exactly which
pages the AI is allowed to read.

---

## The core idea: page-level control

Most AI study tools ingest a whole PDF and then ask questions about whatever it finds —
including the timetable on page 1. StudyForge treats each **page (PDF)**, **slide (PPTX)**,
**sheet (XLSX)** or **section (TXT/DOCX)** as a separate, selectable unit. You tick the pages
worth studying; everything else is never sent to the model.

This is enforced server-side in one place, so it applies identically to the tutor, quiz
generator, flashcard generator, mock exam generator and reference-answer generator.

---

## Features

| Area | What it does |
| --- | --- |
| **Visual page selector** | Responsive thumbnail grid, click-to-toggle, bulk actions (include all / invert / exclude all / range), larger preview modal with keyboard navigation |
| **PDF page previews** | Real page renders via PDF.js in the browser — no server image rendering required |
| **PPTX slide previews** | Faithful structured preview (title, bullets, image/table/chart indicators, speaker notes) |
| **AI tutor** | Streaming chat grounded in your included pages, with source citations |
| **Quizzes** | Difficulty rubrics, enforced MCQ/short ratio, randomised answer positions, adaptive "practice weak spots", duplicate avoidance |
| **Flashcards** | Anki-style SM-2 spaced repetition, due-review queue, deck history, CSV export |
| **Mock exams** | Generates a paper that mirrors a sample past paper's structure and mark scheme |
| **Reference answers** | Mark-scheme style answers for an uploaded past paper |
| **Course libraries** | Group documents; the tutor, quizzes and cards read across all of them |
| **Progress dashboard** | Streaks, score trends, per-document mastery, 7-day review forecast |
| **Stale-content detection** | Changing your page selection flags older quizzes as built on a previous selection |

---

## Requirements

- **Node.js 20 or newer** (developed on Node 26)
- **npm 10 or newer**
- An **NVIDIA NIM API key** (free tier at <https://build.nvidia.com>) for the
  `meta/llama-3.3-70b-instruct` model, or any OpenAI-compatible endpoint

No external binaries are required. LibreOffice is *not* needed (see
[Preview implementation](#preview-implementation)).

---

## Installation

```bash
npm install
cp .env.example .env      # then add your API key
npm run dev               # http://localhost:3000
```

> If `npm install` fails on `better-sqlite3`, your Node ABI does not match the prebuilt
> binary. Rebuild it for your runtime with:
> `npm rebuild better-sqlite3 --build-from-source`

---

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NVIDIA_NIM_API_KEY` | **yes** | – | API key for the model endpoint |
| `NVIDIA_NIM_BASE_URL` | no | `https://integrate.api.nvidia.com/v1` | Any OpenAI-compatible base URL |
| `NVIDIA_NIM_MODEL` | no | `meta/llama-3.3-70b-instruct` | Model id |
| `DATABASE_PATH` | no | `data/studyforge.db` | SQLite file location |
| `UPLOADS_DIR` | no | `<data dir>/files` | Where uploaded originals are stored |
| `MAX_UPLOAD_MB` | no | `25` | Upload size limit in megabytes |

Never commit `.env`. It is git-ignored.

---

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config, `eslint-config-next`) |
| `npm test` | Run the full test suite once |
| `npm run test:watch` | Watch mode |
| `npm run verify` | typecheck → lint → test → build |

---

## Supported file types

| Format | Unit of selection | Text extraction | Visual preview |
| --- | --- | --- | --- |
| PDF | page | pdfjs-dist, per page | **Real render** (PDF.js) |
| PPTX | slide | XML runs + speaker notes | Structured summary¹ |
| XLSX / XLS | sheet | `xlsx` → CSV | Text preview |
| DOCX | section | `mammoth` | Text preview |
| DOC (legacy) | section | `word-extractor` | Text preview |
| TXT / MD / CSV | section | direct | Text preview |

¹ PPTX cannot be rendered to an image without an external binary, so the app shows a
structured card (title, bullets, image/table/chart badges, speaker notes) and says so
explicitly rather than pretending it is a pixel-accurate render.

**Not supported:** legacy `.ppt` (binary PowerPoint) — re-save as `.pptx`.

### Limits

- 25 MB per upload (configurable)
- 500 PDF pages, 400 slides
- Zip-bomb protection on Office containers
- Password-protected PDFs are rejected with a clear message

---

## Preview implementation

**PDF** uses [`pdfjs-dist`](https://mozilla.github.io/pdf.js/) in two places:

- *Server*: the legacy Node build iterates the real page tree, so page numbers can never
  shift and empty pages are preserved and reported.
- *Browser*: `src/components/PdfThumbnails.tsx` renders thumbnails from the stored original
  (streamed by `/api/documents/[id]/file`, which supports HTTP range requests). The worker is
  bundled from `node_modules` via `?url`, not a CDN, so previews work offline and after reload.
  Rendering is bounded to two concurrent pages and results are cached in memory.

**PPTX** has no browser-native renderer. Slides are previewed as structured summaries. If you
install LibreOffice you could add true slide images, but the app never silently assumes the
binary exists.

---

## Architecture

```
Upload → validate → extract per page/slide → store pages + chunks → user selects pages
                                                                      ↓
                                        buildContext() reads ONLY included pages
                                                                      ↓
                              tutor / quiz / cards / exams / answer key
```

### Upload pipeline (`src/lib/ingest.ts`)

1. Validate extension **and** file signature (`src/lib/storage.ts`)
2. Reject oversized, encrypted-PDF and zip-bomb inputs
3. Write the original to `data/files/` (never under `public/`)
4. Extract into one unit per page/slide/section (`src/lib/extract.ts`)
5. In **one transaction**: insert the document, its `document_pages` rows, and the derived
   chunks with page provenance. A failure deletes the stored file — no orphans.

### Selection lifecycle

- Selection lives in `document_pages.included`, independent of the derived chunks, so
  re-processing can never destroy a user's choices.
- Every change bumps `documents.selection_revision`.
- Quizzes, flashcards and exams record the revision they were built from, so the UI can flag
  work that predates the current selection.

### Internal chunking (`src/lib/chunking.ts`)

Chunks are created **after** selection and exist only to fit context budgets. They are
sentence-aware (never split mid-word or mid-sentence), token-budgeted, carry
`page_id`/`page_number`, and never span two pages.

### Context retrieval (`src/lib/ai-context.ts`)

The single authority for AI source material:

- Reads **only** pages with `included = 1`; there is no `documents.content` fallback
- Chat uses query-aware ranking (sublinear TF-IDF with length normalisation)
- Generation uses coverage sampling across pages, so long documents are not biased to the start
- Returns source references alongside text, and rejects a scope with nothing studyable

### Content filtering policy (`src/lib/quality.ts`)

Low-value content is **suggested for exclusion, never deleted**. Pages with short or
admin-looking text stay visible and included until the user acts. Short definitions, formulas,
code, timelines and numbered procedures are explicitly protected from false positives.

---

## Database

SQLite at `data/studyforge.db` (WAL mode, foreign keys on). Migrations run automatically on
start and are idempotent, so existing databases upgrade in place without data loss.

Key tables:

- `documents` — metadata, `page_model`, `selection_revision`, `original_path`, `needs_reprocessing`
- `document_pages` — one row per page/slide/section, with `included`, extraction status and
  structured preview; unique on `(document_id, page_number)`
- `chunks` — internal, token-budgeted, `page_id`/`page_number` provenance
- `quizzes` / `questions` / `attempts`, `flashcards`, `exams`, `chat_messages`, `libraries`

### Documents uploaded before the page selector

Their originals were never stored, so visual previews cannot be produced retroactively. The
migration recreates their pages from existing chunks, keeps everything included, and flags
them `needs_reprocessing` — the UI asks the user to re-upload to enable visual previews. No
user data is discarded.

---

## Backup and restore

Everything lives in `data/`:

```bash
# Back up (safest: stop the app first)
cp -r data/ backups/data-$(date +%F)/

# Restore
rm -rf data && cp -r backups/data-2026-01-01/ data/
```

For a hot backup, use SQLite's own tooling:

```bash
sqlite3 data/studyforge.db ".backup 'backup.db'"
```

---

## Privacy and data handling

- All data stays on the machine running the app. There is no telemetry.
- Uploaded files are written to `data/files/` with owner-only permissions and are **never**
  served as static assets; they are reachable only through an app route.
- Document text is sent to your configured model endpoint to generate study material. Nothing
  is sent anywhere else.
- Uploaded text is treated as **untrusted data**: it is clearly delimited in prompts and the
  model is instructed never to follow instructions found inside study material.
- Deleting a document cascades to its pages, chunks, quizzes, cards and messages.

---

## Testing

```bash
npm test
```

85 tests across seven files: PDF/PPTX page mapping, empty-page preservation, token-aware
chunking, page-boundary guarantees, context inclusion/exclusion, selection revision, bulk
selection API, non-destructive filtering, upload validation, spaced repetition, deduplication,
and component tests for the page selector (visual states, click and keyboard toggling, bulk
actions, optimistic rollback, accessibility labels, modal navigation).

AI calls are never made in tests.

---

## Troubleshooting

**"No study content is selected"** — every included page has no extractable text. Open the
document's page selector and include a page with text.

**No visual previews** — the original file is unavailable. Upload it again; only new uploads
store originals.

**"This PDF is password protected"** — remove the password and re-upload.

**"No selectable text found on any page"** — the PDF is a scan. StudyForge has no OCR yet.

**Upload fails with "contents do not match its extension"** — the file is corrupt or renamed.

**`better-sqlite3` fails to load** — run `npm rebuild better-sqlite3 --build-from-source`.

**Stale badges on quizzes** — expected after you change your page selection. Regenerate the
quiz to use the new pages.

---

## Known limitations

- **No OCR.** Image-only pages and scans are listed but contribute no text.
- **PPTX previews are structured summaries**, not rendered slide images.
- **Single-user, no authentication.** The app trusts its network boundary; do not expose it
  to the public internet without adding auth.
- **Token counts are approximated** (~4 chars/token plus a word term with a 1.15 safety
  factor), not produced by the model's own tokenizer, which is not available at runtime.
- **Legacy `.ppt`** is unsupported.
- **Retrieval is lexical** (TF-IDF), so highly non-Latin scripts fall back to coverage
  sampling rather than ranking.