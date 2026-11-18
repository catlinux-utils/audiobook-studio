# Architecture and development

## Layout

| Path | Contents |
|---|---|
| `setup.ps1` / `setup.sh` | Checksum-verified runtime installer for audio.cpp + OmniVoice (+ ASR/aligner models) |
| `versions.json` | Pinned runtime/model versions, URLs, sizes and SHA-256 checksums |
| `src/index.ts` | Fastify entry point; static SPA serving; managed TTS lifecycle |
| `src/api/routes.ts` | Every HTTP route (REST + SSE) |
| `src/ingest/` | EPUB and TXT parsers, sentence-aware chunker (pure, unit-tested) |
| `src/tts/` | audio.cpp client, managed server, generation queue, QA, alignment, expert-option registry |
| `src/audio/` | WAV metadata, continuity math, ffmpeg assembly, reference cleanup, analysis |
| `src/text/` | Synthesis-text normalization (ALL-CAPS headings) and number-word matching |
| `web/src/` | React 19 + Vite + Tailwind SPA: Library, Book detail, Voices, Voice expert, Queue, Exports, Settings |
| `tests/` | Vitest suites for the pure modules (chunker, continuity, QA numbers, text normalization, TXT split, cleanup filters, expert options) |
| `scripts/` | `seed.ts` (sample books), `make_samples.py` (rebuild sample EPUBs) |
| `sample-books/` | Public-domain test books and their license notes |
| `runtime/` | Installed audio.cpp binaries and GGUFs (gitignored) |
| `data/` | Runtime state (gitignored) |

The server is a single Fastify process. The queue claims regens first, then job parts, running up
to `concurrency` takes in parallel (default 1, i.e. sequential); expert sweeps and clone-doctor runs
are always sequential. `refreshBookStatus()` is the only writer of book status. Chapter and part
text remain the source of truth: editing text that no longer matches its audio drops that audio and
resets the part to pending.

State changes are pushed to the UI over `/api/events` (SSE); the frontend re-fetches on events
rather than running its own cache.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | API (`tsx watch`, :8090) + Vite dev server (:5173) |
| `npm run build` | TypeScript build + web bundle into `dist/` (served by the API) |
| `npm start` | run the built server (`node dist/src/index.js`) |
| `npm run typecheck` | `tsc` for server and web |
| `npm test` | Vitest unit suites |
| `npm run seed` | load `sample-books/` into the local DB |

After server changes: rebuild, stop the running `node dist/src/index.js` process, and start it again.
Web-only changes need just `npx vite build` when you are not using the dev server. `AGENTS.md` has a
condensed operational guide for contributors and coding agents.

## Conventions

- Relative imports use `.js` suffixes (ESM + `NodeNext`).
- Numbered schema migrations in `src/db.ts` are append-only; never edit an applied migration.
- Pure logic (chunker, sanitizers, filter-chain builders, parsers) lives in its own module with
  Vitest coverage; routes stay thin.
- Inputs are clamped and whitelisted server-side; the client is never trusted.
- Editing chapter/part text invalidates the corresponding audio — preserve that invariant.

## HTTP API

The UI is a thin client over plain REST, so the same pipeline is scriptable with `curl`. Main
resources:

| Resource | Examples |
|---|---|
| Books | `GET /api/books`, `POST /api/books` (multipart `file`), `POST /api/books/paste`, `POST /api/books/:id/qa/random`, `PATCH /api/books/:id`, `DELETE /api/books/:id` |
| Chapters | `GET /api/books/:id/chapters/:chapterId`, `PUT …/text`, `POST …/generate`, `POST …/export` |
| Parts | `PATCH /api/chunks/:id`, `POST /api/chunks/:id/regenerate`, `POST /api/chunks/:id/qa`, `GET /api/chunks/:id/audio` |
| Jobs | `POST /api/books/:id/generate`, `POST /api/books/:id/pause`, `POST /api/books/:id/cancel`, `POST /api/books/:id/queue-chunks` |
| Voices | `POST /api/voices`, `POST /api/voices/prepare`, `POST /api/voices/transcribe`, `POST /api/voices/:id/test`, `…/align`, `…/expert-run` |
| Exports | `GET /api/exports`, `POST /api/books/:id/export`, `POST /api/exports/:id/compress`, `GET /api/exports/:id/download`, `…/report` |
| Ops | `GET /api/health`, `GET /api/stats`, `GET /api/logs/tail`, `POST /api/maintenance/prep-cache`, `GET /api/events` (SSE) |

```bash
# health (studio + TTS server)
curl http://127.0.0.1:8090/api/health

# ingest a file, assign a voice, then start a book-wide job
curl -F "file=@book.epub" http://127.0.0.1:8090/api/books
curl -X POST http://127.0.0.1:8090/api/books/<bookId>/generate

# export the finished book, then download it using export.id from the response
curl -X POST http://127.0.0.1:8090/api/books/<bookId>/export
curl -OJ http://127.0.0.1:8090/api/exports/<exportId>/download

# follow live progress
curl -N http://127.0.0.1:8090/api/events
```

A full-book export runs the word check for every part (cached by duration), so the first export of
a long book is slower than later ones.
