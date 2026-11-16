import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths, loadSettings, type AppSettings } from '../config.js';
import { readWavInfo, readWavFileInfo } from './wavmeta.js';
import {
  adaptiveTrimThresholdDb,
  analyzePausesDb,
  applyContinuity,
  boundaryKind,
  buildContinuityFilters,
  edgeFadeSec,
  loudnessGainDb,
  measureWavMeanDbfs,
  measureWavNoiseFloorDbfs,
  type BoundaryChunk,
  type BoundaryKind,
} from './continuity.js';

/**
 * ffmpeg-based audio assembly: chunk WAVs → chapter WAV → chaptered .m4b.
 * audio.cpp returns 24 kHz mono PCM WAV; the concat demuxer copies streams
 * losslessly, then a single AAC encode produces the final book file.
 *
 * With assembly smoothing enabled (default), each chunk first goes through a
 * continuity prep pass (see continuity.ts): edge-silence trim, loudness match,
 * micro fades — cached under audio/.prep/ and keyed by source mtime — and
 * consistent pauses are inserted between chunks (longer at paragraph breaks,
 * shorter mid-sentence). Disabled → raw lossless concat as before.
 */

export interface AssemblyChunk extends BoundaryChunk {
  path: string;
}

export interface ChapterAudio {
  chapterId: string;
  title: string;
  chunks: AssemblyChunk[];
  durationMs: number;
}

function ffmpegPath(): string {
  return loadSettings().ffmpegPath || 'ffmpeg';
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => reject(new Error(`failed to spawn "${cmd}": ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').pop() ?? ''}`));
    });
  });
}

function concatList(files: string[]): string {
  // ffmpeg concat demuxer format; escape single quotes per its rules
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

/** Book's audio dir from any chunk path: data/books/<book>/chunks/x.wav → data/books/<book>/audio. */
function audioDirFor(chunkPath: string): string {
  return path.join(paths.books, path.basename(path.dirname(path.dirname(chunkPath))), 'audio');
}

function gapSettings(s: AppSettings): Record<BoundaryKind, number> {
  return { sentence: s.assemblyGapMs, paragraph: s.assemblyParagraphGapMs, soft: s.assemblySoftCutGapMs };
}

/** Continuity prep for one chunk (edge trim + pause normalization + loudness
 *  match + fades), cached by source mtime. Primary path is the pure-JS
 *  applyContinuity; the ffmpeg chain is the fallback for formats JS can't
 *  handle (no pause normalization there). */
async function prepChunk(src: string, srcBuf: Buffer, prepDir: string, targetPauseMs: number, settings: AppSettings): Promise<{ path: string } | null> {
  fs.mkdirSync(prepDir, { recursive: true });
  // target in the filename: changing the pause target invalidates the prep
  const prep = path.join(prepDir, `${targetPauseMs}-${path.basename(src)}`);
  try {
    const srcMtime = fs.statSync(src).mtimeMs;
    if (fs.existsSync(prep) && fs.statSync(prep).mtimeMs >= srcMtime) return { path: prep };
  } catch {
    return null; // source vanished — caller falls back and concat will error out clearly
  }

  const gainDb = loudnessGainDb(measureWavMeanDbfs(srcBuf));
  const floor = measureWavNoiseFloorDbfs(srcBuf);
  const target = targetPauseMs / 1000;
  const leadKeep = (target + 0.15) * 0.4;
  const tailKeep = (target + 0.15) * 0.6;
  const tmp = `${prep}.part`;
  try {
    // primary: pure-JS pass — edge trim, pause standardization (cap + extend),
    // loudness gain, micro fades
    const processed = applyContinuity(srcBuf, {
      targetPauseSec: target,
      thresholdDb: adaptiveTrimThresholdDb(floor),
      gainDb,
      leadKeepSec: leadKeep,
      tailKeepSec: tailKeep,
    });
    if (processed) {
      fs.writeFileSync(tmp, processed);
    } else {
      // fallback: ffmpeg chain for unsupported formats (no pause normalization)
      const chain = buildContinuityFilters({
        gainDb,
        trimSilence: true,
        thresholdDb: adaptiveTrimThresholdDb(floor),
        fadeSec: edgeFadeSec(floor),
        leadKeepSec: leadKeep,
        tailKeepSec: tailKeep,
      });
      // -f wav is explicit because the .part suffix is not a known extension
      await run(ffmpegPath(), ['-y', '-i', src, '-af', chain, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', tmp]);
    }
    fs.rmSync(prep, { force: true });
    fs.renameSync(tmp, prep);
    return { path: prep };
  } catch (err) {
    console.warn(`[assemble] continuity prep failed for ${path.basename(src)} — using raw chunk: ${err instanceof Error ? err.message : err}`);
    fs.rmSync(`${prep}.part`, { force: true });
    return null;
  }
}

/**
 * Join prepped chunks with full room-tone continuity: consecutive chunks are
 * crossfaded into each other, and every pause is filled with a looped slice
 * of the LEFT chunk's own tail room tone — the background continues through
 * pauses with the take's real noise character (no synthetic bed, no digital
 * silence). Mid-sentence (soft) joins get no pause at all, just a crossfade
 * that shortens the prosody hitch.
 */
async function assembleSmooth(
  out: string,
  items: string[],
  chunks: AssemblyChunk[],
  targetPauseMs: number,
  settings: AppSettings,
): Promise<void> {
  const args: string[] = ['-y'];
  for (const p of items) args.push('-i', p);
  if (items.length === 1) {
    args.push('-c', 'copy', out);
    await run(ffmpegPath(), args);
    return;
  }

  // geometry derived from the standard pause target so chunk joins and the
  // (already normalized) in-take pauses land on the same length:
  //   sentence join = tail keep + lead keep − crossfade = target
  //   paragraph join = target + the configured paragraph extra
  const target = targetPauseMs / 1000;
  const leadKeep = (target + 0.15) * 0.4;
  const tailKeep = (target + 0.15) * 0.6;
  const CROSSFADE_SEC = Math.min(0.15, leadKeep * 0.9); // ≤ both pads → never touches speech
  const SOFT_CROSSFADE_SEC = leadKeep + tailKeep - 0.15; // mid-sentence hitch ≈ 0.15 s
  const TAIL_SLICE_SEC = Math.max(0.25, tailKeep); // room-tone slice looped into the pause
  const paraExtraMs = Math.max(0, settings.assemblyParagraphGapMs - settings.assemblyGapMs);
  const boundaries = chunks.slice(0, -1).map((c, i) => {
    const kind = boundaryKind(c, chunks[i + 1]!);
    const gapMs = kind === 'paragraph' ? Math.max(0.05, paraExtraMs) : 0;
    return { kind, gapMs };
  });
  const durations = items.map((p) => readWavFileInfo(p).durationMs / 1000);

  const filters: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const fmt = 'aformat=sample_rates=24000:channel_layouts=mono';
    const hasGapAfter = i < items.length - 1 && boundaries[i]!.gapMs > 0;
    if (hasGapAfter) {
      // main stream for the join + tail slice as the pause filler
      filters.push(`[${i}:a]${fmt},asplit=2[s${i}M][s${i}T]`);
      const needSec = boundaries[i]!.gapMs / 1000 + 2 * CROSSFADE_SEC;
      const loops = Math.ceil(needSec / TAIL_SLICE_SEC);
      // slice taken from just BEFORE the crossfade overlap region so the
      // looped room tone never phase-doubles with the same content
      const sliceStart = Math.max(0, durations[i]! - TAIL_SLICE_SEC - CROSSFADE_SEC).toFixed(3);
      filters.push(
        `[s${i}T]atrim=start=${sliceStart}:duration=${TAIL_SLICE_SEC},` +
          `aloop=loop=${loops}:size=${Math.round(TAIL_SLICE_SEC * 24000)},` +
          `atrim=start=0:duration=${needSec.toFixed(3)}[s${i}G]`,
      );
    } else {
      filters.push(`[${i}:a]${fmt}[s${i}M]`);
    }
  }

  let prev = 's0M';
  for (let i = 0; i < items.length - 1; i++) {
    const b = boundaries[i]!;
    const merged = i < items.length - 2 ? `m${i}` : 'out';
    if (b.gapMs > 0) {
      // crossfade into the looped room tone, then out of it — both splices morph;
      // qsin curves keep the overlap power constant (no mid-fade dip)
      filters.push(`[${prev}][s${i}G]acrossfade=d=${CROSSFADE_SEC}:c1=qsin:c2=qsin[c${i}]`);
      filters.push(`[c${i}][s${i + 1}M]acrossfade=d=${CROSSFADE_SEC}:c1=qsin:c2=qsin[${merged}]`);
    } else {
      filters.push(`[${prev}][s${i + 1}M]acrossfade=d=${SOFT_CROSSFADE_SEC}:c1=qsin:c2=qsin[${merged}]`);
    }
    prev = merged;
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', out);
  if (process.env.ASSEMBLE_DEBUG) fs.writeFileSync('data/last-args.json', JSON.stringify(args));
  await run(ffmpegPath(), args);
}

/** Prep cache schema — bump when the smoothing algorithm changes so stale
 *  preps (old thresholds/fades) are never reused. */
const PREP_SCHEMA = 8;

/** Concatenate chunk WAVs into one chapter WAV. `targetPauseMs` pins the
 *  standard pause (per-voice override); without it the target is derived
 *  automatically from the chapter's own pause rhythm (median, clamped). */
export async function assembleChapter(
  chapterId: string,
  chunks: AssemblyChunk[],
  opts?: { targetPauseMs?: number },
): Promise<{ path: string; durationMs: number }> {
  if (chunks.length === 0) throw new Error('no chunks to assemble');
  const settings = loadSettings();
  const audioDir = audioDirFor(chunks[0]!.path);
  fs.mkdirSync(audioDir, { recursive: true });
  const out = path.join(audioDir, `${chapterId}.wav`);
  const listFile = `${out}.txt`;

  if (!settings.assemblySmooth) {
    // legacy raw lossless concat
    const files = chunks.map((c) => c.path);
    fs.writeFileSync(listFile, concatList(files), 'utf8');
    try {
      await run(ffmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out]);
    } finally {
      fs.rmSync(listFile, { force: true });
    }
    return { path: out, durationMs: readWavFileInfo(out).durationMs };
  }

  const prepDir = path.join(audioDir, `.prep-v${PREP_SCHEMA}`);
  // auto target: median of the chapter's own NATURAL speech pauses (clamped
  // to sane pacing); digital-silence dropouts are excluded — they are model
  // artifacts, not the narration's rhythm. Fewer than 2 natural pauses → no
  // trustworthy rhythm to learn from; fall back to the global gap setting.
  const bufs = new Map<string, Buffer>();
  const naturalPauses: number[] = [];
  for (const c of chunks) {
    try {
      const b = fs.readFileSync(c.path);
      bufs.set(c.path, b);
      const floor = measureWavNoiseFloorDbfs(b);
      if (floor !== null) {
        const pauses = analyzePausesDb(b, 150);
        if (pauses) for (const p of pauses) if (p.db > -60) naturalPauses.push(p.ms);
      }
    } catch {
      bufs.set(c.path, fs.readFileSync(c.path)); // let prepChunk surface the error
    }
  }
  let autoTarget: number | undefined;
  if (naturalPauses.length >= 2) {
    naturalPauses.sort((a, b) => a - b);
    autoTarget = naturalPauses[Math.floor(naturalPauses.length / 2)]!;
  }
  const targetPauseMs = Math.max(
    100,
    Math.min(2000, Math.round(opts?.targetPauseMs ?? autoTarget ?? settings.assemblyGapMs)),
  );

  const items: string[] = [];
  for (const c of chunks) {
    items.push((await prepChunk(c.path, bufs.get(c.path)!, prepDir, targetPauseMs, settings))?.path ?? c.path);
  }
  await assembleSmooth(out, items, chunks, targetPauseMs, settings);
  // exact duration (includes inserted pauses) — also what M4B chapter markers use
  return { path: out, durationMs: readWavFileInfo(out).durationMs };
}

export interface M4bExport {
  path: string;
  durationMs: number;
}

/** Build the final .m4b (AAC + chapter markers + optional cover). */
export async function exportM4b(
  bookId: string,
  meta: { title: string; author: string },
  chapters: ChapterAudio[],
  coverPath: string | null,
): Promise<M4bExport> {
  fs.mkdirSync(paths.exports, { recursive: true });
  const safe = meta.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || bookId;
  const out = path.join(paths.exports, `${safe}.m4b`);

  // 1. per-chapter WAVs (so chapter markers align exactly with chapter files)
  const assembled: Array<{ path: string; durationMs: number }> = [];
  for (const c of chapters) {
    assembled.push(await assembleChapter(c.chapterId, c.chunks));
  }

  // 2. ffmetadata chapter file with cumulative start/end
  let cursor = 0;
  const lines = [';FFMETADATA1', `title=${meta.title}`, `artist=${meta.author}`];
  chapters.forEach((c, i) => {
    const start = cursor;
    cursor += assembled[i]!.durationMs;
    lines.push('', '[CHAPTER]', `TIMEBASE=1/1000`, `START=${start}`, `END=${cursor}`, `title=${c.title}`);
  });
  const metaFile = path.join(paths.exports, `${bookId}.ffmeta.txt`);
  fs.writeFileSync(metaFile, lines.join('\n'), 'utf8');

  const concatFile = path.join(paths.exports, `${bookId}.concat.txt`);
  fs.writeFileSync(concatFile, concatList(assembled.map((a) => a.path)), 'utf8');

  try {
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-i', metaFile];
    if (coverPath) args.push('-i', coverPath);
    args.push('-map', '0:a');
    if (coverPath) args.push('-map', '2:v');
    args.push('-map_metadata', '1', '-map_chapters', '1', '-c:a', 'aac', '-b:a', '96k');
    if (coverPath) args.push('-c:v', 'mjpeg', '-disposition:v', 'attached_pic');
    args.push('-f', 'mp4', out);
    await run(ffmpegPath(), args);
  } finally {
    fs.rmSync(metaFile, { force: true });
    fs.rmSync(concatFile, { force: true });
  }

  const totalMs = assembled.reduce((acc, a) => acc + a.durationMs, 0);
  return { path: out, durationMs: totalMs };
}

/** Optional per-chapter MP3 export (128 kbit/s). */
export async function exportChapterMp3(sourceWav: string, outPath: string): Promise<void> {
  await run(ffmpegPath(), ['-y', '-i', sourceWav, '-codec:a', 'libmp3lame', '-b:a', '128k', outPath]);
}
