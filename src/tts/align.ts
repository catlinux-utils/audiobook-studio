/**
 * Forced alignment of a voice-reference transcript against its audio.
 *
 * The clone's quality is bounded by how exactly `reference_text` matches the
 * reference audio: OmniVoice conditions on the (text, audio) pair, so wrong
 * words in the transcript teach it wrong word→sound mappings and generation
 * then garbles or drops similar words. This module aligns every transcript
 * word to its exact position in the audio so the UI can play each word in
 * isolation and flag words that don't line up (ASR errors, untranscribed
 * noise, missing words).
 *
 * Model: Meta MMS-300M (1,130 languages) via /v1/audio/alignments, fed
 * pre-romanized ASCII for Polish (see text/romanize.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from '../config.js';
import { ttsBaseUrl } from './managed.js';
import { runFfmpeg } from './qa.js';
import { romanizeTokens, transcriptTokens } from '../text/romanize.js';

export interface AlignedWord {
  /** original (non-romanized) word from the transcript */
  text: string;
  /** seconds; start === end === -1 when the word could not be aligned */
  start: number;
  end: number;
  /** seconds of untranscribed audio before this word */
  gapBefore: number;
  /** alignment looks wrong (zero span, big gap, unaligned, out of order) */
  suspect: boolean;
  why: string;
}

export interface AlignmentResult {
  words: AlignedWord[];
  /** total audio duration in seconds */
  durationSec: number;
  /** fraction of audio covered by aligned words (0-1) */
  coverage: number;
  /** transcript tokens that the aligner could not place */
  unaligned: string[];
  /** true when no word overlaps its predecessor */
  ordered: boolean;
}

interface RawAlignWord {
  // audio.cpp returns word entries with timestamps in seconds and/or sample
  // offsets; accept the common spellings
  text?: string;
  word?: string;
  start?: number;
  end?: number;
  start_time?: number;
  end_time?: number;
  start_sample?: number;
  end_sample?: number;
  [k: string]: unknown;
}

/** POST /v1/audio/alignments (multipart upload) → raw word entries. */
async function callAlignments(wav16kPath: string, romanizedText: string): Promise<RawAlignWord[]> {
  const buf = fs.readFileSync(wav16kPath);
  const form = new FormData();
  form.append('model', 'align');
  // for this model the language field only selects TEXT NORMALIZATION; the
  // multipart route in audio.cpp 0.9.5 drops the text_normalization option
  // field, so we send pre-romanized ASCII and select its Latin path instead —
  // the acoustic model itself covers Polish (romanized) via MMS's 1,130 languages
  form.append('language', 'eng');
  form.append('text', romanizedText);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'ref.wav');
  const res = await fetch(`${ttsBaseUrl().replace(/\/+$/, '')}/v1/audio/alignments`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`alignments failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as Record<string, unknown>;
  const raw = data.words ?? data.alignments ?? data.segments ?? (Array.isArray(data) ? data : null);
  if (!Array.isArray(raw)) throw new Error('unexpected alignments response shape');
  return raw as RawAlignWord[];
}

function secondsOf(w: RawAlignWord, sampleRate: number): { start: number; end: number } {
  const start = w.start ?? w.start_time ?? (w.start_sample !== undefined ? w.start_sample / sampleRate : NaN);
  const end = w.end ?? w.end_time ?? (w.end_sample !== undefined ? w.end_sample / sampleRate : NaN);
  return { start: Number(start), end: Number(end) };
}

/**
 * Align `transcript` to the WAV at `wavPath`. Returns one entry per transcript
 * token with timestamps mapped back onto the original words.
 */
export async function alignTranscript(wavPath: string, transcript: string): Promise<AlignmentResult> {
  const tokens = transcriptTokens(transcript);
  if (tokens.length === 0) throw new Error('transcript is empty');
  const romanized = romanizeTokens(tokens);
  const romanizedText = romanized.join(' ');

  // aligners are CTC/w2v — 16 kHz mono
  const tmp16 = path.join(paths.data, `align-${randomUUID()}-16k.wav`);
  await runFfmpeg(['-y', '-i', wavPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmp16]);
  try {
    const raw = await callAlignments(tmp16, romanizedText);
    const durationSec = raw.length > 0 ? Math.max(...raw.map((w) => secondsOf(w, 16000).end)) : 0;

    // map aligned tokens back onto transcript tokens by order; when the
    // aligner returns fewer/more entries, best-effort by index
    const words: AlignedWord[] = [];
    const unaligned: string[] = [];
    let prevEnd = 0;
    let ordered = true;
    for (let i = 0; i < tokens.length; i++) {
      const w = raw[i];
      if (!w) {
        unaligned.push(tokens[i]!);
        words.push({ text: tokens[i]!, start: -1, end: -1, gapBefore: 0, suspect: true, why: 'no alignment' });
        continue;
      }
      const { start, end } = secondsOf(w, 16000);
      const gapBefore = Number.isFinite(start) ? Math.max(0, start - prevEnd) : 0;
      const why: string[] = [];
      if (!Number.isFinite(start) || !Number.isFinite(end)) why.push('no timestamps');
      else {
        if (start < prevEnd - 0.05) {
          why.push('overlaps previous word');
          ordered = false;
        }
        // single-letter words (i, w, z, a…) are often too short to measure —
        // only flag real words with a zero span
        if (end - start < 0.02 && tokens[i]!.length > 1) why.push('zero-length span');
        if (gapBefore > 1.0) why.push(`${gapBefore.toFixed(1)}s of untranscribed audio before this word`);
        prevEnd = Math.max(prevEnd, end);
      }
      words.push({
        text: tokens[i]!,
        start: Number.isFinite(start) ? start : -1,
        end: Number.isFinite(end) ? end : -1,
        gapBefore,
        suspect: why.length > 0,
        why: why.join('; '),
      });
    }
    if (raw.length > tokens.length) {
      unaligned.push(`(+${raw.length - tokens.length} aligner words beyond the transcript)`);
    }
    const covered = words.filter((w) => w.end > w.start).reduce((acc, w) => acc + (w.end - w.start), 0);
    return {
      words,
      durationSec,
      coverage: durationSec > 0 ? Math.min(1, covered / durationSec) : 0,
      unaligned,
      ordered,
    };
  } finally {
    fs.rmSync(tmp16, { force: true });
  }
}
