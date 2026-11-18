# AGENTS.md — audiobook-studio

Local-first audiobook studio: ingest EPUB/TXT (or pasted text) → chunk → clone a voice via OmniVoice (audio.cpp on Vulkan) → word-level QA → export MP3/M4B with Discord-friendly compression. Windows machine, AMD GPU, **Vulkan only** (no CUDA/ROCm). No CI; `setup.ps1` (Windows) and `setup.sh` (Linux) install the pinned runtime.

The server is the source of truth; the React SPA is a thin REST client. README.md is the user-facing entry point and `docs/` holds the detailed manual (install, features, configuration, architecture/API, troubleshooting) — keep this file focused on how to change the code safely.

## Stack and entry points

- **Server**: Node ≥ 22.13 (`engines`; uses built-in `node:sqlite`, tested on Node 26), Fastify 5, TypeScript ESM. `tsconfig.json` is `NodeNext`: relative imports **must** end in `.js`.
- **Web**: React 19 + Vite 7 + Tailwind v4 in `web/`; built to `dist/web` and served by Fastify on one port. Dev server on :5173 proxies `/api` to :8090.
- **TTS runtime**: bundled audio.cpp child process on 127.0.0.1:8081 (`src/tts/managed.ts`) — models `omnivoice` (synthesis), `asr` (CrisperWhisper, 16 kHz mono input), `align` (Meta MMS forced aligner). Model specs: `runtime/bin/model_specs/*.json`. External mode points at `audiocppUrl` instead (default `http://127.0.0.1:8080`).
- **Default ports**: studio `8090` (loopback only), managed TTS `8081`, Vite `5173`.

## Commands

```bash
npm run dev        # API (tsx watch, :8090) + Vite (:5173, proxies /api)
npm run typecheck  # tsc server (tsconfig.json) + web (tsconfig.web.json --noEmit)
npm test           # vitest run — tests/**/*.test.ts
npm run build      # tsc + vite build -> dist/ (server + dist/web)
npm start          # node dist/src/index.js
npm run seed       # load sample-books/ into the local DB
```

Server/code changes: `npm run build`, stop the running instance, restart with its output captured, then check `data/server.log`:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'"   # match dist/src/index.js in CommandLine
Stop-Process -Id <pid> -Force
```

`node dist/src/index.js > data/server.log 2>&1 &` (Git Bash). Web-only changes need just `npx vite build`; the server serves `dist/web`, so if the UI looks stale the bundle was not rebuilt.

## Layout

- `src/index.ts` — Fastify bootstrap: multipart, static SPA + SPA fallback, routes, managed-TTS lifecycle, SIGINT/SIGTERM shutdown.
- `src/config.ts` — `AppSettings` + defaults, `paths.*`, `data/settings.json` load/save (every write re-serializes; hand-edits allowed). `AUDIOBOOK_STUDIO_HOME` overrides the project root (Nix wrapper uses it to keep state outside the read-only store).
- `src/db.ts` — `DatabaseSync` (WAL, foreign keys), schema types, numbered `MIGRATIONS`. **Append new migrations at the end; never edit an applied one.** Migrations run transactionally on startup.
- `src/bus.ts` — process-wide `EventEmitter` (`chunk.update`, `job.update`, `book.update`, `voices.update`) feeding SSE `/api/events`. UI always re-fetches; no websockets.
- `src/api/routes.ts` — `registerRoutes()`, one file (~1770 lines) holding every HTTP route plus a few local helpers (`clampInt`/`clampNum`, QA cache/report writers, rechunk helpers). Keep handlers thin; register new endpoints here.
- `src/tts/queue.ts` — generation queue (see invariant below). `src/tts/audiocpp.ts` — audio.cpp HTTP client (`ServerBusyError` on 503). `src/tts/managed.ts` — spawns/restarts the bundled server, writes `runtime/server.json`, `ttsBaseUrl()`.
- `src/tts/qa.ts` — word check: ASR transcribe → fuzzy diff vs chunk text (missing/extra/variants/WER/`missingCount`). `runFfmpeg`/`transcribeWavFile`/`qaTake`.
- `src/tts/align.ts` + `src/text/romanize.ts` — MMS forced alignment. **Polish workaround**: `/v1/audio/alignments` is multipart-only in audio.cpp 0.9.5 and drops `text_normalization`, so non-Latin languages align via `language='eng'` + pre-romanized ASCII text.
- `src/tts/voiceOptions.ts` — 12-option expert registry, `sanitizeExpertOptions` whitelist/clamps, `expertOptionsToRequest` (snake_case → `body.options`). Server-side sanitization is authoritative; `web/src/lib/expertOptions.ts` only mirrors labels/min/max for the UI.
- `src/audio/continuity.ts` — pure seam math (edge trim, pause analysis/normalization, loudness gain, fades, boundary classification). `assemble.ts` — ffmpeg chapter WAV/M4B/MP3 assembly, `.prep-v8` cache keyed by source mtime + pause target. `voiceCleanup.ts` — filter chains. `analyze.ts` — volumedetect/silencedetect parsers. `wavmeta.ts` — WAV headers/durations.
- `src/ingest/epub.ts` (paragraphs, `# ` heading markers, cover), `txt.ts`, `chunker.ts` (sentence packing, char offsets, `softCut`; pure and tested — keep it that way).
- `src/text/speakable.ts` — ALL-CAPS heading normalization for synthesis only (stored text is never changed). `numberWords.ts` — digit ↔ Polish number-word equivalence for QA.
- `web/src/pages/` — Library, BookDetail (chunks/queue/exports/cut map), Queue, Exports, Voices (prep + clone lab), VoiceExpert (`/voices/:id/expert`), Settings. `components/bits.tsx` — shared atoms; `lib/api.ts` — typed client; `lib/expertOptions.ts` — UI metadata.
- `tests/` — vitest for the pure modules: `chunker`, `continuity`, `numberWords`, `speakable`, `txtSplit`, `voiceAnalyze`, `voiceCleanup`, `voiceOptions`.
- `data/` — sqlite DB (`studio.db`), `settings.json`, books/voices/voices-takes/exports, `server.log`. Runtime state, gitignored, **never commit**. Existing books/voices/takes/exports are **the user's real data** — don't modify or delete them without asking.

## Queue invariants (`src/tts/queue.ts`)

- Three job scopes, descending precedence: explicit chunk list (`job_chunks`) > chapter (`jobs.chapter_id`) > book-wide. Chapter jobs run FIFO as the worker frees up; single-chunk regenerations (`regenQueue`, with optional seed) preempt job claiming.
- `refreshBookStatus()` is the **single writer** of `books.status` — call it after anything that changes chunk states. Book status is derived, never set ad hoc.
- Crash recovery at startup: `generating` chunks → `pending`; `running`/`queued` jobs and their books → `paused` (resume is an explicit user action). Parts disabled via `chunks.disabled=1` are excluded from queueing and exports.
- `synthesizeChunk()` merges the voice's saved `synth_options` into every request; book-owned `num_inference_steps`/`guidance_scale`/`speed`/seed win. Speech text goes through `speakableCase()`; chapter text is untouched.
- Degenerate/empty diffusion output is retried up to **4 attempts** with deterministic bumped seeds (reproducible takes).
- Pause finishes the in-flight chunk then stops claiming; cancel keeps completed audio and closes the job.

## audio.cpp integration gotchas

- Synthesis: `POST /v1/audio/speech` with `response_format: 'wav'`; cloning via inline `voice_ref: {type:'base64', data}` + `reference_text`. audio.cpp documents ≤5 MiB for the payload; keep references ~20–60 s (≈3.5 MiB at 24 kHz mono s16le). Responses are validated (WAV truncation check in `audiocpp.ts`).
- ASR (`POST /v1/audio/transcriptions`) accepts a **server-local path** (JSON) or multipart; CrisperWhisper needs 16 kHz mono — convert with ffmpeg first.
- Alignments are multipart **only** in 0.9.5; per-request option fields (including `text_normalization`) are dropped — hence the Polish romanization workaround.
- HTTP 503 means the server is busy → `ServerBusyError`; the queue backs off and retries. Keep `concurrency` at 1.
- A short take takes ~20–40 s on the GPU; model load after a cold start adds ~30 s. Expert runs, sweeps and clone-doctor runs are **sequential** — never parallelize them.
- WAV in is 24 kHz mono s16le; assembly relies on that format for lossless concat.

## Conventions

- Pure logic (chunker, sanitizers, filter-chain/continuity math, parsers) → separate module + vitest coverage; routes stay thin. Add/extend a test when you add pure logic.
- Validate and clamp **every** client input server-side (`sanitizeExpertOptions` / `clampInt` / `clampNum` pattern). Never trust the client.
- Editing chunk/chapter text drops that audio and resets the chunk to `pending` (text no longer matches audio). Preserve this invariant in any new feature; re-chunking must keep per-chapter size overrides where possible.
- Downloads: ASCII fallback filename + RFC 5987 `filename*` in `Content-Disposition` (Polish titles). **No** `Content-Disposition` for anything meant to render inline — the QA report is served as minimal HTML because bare `text/plain` renders blank in some browsers.
- SSE via `bus.emit('event', …)` → `/api/events`; emit small status snapshots and let the frontend re-fetch authoritative state.
- UI: dark zinc palette, shared `Button`/`Panel`/`Card` atoms in `components/bits.tsx`, no modal libraries, no state-management dependency.

## Environment quirks (Git Bash on Windows)

- Shell PATH is flaky; prefix commands with:
  `export PATH="/c/Program Files/nodejs:/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:/c/Windows/System32:$PATH"`
- `node -e "…"` mangles backslashes — use forward slashes (`E:/audiobook-studio/...`).
- `/tmp` in bash ≠ what node sees; keep temp files under `data/` with forward-slash paths.
- `runtime/` and `data/` are gitignored; re-running setup is safe (artifacts cached in `runtime/downloads/`, verified against `versions.json` checksums).

## Verification discipline

1. `npm run typecheck`, then `npm test`. Add/extend tests for new pure modules.
2. Rebuild web if the UI changed; rebuild and restart the server if server code changed. Check `data/server.log` after the restart.
3. E2E via `curl` against `127.0.0.1:8090` using **throwaway** books/voices (create → verify → delete). GPU-taking paths (generation, expert runs, sweeps, ASR/alignment) are expensive: verify one real run, then clean up. Never touch the user's existing books, voices, takes or exports without asking.
4. Report what was actually run. A passing typecheck is not proof the UI renders; say so if you did not look at it.
