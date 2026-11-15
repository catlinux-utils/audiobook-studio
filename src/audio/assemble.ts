import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths, loadSettings } from '../config.js';
import { readWavInfo } from './wavmeta.js';

/**
 * ffmpeg-based audio assembly: chunk WAVs → chapter WAV → chaptered .m4b.
 * audio.cpp returns 24 kHz mono PCM WAV; the concat demuxer copies streams
 * losslessly, then a single AAC encode produces the final book file.
 */

export interface ChapterAudio {
  chapterId: string;
  title: string;
  chunkPaths: string[];
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

/** Concatenate chunk WAVs into one chapter WAV (lossless stream copy). */
export async function assembleChapter(chapterId: string, chunkPaths: string[]): Promise<{ path: string; durationMs: number }> {
  if (chunkPaths.length === 0) throw new Error('no chunks to assemble');
  const dir = path.join(paths.books, path.basename(path.dirname(path.dirname(chunkPaths[0]!))), 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${chapterId}.wav`);
  const listFile = `${out}.txt`;
  fs.writeFileSync(listFile, concatList(chunkPaths), 'utf8');
  try {
    await run(ffmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out]);
  } finally {
    fs.rmSync(listFile, { force: true });
  }
  const durationMs = chunkPaths.reduce((acc, p) => acc + readWavInfo(fs.readFileSync(p)).durationMs, 0);
  return { path: out, durationMs };
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
    assembled.push(await assembleChapter(c.chapterId, c.chunkPaths));
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
