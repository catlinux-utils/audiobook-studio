# AGENTS.md — audiobook-studio

Local-first audiobook studio: ingest EPUB/TXT (or pasted text) → chunk → clone a voice via OmniVoice (audio.cpp on Vulkan) → word-level QA → export MP3/M4B with Discord-friendly compression. Windows machine, AMD GPU, **Vulkan only** (no CUDA/ROCm). No GitHub Actions; `setup.ps1` stays Windows-only.

## Stack

- **Server**: Node ≥ 26 (uses built-in `node:sqlite`), Fastify 5, TypeScript ESM (`.js` suffixes on relative imports — required by `NodeNext`).
- **Web**: React 19 + Vite 7 + Tailwind v4 (`web/`, built into `dist/web`, served by the server).
- **TTS runtime**: bundled audio.cpp server (managed child on port 8081) — models: `omnivoice` (synthesis), `asr` (CrisperWhisper, wants 16 kHz mono), `align` (Meta MMS forced aligner). Specs: `runtime/bin/model_specs/*.json`.

## Commands

```bash
npm run typecheck          # tsc for server (tsconfig.json) + web (tsconfig.web.json --noEmit)
npm run build              # tsc + vite build -> dist/
npm test                   # vitest run (tests/*.test.ts)
npm run dev                # server (tsx watch) + web (vite) concurrently
npm start                  # node dist/src/index.js  (studio on 127.0.0.1:8090)
```

After changing server code: rebuild (`npm run build`), kill the running instance (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` → match `dist/src/index.js` in CommandLine → `Stop-Process -Id <pid> -Force`), then `node dist/src/index.js > data/server.log 2>&1 &`. Web-only changes just need `npx vite build` (server serves `dist/web`).

## Layout

- `src/index.ts` — server entry; `src/config.ts` — settings (data/settings.json) + `paths.*`; `src/db.ts` — schema + numbered migrations (add new ones to the end of `MIGRATIONS`, never edit applied ones).
- `src/api/routes.ts` — every HTTP route (one big file, ~1400 lines). Register new endpoints here.
- `src/tts/queue.ts` — generation queue. Three job scopes: explicit chunk list (`job_chunks`) > chapter (`jobs.chapter_id`) > book-wide. FIFO chapter promotion; `refreshBookStatus()` is the **single writer** of book status — call it after anything that changes chunk states. `synthesizeChunk()` merges the voice's saved expert options (`voices.synth_options`) into every request; book-owned steps/guidance/speed win.
- `src/tts/audiocpp.ts` — audio.cpp client. Synthesis options go into `body.options` (snake_case). 503 → `ServerBusyError` (queue backs off).
- `src/tts/qa.ts` — word-check: transcribe generated audio, diff vs chunk text (missing/extra/variants/WER). Verdicts cached in `chunks.qa` keyed by duration; exports reuse the cache for `.qa.txt` reports.
- `src/tts/align.ts` + `src/text/romanize.ts` — MMS forced alignment. **Polish workaround**: `/v1/audio/alignments` is multipart-only in audio.cpp 0.9.5 and drops `text_normalization`, so non-Latin languages are aligned via `language='eng'` + pre-romanized ASCII text.
- `src/tts/voiceOptions.ts` — expert-option registry (12 OmniVoice options) + `sanitizeExpertOptions` whitelist + `expertOptionsToRequest` mapping. Server-side sanitization is the source of truth; `web/src/lib/expertOptions.ts` mirrors labels/min/max for the UI only.
- `src/audio/` — `assemble.ts` (chapter M4B/MP3 export), `voiceCleanup.ts` (ffmpeg filter chain for reference cleanup), `analyze.ts` (volumedetect/silencedetect parsers → cleanup suggestions), `wavmeta.ts`.
- `src/ingest/` — `epub.ts` (preserves paragraphs, `# ` heading markers), `txt.ts`, `chunker.ts` (paragraph-boundary-aware sentence packing; unit-tested — keep it pure).
- `web/src/pages/` — Library, BookDetail (chunks/queue/exports), Queue, Exports, Voices (+ CloneLab), VoiceExpert (per-voice bench at `/voices/:id/expert`), Settings. Shared atoms in `components/bits.tsx`; typed API client in `lib/api.ts`.
- `data/` — sqlite db, books, voices, voices-takes, exports, settings, server.log. Runtime state; never commit. Books/voices in `data/` are **the user's real data**.

## audio.cpp integration gotchas

- Synthesis: `POST /v1/audio/speech`, `response_format: 'wav'`, voice cloning via inline `voice_ref: {type:'base64'}` (≤ ~3.5 MiB WAV = ~70 s at 24 kHz mono s16le) + `reference_text`. Validated WAV responses (truncation check in audiocpp.ts).
- ASR (`/v1/audio/transcriptions`) takes a **server-local path** (JSON) or multipart; CrisperWhisper needs 16 kHz mono — convert with ffmpeg first.
- Alignments: multipart **only**; per-request option fields are dropped in 0.9.5 (see Polish workaround above).
- Degenerate outputs (empty/valid WAV) happen on unlucky seeds — the queue retries with a deterministic bumped seed (4 attempts).
- Managed server takes ~20–40 s per short take on the GPU. Sweeps/expert-runs are sequential; don't parallelize them.

## Conventions

- Pure logic (chunker, sanitizers, filter-chain builders, parsers) goes in separate modules with vitest coverage; routes stay thin.
- Server-side validation everywhere: client input is clamped/whitelisted (`sanitizeExpertOptions` pattern); Polish filenames need ASCII fallback + RFC 5987 `filename*` in Content-Disposition if a download is intended; **no** Content-Disposition for things that should render inline (QA report is served as minimal HTML — bare text/plain renders blank in some browsers).
- UI: dark zinc palette, small shared `Button`/`Panel` atoms, no modal libs. SSE via `bus.emit('event', …)` → `/api/events`; frontend re-fetches on events rather than websockets.
- Editing chunk/chapter text drops that audio and resets status (text no longer matches audio) — preserve this invariant in new features.

## Environment quirks (Git Bash on Windows)

- Shell PATH is flaky: prefix commands with
  `export PATH="/c/Program Files/nodejs:/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:/c/Windows/System32:$PATH"`.
- In `node -e "…"` strings, backslashes get mangled — use forward slashes in paths (`E:/audiobook-studio/...`).
- `/tmp` in bash ≠ what node sees; keep temp files under `data/` with forward-slash paths.

## Verification discipline

1. `npm run typecheck` then `npm test` (add/extend tests for any new pure module).
2. Rebuild web if UI changed; restart server if server changed.
3. E2E via curl against `127.0.0.1:8090` using **throwaway** books/voices (create → verify → delete); GPU-taking features (expert runs, sweeps, generation) count — verify one real run, then clean up. Never edit/delete the user's existing books, voices, takes, or exports without asking.
4. Check `data/server.log` after restarts.
