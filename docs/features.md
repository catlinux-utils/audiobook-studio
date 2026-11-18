# Features

## Library and ingest

- **EPUB** (spine order, cover extraction) and **TXT** ingest with multilingual chapter detection:
  `Rozdział` / `Chapter` / `Część` / `Tom` / `Księga`, roman numerals, `XXIV. TITLE`, and a bare
  numeral followed by the title on the next line
- **Pasted text** → a one-chapter book (up to ~200k characters), same pipeline as files
- Chapter text editing and re-splitting; per-chapter part-size override (the book default stays
  intact); "rechunk" keeps per-chapter overrides where possible
- The active section lists only books with work actually open (running/queued/paused jobs); cards
  show progress, failed-part counts and duration

## Parts (chunks)

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

## Voice cloning lab

- Waveform-based reference preparation with drag selection, denoise-before-trim, loudness
  normalization and A/B playback against the original; references are kept to ~20–60 s (the
  cloning payload is capped at ~3.5 MiB of WAV, roughly 70 s)
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

## Queue and generation

- Three job scopes: explicit part selection > chapter > book-wide; chapter jobs run FIFO one after
  another, and regeneration selections jump ahead as a priority queue
- Pause / resume / cancel with live SSE progress, per-part retry, and per-book ETA based on measured
  speed
- Automatic retries: degenerate or empty diffusion outputs are retried up to four times with
  deterministic bumped seeds, so takes stay reproducible
- Crash recovery: parts stuck in `generating` are returned to `pending` at startup
- Stats: speed factor (×realtime), compute time, wall time and ETA per job

## QA

- Word-level diff of the ASR transcript against the part text: missing / extra / variant words,
  WER, fuzzy matching, and digit ↔ spoken-number equivalence (`7` ↔ `siedem`)
- Verdicts are cached per part, keyed by audio duration, so exports and spot-checks are cheap after
  the first pass
- Random spot-check, per-part "check words", and an export-wide QA report (`.qa.txt`, viewable as a
  styled HTML page from the Exports page)

## Assembly and export

- **Continuity assembly**: edge-silence trim, loudness matching, micro-fades and pause
  normalization across independently generated parts (see [narration continuity](#narration-continuity))
- **`.m4b`** with real chapter markers and embedded cover art; only fully generated chapters are
  included, so a half-finished book exports the finished chapters
- **Per-chapter MP3** export
- **Compress for Discord**: re-encodes an export to a target size (default 20 MB) while keeping
  chapters, cover and the QA report
- Raw, lossless concat is still available by turning smoothing off in Settings

## Operations

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
