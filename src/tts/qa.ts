/**
 * Word-completeness QA for generated takes.
 *
 * Diffusion TTS occasionally drops or garbles words ("polna trawa" heard as
 * "polnatkom", whole lines vanishing). We transcribe every take with the
 * bundled CrisperWhisper ASR and align it against the chunk text:
 *
 * - exact word match            → spoken
 * - close match (1-2 edits)     → variant (archaic spelling, inflection,
 *                                 ASR spelling choice — not a failure)
 * - no counterpart in the audio → missing  (this is what gates retries)
 * - audio word with no source   → extra (ASR noise / garble)
 *
 * The generation queue uses missingCount to re-roll the seed and keep the
 * best take, so word drops get caught automatically instead of by ear.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sameNumber } from '../text/numberWords.js';
import { loadSettings, paths } from '../config.js';
import { ttsBaseUrl } from './managed.js';
import { AudioCppClient } from './audiocpp.js';
import { spawn } from 'node:child_process';

export interface WordQa {
  transcript: string;
  /** consecutive unspoken words grouped into phrases, in reading order */
  missing: string[];
  /** heard words with no counterpart in the text */
  extra: string[];
  /** "text-word → heard-word" pairs matched within edit tolerance */
  variants: string[];
  sourceWords: number;
  /** (missing + extra) / source words; null for empty text */
  wer: number | null;
  /** text words with no spoken counterpart — the auto-retry gate */
  missingCount: number;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** Edit tolerance by word length: "wszytko"≈"wszystko" yes, "łątkom"≈"łączy" no. */
function editTolerance(word: string): number {
  if (word.length <= 3) return 0;
  if (word.length <= 6) return 1;
  return 2;
}

export function tokenizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Words as the ASR speaks them: verbatim markers ([UH], [lipsmack]) dropped,
 *  immediate stutter repeats collapsed ("l- l- ludziom" → "l ludziom"). */
function spokenWords(transcript: string): string[] {
  return tokenizeWords(transcript.replace(/\[[^\]]*\]/g, ' ')).filter((w, i, arr) => w !== arr[i - 1]);
}

/**
 * Weighted alignment of source words against heard words. Matching a pair
 * costs 0 (exact) / 0.4 (variant) / 1.4 (substitution — counts as missing);
 * skipping a source or heard word costs 1.0. Backtracked with positions so
 * phrases only group when adjacent in the audio stream.
 */
export function diffWordsFuzzy(sourceText: string, transcript: string): WordQa {
  const src = tokenizeWords(sourceText);
  const heard = spokenWords(transcript);
  const m = src.length;
  const n = heard.length;

  // pairwise classification cache
  const kind: number[][] = [];
  for (let i = 0; i < m; i++) {
    kind[i] = [];
    for (let j = 0; j < n; j++) {
      const d = levenshtein(src[i]!, heard[j]!);
      // digits match their spoken Polish number words exactly (7 ↔ siódmy)
      kind[i]![j] = d === 0 || sameNumber(src[i]!, heard[j]!) ? 0 : d <= editTolerance(src[i]!) ? 1 : 2;
    }
  }

  const INF = Number.MAX_SAFE_INTEGER / 4;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) dp[i]![0] = dp[i - 1]![0]! + 1.0;
  for (let j = 1; j <= n; j++) dp[0]![j] = dp[0]![j - 1]! + 0.9;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const pairCost = kind[i - 1]![j - 1] === 0 ? 0 : kind[i - 1]![j - 1] === 1 ? 0.4 : 1.4;
      dp[i]![j] = Math.min(
        dp[i - 1]![j - 1]! + pairCost,
        dp[i - 1]![j]! + 1.0, // source word not spoken → missing
        dp[i]![j - 1]! + 0.9, // heard word not in text → extra
      );
    }
  }

  const missingWords: string[] = [];
  const missingAt: number[] = [];
  const extraWords: string[] = [];
  const variants: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const k = kind[i - 1]![j - 1]!;
      const pairCost = k === 0 ? 0 : k === 1 ? 0.4 : 1.4;
      if (dp[i]![j] === dp[i - 1]![j - 1]! + pairCost) {
        if (k === 1) variants.push(`${src[i - 1]} → ${heard[j - 1]}`);
        if (k === 2) {
          missingWords.push(src[i - 1]!);
          missingAt.push(j - 1);
          extraWords.push(heard[j - 1]!);
        }
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && dp[i]![j] === dp[i - 1]![j]! + 1.0) {
      missingWords.push(src[i - 1]!);
      missingAt.push(j);
      i--;
      continue;
    }
    if (j > 0) {
      extraWords.push(heard[j - 1]!);
      j--;
      continue;
    }
    break;
  }
  missingWords.reverse();
  missingAt.reverse();
  extraWords.reverse();
  variants.reverse();

  const group = (ws: string[], anchors: number[]): string[] => {
    const out: string[] = [];
    let cur = '';
    for (let k = 0; k < ws.length; k++) {
      if (cur && anchors[k] !== anchors[k - 1]) {
        out.push(cur);
        cur = '';
      }
      cur = cur ? `${cur} ${ws[k]}` : ws[k]!;
    }
    if (cur) out.push(cur);
    return out;
  };

  return {
    transcript: transcript.trim(),
    missing: group(missingWords, missingAt),
    extra: extraWords,
    variants,
    sourceWords: m,
    wer: m > 0 ? Number(((missingWords.length + extraWords.length) / m).toFixed(3)) : null,
    missingCount: missingWords.length,
  };
}

/** Run ffmpeg with args, capturing stderr for error messages. */
export function runFfmpeg(args: string[]): Promise<string> {
  const s = loadSettings();
  return new Promise((resolve, reject) => {
    const child = spawn(s.ffmpegPath || 'ffmpeg', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => reject(new Error(`ffmpeg not available: ${err.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg failed: ${stderr.trim().split('\n').pop() ?? code}`)),
    );
  });
}

/** Transcribe a WAV file on disk via the managed CrisperWhisper ASR model. */
export async function transcribeWavFile(audioPath: string, language?: string): Promise<string> {
  const tmp16 = path.join(paths.data, `qa-${randomUUID()}-16k.wav`);
  try {
    // Whisper-family models want 16 kHz mono
    await runFfmpeg(['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmp16]);
    const client = new AudioCppClient(ttsBaseUrl(), 'asr');
    return await client.transcribe(tmp16, language || undefined);
  } finally {
    fs.rmSync(tmp16, { force: true });
  }
}

/** QA a generated take: transcribe the file and diff against its source text. */
export async function qaTake(audioPath: string, sourceText: string, language?: string): Promise<WordQa> {
  const transcript = await transcribeWavFile(audioPath, language);
  const diff = diffWordsFuzzy(sourceText, transcript);
  return { ...diff, transcript: transcript.trim() };
}
