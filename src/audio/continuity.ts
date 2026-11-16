/**
 * Continuity helpers for assembly: the math/filter-chain logic that makes
 * independently generated chunk takes play back as one continuous narration.
 *
 * Three seam cues in raw chunk concat, each addressed here:
 *  - irregular edge silence   → per-take trim keeping a small lead-in/tail pad
 *  - loudness drift per take  → static gain toward one fixed RMS target
 *  - hard sample cuts (clicks)→ micro fades on both edges
 * Plus consistent, context-aware pauses inserted between chunks (sentence /
 * paragraph / mid-sentence boundaries). Prosody resets at chunk starts are
 * inherent to chunked TTS; uniform pacing hides most of it.
 *
 * Pure (no fs/spawn) — the ffmpeg invocation lives in assemble.ts.
 */

import { readWavData } from './wavmeta.js';

/** Mean RMS level in dBFS of the PCM data of a WAV buffer.
 *  Returns null for non-16-bit-PCM formats or (near-)digital silence,
 *  which must not be amplified into noise-floor hiss. */
export function measureWavMeanDbfs(buf: Buffer, silenceFloorDbfs = -60): number | null {
  const wav = readWavData(buf);
  if (wav.bitsPerSample !== 16) return null;
  const samples = Math.floor(wav.dataBytes / 2);
  if (samples === 0) return null;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(wav.dataOffset + i * 2);
    sumSquares += v * v;
  }
  const meanSquare = sumSquares / samples;
  if (meanSquare <= 0) return null;
  const dbfs = 20 * Math.log10(Math.sqrt(meanSquare) / 32768);
  return dbfs <= silenceFloorDbfs ? null : dbfs;
}

/** Static gain (dB) that moves a chunk's mean RMS to `targetDbfs`,
 *  clamped so quiet noise floors are never boosted aggressively. */
export function loudnessGainDb(measuredDbfs: number | null, targetDbfs = -20, maxGainDb = 6): number {
  if (measuredDbfs === null) return 0;
  const gain = targetDbfs - measuredDbfs;
  return Math.round(Math.min(maxGainDb, Math.max(-maxGainDb, gain)) * 100) / 100;
}

export interface ContinuityProcessing {
  /** standard pause length — in-take pauses are normalized to it */
  targetPauseSec: number;
  /** pauses shorter than this are left untouched (breath/word gaps) */
  minPauseSec?: number;
  /** silence threshold in dB (adaptive, from the chunk's noise floor) */
  thresholdDb: number;
  /** static gain in dB (loudness match) */
  gainDb?: number;
  /** room tone kept before speech */
  leadKeepSec?: number;
  /** room tone kept after speech */
  tailKeepSec?: number;
  /** micro fade in/out (click removal); default 0.01 */
  fadeSec?: number;
}

/**
 * Full JS continuity prep for one chunk (s16le mono): edge trim, pause
 * normalization (long pauses shortened, short clear breaks extended — both
 * to `targetPauseSec`, filled with the pause's own audio so the character
 * never changes), loudness gain, micro fades. Returns null when the format
 * isn't supported (caller falls back to the ffmpeg chain).
 */
export function applyContinuity(buf: Buffer, o: ContinuityProcessing): Buffer | null {
  const wav = readWavData(buf);
  if (wav.bitsPerSample !== 16 || wav.channels !== 1) return null;
  const sr = wav.sampleRate;
  const total = Math.floor(wav.dataBytes / 2);
  if (total === 0) return null;

  const pcm = new Int16Array(total);
  for (let i = 0; i < total; i++) pcm[i] = buf.readInt16LE(wav.dataOffset + i * 2);

  const win = Math.max(1, Math.round(0.05 * sr));
  const nWin = Math.floor(total / win);
  const winDb = (i: number) => {
    let sum = 0;
    for (let j = i * win; j < (i + 1) * win; j++) { const v = pcm[j]!; sum += v * v; }
    const r = Math.sqrt(sum / win) / 32768;
    return r > 0 ? 20 * Math.log10(r) : -Infinity;
  };
  const quietWin = (i: number) => winDb(i) < o.thresholdDb;

  // output pieces: ranges into `pcm` or generated fill arrays; pieceFade[k]
  // holds the edge fades for pieces[k] (in at start, out at end) — applied
  // during assembly so a pause boundary is never a hard sample step (cut)
  const pieces: Int16Array[] = [];
  const pieceFade: Array<{ in: number; out: number }> = [];
  const NO_FADE = { in: 0, out: 0 };
  const edgeFade = Math.round(0.01 * sr);
  let pendingIn = 0; // fade-in owed by the next speech piece (after a pause)
  let cursor = 0; // sample index into pcm
  /** every output piece must have a matching pieceFade entry */
  const pushPiece = (p: Int16Array, f = NO_FADE) => { pieces.push(p); pieceFade.push(f); };

  const firstSpeechWin = (() => { for (let i = 0; i < nWin; i++) if (!quietWin(i)) return i; return -1; })();
  const lastSpeechWin = (() => { for (let i = nWin - 1; i >= 0; i--) if (!quietWin(i)) return i; return -1; })();
  if (firstSpeechWin < 0) return null; // (near-)digital silence — leave to QA

  const leadKeep = Math.round((o.leadKeepSec ?? 0.25) * sr);
  const tailKeep = Math.round((o.tailKeepSec ?? 0.3) * sr);
  const minPauseSamples = Math.round((o.minPauseSec ?? 0.2) * sr);
  const targetSamples = Math.round(o.targetPauseSec * sr);

  // Real room tone for filling digital-silence pauses: TTS models sometimes
  // emit exact zeros mid-take (dead air — no recording ever has that), so we
  // replace those pauses with the take's own quietest non-digital window.
  const DIGITAL_DB = -60;
  let toneWin = -1;
  let bestDb = Infinity;
  for (let w = 0; w < nWin; w++) {
    const db = winDb(w);
    if (db > DIGITAL_DB && db < bestDb) { bestDb = db; toneWin = w; }
  }
  const tone: Int16Array | null = toneWin >= 0 ? pcm.subarray(toneWin * win, Math.min(total, (toneWin + 1) * win)) : null;
  /** looped room-tone fill of exactly `n` samples, ~10 ms fades at the ends */
  const toneFill = (n: number): Int16Array | null => {
    if (!tone || tone.length === 0 || n <= 0) return null;
    const out = new Int16Array(n);
    for (let k = 0; k < n; k++) out[k] = tone[k % tone.length]!;
    const f = Math.min(Math.round(0.01 * sr), Math.floor(n / 4));
    for (let k = 0; k < f; k++) {
      out[k] = Math.round((out[k]! * k) / f);
      out[n - 1 - k] = Math.round((out[n - 1 - k]! * k) / f);
    }
    return out;
  };

  // leading silence: keep only leadKeep before speech
  const speechStart = firstSpeechWin * win;
  const leadStart = Math.max(0, speechStart - leadKeep);
  if (leadStart > cursor) { pushPiece(pcm.subarray(cursor, leadStart)); cursor = leadStart; }
  cursor = leadStart;
  let i = firstSpeechWin;
  while (i <= lastSpeechWin) {
    if (!quietWin(i)) { i++; continue; }
    const runStartWin = i;
    while (i <= lastSpeechWin && quietWin(i)) i++;
    const runEndWin = i; // exclusive
    const runStart = runStartWin * win;
    const runEnd = Math.min(total, runEndWin * win);
    const runLen = runEnd - runStart;
    // emit speech between cursor and this pause
    const speechIdx = pieces.length;
    pushPiece(pcm.subarray(cursor, runStart), { in: pendingIn, out: 0 });
    pendingIn = 0;
    // noise floor of the pause itself (loudest window in the run): near-digital
    // means the model dropped out — dead air must never reach the mix
    let runDbMax = -Infinity;
    for (let w = runStartWin; w < runEndWin; w++) runDbMax = Math.max(runDbMax, winDb(w));
    const digital = runDbMax <= DIGITAL_DB;
    const normalize = runLen >= minPauseSamples;
    const fadeN = Math.min(edgeFade, Math.max(1, Math.floor(targetSamples / 4)));
    if (normalize) {
      // fade the speech into the pause, and owe the next speech piece a
      // matching fade-in — a pause boundary must never be a hard step
      const sp = pieceFade[speechIdx]!;
      pieceFade[speechIdx] = { ...sp, out: fadeN };
      pendingIn = fadeN;
    }
    if (normalize && digital && toneFill(targetSamples)) {
      // model dropout: replace the whole dead-air run with the take's own
      // room tone at the standard target length (faded at both ends)
      pushPiece(toneFill(targetSamples)!);
    } else if (normalize) {
      // normalize to target, keeping the pause's natural head/tail so the
      // transitions into and out of it stay untouched
      const keepHead = Math.min(runLen, Math.floor(targetSamples / 2));
      if (runLen < targetSamples) {
        // too short → extend with the pause's own middle (character-exact fill)
        const fillNeed = targetSamples - runLen;
        const fillFrom = runStart + Math.floor(runLen * 0.25);
        const fillLen = Math.max(1, Math.floor(runLen * 0.5));
        pushPiece(pcm.subarray(runStart, runStart + keepHead));
        let filled = 0;
        while (filled < fillNeed) {
          const n = Math.min(fillLen, fillNeed - filled);
          pushPiece(pcm.subarray(fillFrom, fillFrom + n));
          filled += n;
        }
        pushPiece(pcm.subarray(runStart + keepHead, runEnd));
      } else {
        // too long → drop the middle
        const keepTail = Math.min(runLen - keepHead, targetSamples - keepHead);
        pushPiece(pcm.subarray(runStart, runStart + keepHead));
        pushPiece(pcm.subarray(runEnd - keepTail, runEnd));
      }
    } else {
      pushPiece(pcm.subarray(runStart, runEnd));
    }
    cursor = runEnd;
  }
  // trailing speech + silence: keep only tailKeep after speech
  const speechEnd = Math.min(total, (lastSpeechWin + 1) * win);
  const tailEnd = Math.min(total, speechEnd + tailKeep);
  if (tailEnd > cursor) pushPiece(pcm.subarray(cursor, tailEnd), { in: pendingIn, out: 0 });

  // assemble, apply gain, piece edge fades, outer edge fades
  const outLen = pieces.reduce((a, p) => a + p.length, 0);
  const gain = Math.pow(10, (o.gainDb ?? 0) / 20);
  const fade = Math.round((o.fadeSec ?? 0.01) * sr);
  const out = new Int16Array(outLen);
  let pos = 0;
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k]!;
    const f = pieceFade[k] ?? { in: 0, out: 0 };
    for (let j = 0; j < p.length; j++, pos++) {
      let g = gain;
      if (f.in > 0 && j < f.in) g *= j / f.in;
      if (f.out > 0 && j >= p.length - f.out) g *= (p.length - 1 - j) / f.out;
      const v = p[j]! * g;
      out[pos] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
  }
  for (let j = 0; j < fade && j < outLen; j++) {
    out[j] = Math.round(((out[j] ?? 0) * j) / fade);
    out[outLen - 1 - j] = Math.round(((out[outLen - 1 - j] ?? 0) * j) / fade);
  }
  return wrapPcmWav(out, sr);
}

/** Canonical 44-byte s16le mono WAV header around raw samples. */
function wrapPcmWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, 44 + i * 2);
  return out;
}

/** Approximate background-noise floor in dBFS: RMS over 50 ms windows,
 *  taking a low percentile so speech peaks are ignored. Returns null for
 *  non-16-bit formats or (near-)digital silence. */
export function measureWavNoiseFloorDbfs(buf: Buffer, windowMs = 50, percentile = 0.1, silenceFloorDbfs = -60): number | null {
  const wav = readWavData(buf);
  if (wav.bitsPerSample !== 16) return null;
  const total = Math.floor(wav.dataBytes / 2);
  const windowSamples = Math.max(1, Math.round((windowMs / 1000) * wav.sampleRate));
  const windows: number[] = [];
  for (let start = 0; start + windowSamples <= total; start += windowSamples) {
    let sumSquares = 0;
    for (let i = 0; i < windowSamples; i++) {
      const v = buf.readInt16LE(wav.dataOffset + (start + i) * 2);
      sumSquares += v * v;
    }
    windows.push(sumSquares / windowSamples);
  }
  if (windows.length === 0) return null;
  windows.sort((a, b) => a - b);
  const idx = Math.min(windows.length - 1, Math.max(0, Math.floor(windows.length * percentile)));
  const floor = windows[idx]!;
  if (floor <= 0) return null;
  const dbfs = 20 * Math.log10(Math.sqrt(floor) / 32768);
  return dbfs <= silenceFloorDbfs ? null : dbfs;
}

/** Silence-trim threshold that still fires when the chunk carries a noise
 *  floor (fixed −45 dB never triggers on noisy takes) while staying
 *  speech-safe: only slightly above the measured floor so soft word onsets
 *  (often −25…−35 dBFS) are never eaten as "silence". */
export function adaptiveTrimThresholdDb(floorDbfs: number | null): number {
  if (floorDbfs === null) return -45;
  return Math.round(Math.min(-35, Math.max(-55, floorDbfs + 5)));
}

/** Edge fade length: tiny click-removal fade only — the background must NOT
 *  ramp down at chunk edges; pause continuity comes from the room-tone bed. */
export function edgeFadeSec(_floorDbfs?: number | null): number {
  return 0.01;
}



export interface ContinuityOptions {
  /** static gain in dB (loudness match); 0/undefined = off */
  gainDb?: number;
  /** trim leading/trailing silence (keeping small padding) */
  trimSilence?: boolean;
  /** micro fade in/out seconds (click removal); 0/undefined = off */
  fadeSec?: number;
  /** silence threshold in dB (default −45, like voiceCleanup) */
  thresholdDb?: number;
  /** seconds of quiet kept before speech (default 0.06) */
  leadKeepSec?: number;
  /** seconds of quiet kept after speech (default 0.12) */
  tailKeepSec?: number;
}

/** Build the -af chain for one chunk's continuity prep (pure, unit-testable).
 *  Fallback path only — the primary prep is the pure-JS applyContinuity.
 *  Fade-out uses the areverse trick — no duration knowledge needed. */
export function buildContinuityFilters(o: ContinuityOptions): string {
  const filters: string[] = [];
  const gain = Number(o.gainDb ?? 0);
  if (Number.isFinite(gain) && gain !== 0) filters.push(`volume=${gain.toFixed(2)}dB`);
  if (o.trimSilence) {
    const th = `${o.thresholdDb ?? -45}dB`;
    const lead = o.leadKeepSec ?? 0.06;
    const tail = o.tailKeepSec ?? 0.12;
    filters.push(`silenceremove=start_periods=1:start_threshold=${th}:start_silence=${lead}`);
    filters.push(`areverse,silenceremove=start_periods=1:start_threshold=${th}:start_silence=${tail},areverse`);
  }
  const fade = Number(o.fadeSec ?? 0);
  if (Number.isFinite(fade) && fade > 0) {
    filters.push(`afade=t=in:st=0:d=${fade}`);
    filters.push(`areverse,afade=t=in:st=0:d=${fade},areverse`);
  }
  return filters.join(',');
}

/** Detected speech pauses (ms) in a chunk, using a −45 dB threshold — used to
 *  auto-derive the chapter's standard pause from the narration's own rhythm.
 *  Returns null for unsupported formats. */
export function analyzePauses(buf: Buffer, minPauseMs = 150): number[] | null {
  const info = analyzePausesDb(buf, minPauseMs);
  return info ? info.map((p) => p.ms) : null;
}

/** Like analyzePauses but also reports each pause's noise floor (the loudest
 *  50 ms window inside it, dBFS). A floor below −55 dB means the model
 *  emitted digital silence — such pauses are dropouts, not the narration's
 *  natural rhythm, and must not drive the auto pause target. */
export function analyzePausesDb(buf: Buffer, minPauseMs = 150): Array<{ ms: number; db: number }> | null {
  const wav = readWavData(buf);
  if (wav.bitsPerSample !== 16 || wav.channels !== 1) return null;
  const sr = wav.sampleRate;
  const total = Math.floor(wav.dataBytes / 2);
  const win = Math.max(1, Math.round(0.05 * sr));
  const nWin = Math.floor(total / win);
  const out: Array<{ ms: number; db: number }> = [];
  let run = 0;
  let runDbMax = -Infinity;
  for (let i = 0; i < nWin; i++) {
    let sum = 0;
    for (let j = 0; j < win; j++) { const v = buf.readInt16LE(wav.dataOffset + (i * win + j) * 2); sum += v * v; }
    const r = Math.sqrt(sum / win) / 32768;
    const db = r <= 0 ? -Infinity : 20 * Math.log10(r);
    const quiet = db < -45;
    if (quiet) { run++; runDbMax = Math.max(runDbMax, db); }
    else {
      if (run * 50 >= minPauseMs) out.push({ ms: run * 50, db: runDbMax });
      run = 0;
      runDbMax = -Infinity;
    }
  }
  if (run * 50 >= minPauseMs) out.push({ ms: run * 50, db: runDbMax });
  return out;
}

/** How the seam between two adjacent chunks should sound. */
export type BoundaryKind = 'paragraph' | 'sentence' | 'soft';

export interface BoundaryChunk {
  text?: string;
  charStart?: number;
  charEnd?: number;
}

/**
 * Classify the boundary before `next` from chunk rows alone.
 *  - paragraph: the chunker leaves exactly the '\n\n' separator between
 *    spans (any char gap ≥ 2), so a span gap means a paragraph break;
 *  - soft: previous chunk ends mid-sentence (no terminal punctuation —
 *    mirrors the chunker's softCut flag);
 *  - sentence: everything else (adjacent sentence spans).
 */
export function boundaryKind(prev: BoundaryChunk, next?: BoundaryChunk): BoundaryKind {
  if (
    next &&
    Number.isFinite(prev.charEnd) &&
    Number.isFinite(next.charStart) &&
    (next.charStart as number) - (prev.charEnd as number) >= 2
  ) {
    return 'paragraph';
  }
  const text = (prev.text ?? '').trimEnd();
  if (!/[.!?…]["'”’»)\]]*$/.test(text)) return 'soft';
  return 'sentence';
}

export interface AssemblyGaps {
  sentence: number;
  paragraph: number;
  soft: number;
}

export function gapFor(kind: BoundaryKind, gaps: AssemblyGaps): number {
  return gaps[kind];
}

/** Canonical 44-byte-header s16le mono silence WAV, so inserted pauses match
 *  the prepped chunks' format exactly (concat -c copy stays lossless). */
export function silenceWav(ms: number, sampleRate = 24000): Buffer {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('silence duration must be > 0');
  const samples = Math.max(1, Math.round((ms / 1000) * sampleRate));
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}
