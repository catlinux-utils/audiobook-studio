# Audiobook Studio

[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-52525b)](#requirements)
[![License](https://img.shields.io/badge/license-MIT-3b82f6)](LICENSE)

A local-first, self-hosted studio that turns EPUB/TXT books into chaptered audiobooks with a cloned
narrator voice. It drives [audio.cpp](https://github.com/0xShug0/audio.cpp) with **OmniVoice** on
**Vulkan** — no CUDA, no ROCm, no PyTorch — and wraps the whole production chain in a web UI:
ingest → sentence-aware parts → generation queue → word-level QA → seamless assembly → `.m4b`/MP3.

Beyond `npm install` and the one-time runtime download, the studio makes no outbound network calls
unless you deliberately configure an external TTS server: by default it talks only to the local
audio.cpp child process it starts and supervises.

**Contents:** [How it works](#how-it-works) · [Requirements](#requirements) · [Install](#install) ·
[First book](#first-book) · [Features](#features) · [Narration continuity](#narration-continuity) ·
[Configuration](#configuration) · [Data](#data-and-backups) · [Architecture](#architecture) ·
[API](#http-api) · [Development](#development) · [Scope](#scope-and-limitations) ·
[Troubleshooting](#troubleshooting) · [License](#license)

## How it works

```
 EPUB / TXT / pasted text
            │
            ▼
   ingest ─ chapters ─ sentence-aware parts
            │
            ├── Voices: reference WAV + transcript
            ▼
   generation queue ───▶ audio.cpp + OmniVoice (Vulkan, child on :8081)
            │                     POST /v1/audio/speech, inline voice_ref
            ▼
   per-part WAVs ──▶ QA word check (ASR transcript vs. part text)
            │
            ▼
   continuity assembly (ffmpeg) ──▶ chapter WAVs ──▶ .m4b / MP3
                                                      + chapter markers, cover, QA report
```

The studio is **standalone by default**: `setup.ps1` / `setup.sh` install a checksum-pinned
audio.cpp Vulkan build plus the OmniVoice GGUF (see `versions.json`), and the server spawns it as a
child process on port 8081, stopping it on shutdown. If you already run an audio.cpp server
elsewhere, switch **Settings → TTS mode** to *external* and point it at that server.

## Requirements

| Component | Requirement |
|---|---|
| **Node.js** | 22.13 or newer (built-in `node:sqlite`; tested on Node 26) |
| **ffmpeg** | recent build (6.x+) on `PATH`, with `libmp3lame`, `aac` and the MP4 muxer — or set the binary path in Settings |
| **GPU** | Vulkan-capable (AMD / Intel / NVIDIA) with current drivers; Vulkan ships with the driver |
| **Disk** | ~4 GB for the runtime + models, plus working space for chunk WAVs and exports |
| **OS** | Windows 10/11 x64 or Linux x64 (setup scripts for both) |
| **Browser** | any current browser (the UI is a React SPA) |

A GPU is required for generation, voice tests, and all ASR/alignment work. On this project's
reference machine a short take takes roughly 20–40 s including model work; a full novel is an
overnight job, not a coffee break.

## Install

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File setup.ps1
npm install
npm run seed            # optional: public-domain sample books
npm run build
npm start
```

```bash
# Linux
chmod +x setup.sh && ./setup.sh
npm install
npm run seed            # optional
npm run build
npm start
```

Then open **http://127.0.0.1:8090**. The TTS child server comes up on `:8081` automatically; the
first request after a cold start waits for the model to load.

To use the in-app log viewer, start the studio with its output redirected to `data/server.log`:

```text
# POSIX shell
npm start > data/server.log 2>&1
# Windows
cmd /c npm start > data\server.log 2>&1
```

`setup.ps1` / `setup.sh` install audio.cpp 0.9.5 (Windows/Linux x64), the OmniVoice q8_0 weights,
and the ASR and forced-aligner models used by the voice tooling. They accept
`-SkipModel` / `--skip-model` (runtime only) and `-Force` / `--force` (re-download). Artifacts are
cached in `runtime/downloads/` and verified against the SHA-256 values in `versions.json`;
`runtime/` is gitignored and safe to re-install.

Development mode runs the API and a Vite dev server with hot reload:

```bash
npm run dev             # API on :8090, UI on :5173 (proxies /api)
```

## First book

1. **Voices → add a voice.** Load a clean 20–60 s recording of the narrator (wav/mp3/m4a/ogg/flac),
   drag-select the best segment on the waveform, then run *prepare* (mono 24 kHz, loudness
   normalize, silence trim) and *transcribe*. The transcript must match the clip word for word —
   it is what makes cloning work. The reference payload is capped at ~3.5 MiB WAV (~70 s).
2. **Library → add a book.** Drop an `.epub` or `.txt`, or paste text for a quick one-chapter
   book. Chapters and parts are detected on ingest.
3. **Book detail.** Assign the voice, adjust steps/guidance/speed/seed if you want, and hit
   **Generate**. Generation can be book-wide, per chapter, or for selected parts.
4. **Listen early.** Use the cut map and spot-check tools to catch bad splits or mispronunciations
   before you generate 10 hours of audio.
5. **Export.** `Export M4B` writes a chaptered file with cover art; chapters can also be exported
   as MP3. Every export gets a QA report next to it.

## Features

### Library and ingest

- **EPUB** (spine order, cover extraction) and **TXT** ingest with multilingual chapter detection:
  `Rozdział` / `Chapter` / `Część` / `Tom` / `Księga`, roman numerals, `XXIV. TITLE`, and a bare
  numeral followed by the title on the next line
- **Pasted text** → a one-chapter book (up to ~200k characters), same pipeline as files
- Chapter text editing and re-splitting; per-chapter part-size override (the book default stays
  intact); "rechunk" keeps per-chapter overrides where possible
- The active section lists only books with work actually open (running/queued/paused jobs); cards
  show progress, failed-part counts and duration

### Parts (chunks)

- Sentence-aware splitter with Polish and English abbreviation handling (`prof.`, `itd.`, `J. K.`,
  decimals, dialogue dashes) that only cuts mid-sentence when it must; assembly tightens those
  joins with a short crossfade
- Edit a part's text (its audio is dropped and the part returns to pending); edit a whole chapter
  by pasting it back
- **Disable/enable parts** — kept on disk but skipped by the queue and exports; useful for
  front-matter, duplicated headings or a paragraph you want to redo later; bulk toggle from a
  timeline selection
- Regenerate a single part with an optional seed (A/B takes) or an entire chapter (re-runs done
  parts as one job)
- **Cut map**: a visual timeline of the chapter's parts; click to seek the continuous chapter audio
  to that cut, play any part in isolation, see what is queued, done or disabled

### Voice cloning lab

- Waveform-based reference preparation with drag selection, denoise-before-trim, loudness
  normalization and A/B playback against the original
- **ASR auto-transcript** with the bundled CrisperWhisper model — no typing needed
- **Forced alignment** of the transcript against the reference (Meta MMS): per-word timings, gaps
  and suspect words; click a word to hear just that slice
- Clone test with word-level QA, text preview, and a 12-option **expert bench** (instruct, speed,
  duration, steps, guidance, shift, and more) with server-side sanitization
- **Sweep builder** for batch experiments and a **clone doctor** take log; the best take can be
  applied to the voice with one click (the doctor applies it automatically when it beats the
  baseline on WER)
- **Per-voice pause target** used by assembly, plus reference-cleanup filters that can also shorten
  overly long internal pauses

### Queue and generation

- Three job scopes: explicit part selection > chapter > book-wide; chapter jobs run FIFO one after
  another, and regeneration selections jump ahead as a priority queue
- Pause / resume / cancel with live SSE progress, per-part retry, and per-book ETA based on measured
  speed
- Automatic retries: degenerate or empty diffusion outputs are retried up to four times with
  deterministic bumped seeds, so takes stay reproducible
- Crash recovery: parts stuck in `generating` are returned to `pending` at startup
- Stats: speed factor (×realtime), compute time, wall time and ETA per job

### QA

- Word-level diff of the ASR transcript against the part text: missing / extra / variant words,
  WER, fuzzy matching, and digit ↔ spoken-number equivalence (`7` ↔ `siedem`)
- Verdicts are cached per part, keyed by audio duration, so exports and spot-checks are cheap after
  the first pass
- Random spot-check, per-part "check words", and an export-wide QA report (`.qa.txt`, viewable as a
  styled HTML page from the Exports page)

### Assembly and export

- **Continuity assembly**: edge-silence trim, loudness matching, micro-fades and pause
  normalization across independently generated parts (see
  [Narration continuity](#narration-continuity))
- **`.m4b`** with real chapter markers and embedded cover art; only fully generated chapters are
  included, so a half-finished book exports the finished chapters
- **Per-chapter MP3** export
- **Compress for Discord**: re-encodes an export to a target size (default 20 MB) while keeping
  chapters, cover and the QA report
- Raw, lossless concat is still available by turning smoothing off in Settings

### Operations

- Settings page: TTS mode and ports, model id, concurrency, ffmpeg path, default part size, studio
  port, assembly pacing, maintenance actions, and a live tail of `data/server.log`
- Health endpoint and a "test TTS connection" button
- "Clear assembly caches" removes derived `.prep*` directories (they rebuild on demand)

## Narration continuity

Chunks are generated independently, so a naive concat exposes three seams: irregular edge silence,
per-take loudness drift, and hard sample cuts. With smoothing enabled (the default), each part
first goes through a cached prep pass:

1. **Edge trim** to a small lead-in/tail pad, using a threshold derived from the take's own noise
   floor (the tail room tone is kept as pause material).
2. **Loudness match** — a clamped static gain toward one RMS target; digital silence is never
   amplified.
3. **Micro fades** on both edges to remove clicks.

The chapter is then joined with ffmpeg. The prepped lead/tail pads give each sentence boundary its
standard pause, and the joins are crossfaded with equal-power curves so the splice never dips. At
paragraph breaks the pause is extended with a looped slice of the left take's own tail room tone,
crossfaded in and out. Mid-sentence (soft-cut) joins get no pause at all — just a short crossfade
that tightens the prosody hitch.

The standard pause length is chosen per chapter from the take's own **median natural pause**
(excluding digital-silence dropouts), falling back to the global setting when there is nothing to
measure. A **per-voice pause target** in the Voices page overrides it. Paragraph breaks add the
configured extra.

Prep copies live in `data/books/<id>/audio/.prep-v8/` and are keyed by source mtime and pause
target; bumping the prep schema or changing the target invalidates them automatically. "Clear
assembly caches" in Settings removes them, and plain concat is one toggle away if you prefer the
raw takes.

## Configuration

Settings live in `data/settings.json` and are editable from the UI (or by hand; the file is
re-serialized on every write).

| Key | Default | Meaning |
|---|---|---|
| `ttsMode` | `managed` | `managed` spawns the bundled audio.cpp child; `external` uses `audiocppUrl` |
| `managedPort` | `8081` | port for the managed TTS server |
| `audiocppUrl` | `http://127.0.0.1:8080` | external audio.cpp base URL (no `/v1`) |
| `model` | `omnivoice` | model id; fixed by the managed config |
| `concurrency` | `1` | parallel requests to audio.cpp (the server queues beyond that) |
| `ffmpegPath` | `ffmpeg` | binary name or absolute path |
| `defaultMaxChunkChars` | `280` | default part size for new books |
| `port` | `8090` | studio port (restart required) |
| `assemblySmooth` | `true` | continuity prep + pause insertion; `false` = raw concat |
| `assemblyGapMs` | `400` | fallback sentence pause when auto-detection has no data |
| `assemblyParagraphGapMs` | `700` | paragraph pause budget; the surplus over `assemblyGapMs` is added at paragraph joins (+300 ms with the defaults) |
| `assemblySoftCutGapMs` | `120` | legacy knob for mid-sentence joins; soft cuts are crossfaded with no inserted pause regardless of this value |

The studio binds to `127.0.0.1` only. There is no authentication; do not expose it directly to a
network. To use it remotely, put it behind an authenticated reverse proxy or tunnel.

## Data and backups

All mutable state is under `data/` (gitignored):

```
data/
  studio.db              SQLite (node:sqlite): books, chapters, chunks, jobs, voices, takes, exports
  settings.json          configuration (created on first run)
  server.log             server output when started with redirection (tail it from Settings)
  books/<bookId>/
    source.epub|txt      original ingest input (kept for re-chunking)
    cover.jpg|png        extracted cover
    chunks/*.wav         generated audio, one file per part
    audio/               assembled chapter WAVs
    audio/.prep-v8/      continuity prep cache (safe to delete)
  voices/<voiceId>.wav   voice reference clips
  voices-takes/          expert/sweep takes
  exports/               final .m4b / MP3 + .qa.txt reports
```

Back up by stopping the studio and copying `data/`. Restoring the folder is enough: the schema is
created/migrated on startup. Generated audio is reproducible (seeds live in the DB), but the model
and voice references must be present to regenerate.

## Architecture

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

## Development

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

Conventions worth knowing before you touch the code:

- Relative imports use `.js` suffixes (ESM + `NodeNext`).
- Numbered schema migrations in `src/db.ts` are append-only; never edit an applied migration.
- Pure logic (chunker, sanitizers, filter-chain builders, parsers) lives in its own module with
  Vitest coverage; routes stay thin.
- Inputs are clamped and whitelisted server-side; the client is never trusted.
- Editing chapter/part text invalidates the corresponding audio — preserve that invariant.

## Scope and limitations

- **Single user, single machine.** No accounts, no multi-tenant storage, no remote rendering. The
  server binds to loopback only.
- **Vulkan only.** There is no CUDA/ROCm/Metal backend; the bundled audio.cpp build is Windows/Linux
  x64.
- **Chunked synthesis has seams.** Continuity assembly hides most of the abrupt prosody resets at
  part boundaries, but each take is generated without knowledge of its neighbours. Very long parts
  can also drift in pacing.
- **QA is a word check, not a quality judge.** It catches missing, extra and variant words via ASR;
  it cannot tell you whether the acting is good.
- **M4B audio is AAC 96 kbps.** Keep the assembled chapter WAVs if you need a lossless master.
- **The HTTP API is unversioned.** It is usable for scripting, but routes and payloads may change
  between 0.x releases.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Studio starts but generation never does | Is the runtime installed (`runtime/bin`)? Tail `data/server.log` (also in Settings). Re-run setup. |
| `Vulkan device not found` / init failure | Update GPU drivers; verify Vulkan with `vulkaninfo` if available. Software Vulkan (lavapipe) is not a practical fallback for generation. |
| `503` / `ServerBusyError` | The TTS server is busy with another request; the queue backs off and retries. Keep `concurrency` at 1. |
| First generation hangs ~30 s | Normal model load after a cold start. |
| ASR transcription fails | The model expects 16 kHz mono; the studio converts before sending. Check that the ASR GGUF is installed (run setup again without the skip-model flag). |
| Polish alignment looks empty/garbled | Alignment runs through an ASCII romanization workaround in the studio; make sure the transcript is accurate before aligning. |
| Export takes very long | The word check transcribes every part once. Cached verdicts make repeat exports much faster. |
| Disk growing | Chunk WAVs and `.prep*` caches are the usual suspects. Clear assembly caches in Settings; delete unused books/exports. |
| Port already in use | Change `port` (studio) or `managedPort` (TTS) in Settings and restart. |
| UI shows stale behavior | Rebuild the web bundle (`npm run build`) — the API serves `dist/web`. |

## License

MIT — see [LICENSE](LICENSE).

The studio is MIT-licensed; bundled/downloaded third-party components keep their own licenses:
audio.cpp is Apache-2.0, OmniVoice weights are Apache-2.0 (k2-fsa), and the ASR and aligner models
follow their upstream model cards (see `versions.json` for exact revisions). Sample books are public
domain; see [sample-books/LICENSES.md](sample-books/LICENSES.md).
