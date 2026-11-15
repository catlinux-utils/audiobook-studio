# Audiobook Studio

Self-hosted, standalone **ebook → audiobook** production studio with a full management WebUI.
It runs [audio.cpp](https://github.com/0xShug0/audio.cpp) with OmniVoice on **Vulkan** (no CUDA, no
ROCm, no PyTorch — installed and auto-started by the studio itself) and turns EPUB/TXT books into
chaptered **.m4b** audiobooks.

**Contents:** [How it works](#how-it-works) · [Install](#install) · [Usage](#usage) ·
[Features](#features) · [Architecture](#architecture) · [License](#license)

## How it works

```
EPUB/TXT ──▶ ingest ──▶ chapters ──▶ sentence-aware chunks ──▶ bundled audio.cpp (Vulkan, auto-started)
                                                                     │  POST /v1/audio/speech
                library · voices · queue · spot-check  ◀── WebUI ◀───┘  (WAV per chunk)
                                                                     │
                                      chunk WAVs ──▶ ffmpeg ──▶ chaptered .m4b (+cover)
```

**Standalone by default**: the studio ships a checksum-pinned installer for the audio.cpp Vulkan
runtime + OmniVoice model (`versions.json`) and **starts/manages the TTS server itself** as a child
process on port 8081. No CUDA, no ROCm, no PyTorch, no separate server to run — Vulkan comes with
your GPU driver. If you already operate an audio.cpp server elsewhere, switch to *external* mode in
Settings and point at it.

## Install

Requirements: Node 20+, ffmpeg on PATH, a Vulkan-capable GPU with current drivers, ~4 GB disk.

```powershell
# 1. TTS runtime (downloads audio.cpp + OmniVoice GGUF, checksum-verified)
powershell -ExecutionPolicy Bypass -File setup.ps1        # Linux: ./setup.sh

# 2. app
npm install
npm run seed        # optional: load the public-domain sample books (incl. a tiny Polish one)
npm run build
npm start           # studio on http://127.0.0.1:8090 — TTS server auto-starts on :8081
```

Development mode (hot reload, Vite dev server on :5173 proxying /api to :8090): `npm run dev`.

First run: add a **Voice** (a short WAV of the narrator + its transcript) in the Voices page,
assign it to a book, hit Generate.

## Usage

1. **Library → Add book** — drop an `.epub` or `.txt`. The parser detects chapters (EPUB spine /
   TXT heading heuristics incl. "Rozdział", "Chapter", roman numerals) and splits every chapter
   into sentence-aware chunks that respect OmniVoice's length limits.
2. **Book detail** — inspect detected chapters and chunks; assign a **voice**; tune steps /
   guidance / speed / seed / chunk size per book; hit **Generate**.
3. **Queue** — live progress per book with pause / resume / cancel; failed chunks keep their
   error messages and can be retried individually.
4. **Cut map** — every chapter has a visual segment map of its chunks; click a segment to jump
   into the continuous chapter audio exactly at a cut, or play any chunk in isolation. This is how
   you *hear where the text was split*.
5. **🎲 Spot-check** — pulls a random generated chunk with its text for quick quality sampling.
6. **♻ Regenerate** — any single chunk can be regenerated with a custom seed (A/B takes).
7. **⬇ Export M4B** — concatenates chunk WAVs, encodes AAC and writes real chapter markers +
   cover art into a single `.m4b` (stored in `data/exports/`).

## Features

- **Voice preparation studio**: load any audio (wav/mp3/m4a/ogg/flac), drag-select the cleanest
  segment on the waveform, prepare it (cut → mono 24 kHz → loudness normalize → silence trim) and
  **auto-transcribe** it with a bundled CrisperWhisper ASR model (Polish + 90 languages) — the
  transcript that makes cloning good, without typing it yourself
- EPUB (spine-ordered, cover extraction) and TXT ingest with multilingual chapter detection
- Sentence-aware chunker with Polish + English abbreviation handling (`prof.`, `itd.`, `J. K.`,
  decimals, dialogue dashes) — never cuts mid-sentence unless unavoidable, and flags soft cuts
- Per-book voice and synthesis parameters, deterministic seeding for reproducible takes
- Job queue: pause/resume/cancel, per-chunk retry, live SSE progress
- Generation stats: lifetime + per-book speed factor (×realtime), compute time, ETA
- QA tooling: random spot-check, cut map with click-to-seek, per-chunk regeneration
- One-command `.m4b` export with chapter markers + cover (ffmpeg)
- Bundled public-domain sample books (Polish + English) via `npm run seed`, incl. a 90-second
  Polish test book
- SQLite state (`node:sqlite`, zero native deps), restorable from `data/`

## Architecture

| Path | Contents |
|---|---|
| `setup.ps1` / `setup.sh` | Standalone TTS runtime installer (audio.cpp Vulkan + OmniVoice GGUF, checksum-verified) |
| `versions.json` | Pinned runtime/model versions, URLs, SHA-256 checksums — single source of truth |
| `src/` | Fastify server: `ingest/` (epub, txt, chunker), `tts/` (audio.cpp client, queue, managed server), `audio/` (wav headers, ffmpeg assembly), `api/` (REST + SSE) |
| `web/` | React 19 + Vite + Tailwind SPA (Library, Book detail, Voices, Queue, Settings) |
| `tests/` | Vitest unit tests (chunker edge cases) |
| `scripts/` | `seed.ts` (load sample books), `make_samples.py` (rebuild sample EPUBs) |
| `sample-books/` | Public-domain test books (see LICENSES.md) |
| `runtime/` | Installed audio.cpp binaries + OmniVoice GGUF (gitignored, from setup script) |
| `data/` | Runtime state: SQLite DB, per-book chunk WAVs, covers, exports (gitignored) |

API: every UI action is a plain REST call (`/api/books`, `/api/voices`, `/api/jobs`-style controls,
`/api/events` SSE) — the WebUI is a thin client, so the same pipeline is scriptable with curl.

## License

MIT — see [LICENSE](LICENSE). The studio downloads (checksum-verified) but does not modify third-party
software: audio.cpp is Apache-2.0 and OmniVoice weights are Apache-2.0 (k2-fsa). Sample books are
public domain ([LICENSES.md](sample-books/LICENSES.md)).
