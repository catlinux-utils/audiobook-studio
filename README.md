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

## Requirements

| Component | Requirement |
|---|---|
| **Node.js** | 22.13 or newer (built-in `node:sqlite`; tested on Node 26) |
| **ffmpeg** | 6.x+ on `PATH` with `libmp3lame`, `aac` and the MP4 muxer — or set the binary path in Settings |
| **GPU** | Vulkan-capable (AMD / Intel / NVIDIA) with current drivers |
| **Disk** | ~4 GB for the runtime and models, plus working space for audio and exports |
| **OS** | Windows 10/11 x64 or Linux x64 (setup scripts for both) |

A GPU is required for generation, voice tests, and all ASR/alignment work. A short take takes
roughly 20–40 s on the reference machine; a full novel is an overnight job, not a coffee break.

## Quick start

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
npm run build
npm start
```

Open **http://127.0.0.1:8090**. The studio spawns the bundled audio.cpp server on `:8081` and stops
it on shutdown; to use an audio.cpp instance you already run, switch **Settings → TTS mode** to
*external*. The first request after a cold start waits for the model to load.

The setup scripts pin audio.cpp 0.9.5, the OmniVoice weights and the ASR/aligner models, verify
them against `versions.json` and cache downloads in `runtime/downloads/`. For flags, the Nix flake,
Vulkan driver notes and the dev server, see **[docs/install.md](docs/install.md)**.

## First book

1. **Voices → add a voice.** Load a clean 20–60 s recording of the narrator (wav/mp3/m4a/ogg/flac),
   drag-select the best segment on the waveform, then run *prepare* (mono 24 kHz, loudness
   normalize, silence trim) and *transcribe*. The transcript must match the clip word for word —
   it is what makes cloning work.
2. **Library → add a book.** Drop an `.epub` or `.txt`, or paste text for a quick one-chapter
   book. Chapters and parts are detected on ingest.
3. **Book detail.** Assign the voice, adjust steps/guidance/speed/seed if you want, and hit
   **Generate**. Generation can be book-wide, per chapter, or for selected parts.
4. **Listen early.** Use the cut map and spot-check tools to catch bad splits or mispronunciations
   before you generate 10 hours of audio.
5. **Export.** `Export M4B` writes a chaptered file with cover art; chapters can also be exported
   as MP3. Every export gets a QA report next to it.

## What it does

- **Ingest** EPUB and TXT in spine order with Polish/English chapter detection, or paste text into
  a quick one-chapter book; edit chapters and re-split them without losing per-chapter overrides.
- **Sentence-aware parts** that respect abbreviations, decimals and dialogue dashes; edit,
  disable, bulk-toggle or regenerate any part, with a **cut map** for auditioning the seams.
- **Voice cloning lab**: waveform reference prep, ASR auto-transcript, MMS forced alignment with
  per-word timings, clone tests with QA, a 12-option expert bench, sweeps and a clone doctor.
- **Generation queue** with book-wide, chapter and selected-part scopes, pause/resume/cancel, live
  progress, deterministic retries and per-book ETA.
- **Word-level QA** (ASR diff: missing/extra/variant words, WER, digit ↔ spoken-number matching)
  cached per part, with spot checks and an export-wide report.
- **Continuity assembly**: edge trim, loudness matching, micro-fades and measured pauses, so
  independently generated parts join without audible seams.
- **Exports**: chaptered `.m4b` with cover art, per-chapter MP3, and a "compress for Discord"
  step that keeps chapters, cover and the QA report.
- **Local only**: loopback binding, no accounts, no telemetry; every knob lives in
  `data/settings.json` and the Settings page.

Deep detail — per-feature walkthroughs and the narration-continuity math — is in
**[docs/features.md](docs/features.md)**.

## Documentation

| Document | Contents |
|---|---|
| [docs/install.md](docs/install.md) | Requirements, setup flags, logs, Nix flake, development server |
| [docs/features.md](docs/features.md) | Full feature tour and narration continuity |
| [docs/configuration.md](docs/configuration.md) | Settings keys, `data/` layout, backups |
| [docs/architecture.md](docs/architecture.md) | Source layout, queue internals, build commands, HTTP API |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common failures, scope and limitations |

## License

MIT — see [LICENSE](LICENSE).

Bundled/downloaded third-party components keep their own licenses: audio.cpp is Apache-2.0,
OmniVoice weights are Apache-2.0 (k2-fsa), and the ASR and aligner models follow their upstream
model cards (see `versions.json` for exact revisions). Sample books are public domain; see
[sample-books/LICENSES.md](sample-books/LICENSES.md).
