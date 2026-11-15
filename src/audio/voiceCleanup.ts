/**
 * Reference-audio cleanup for expert mode: build a single ffmpeg filter chain
 * from adjustment options and apply it to a voice's reference WAV.
 *
 * Reuses the conventions of the /api/voices/prepare route (24 kHz mono s16le,
 * silence trim + loudnorm) but works on the existing reference instead of an
 * upload, and exposes more filters.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadSettings } from '../config.js';
import { readWavInfo } from './wavmeta.js';

export interface CleanupOptions {
  /** cut region (seconds); null = whole file */
  start?: number | null;
  end?: number | null;
  /** remove low-frequency rumble (Hz; 0/empty = off) */
  highpassHz?: number;
  /** remove hiss above (Hz; 0/empty = off) */
  lowpassHz?: number;
  /** ffmpeg afftdn noise reduction (0/empty = off) */
  denoiseStrength?: number;
  /** loudness-normalize to -20 LUFS (like prepare) */
  loudnorm?: boolean;
  /** even out dynamics */
  compressor?: boolean;
  /** static gain in dB (-20..20) */
  gainDb?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  /** trim leading/trailing silence */
  trimSilence?: boolean;
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Build the -af filter chain from cleanup options (pure, unit-testable).
 *  Fade-out is handled separately (needs the produced duration). */
export function buildCleanupFilters(o: CleanupOptions): string {
  const filters: string[] = [];
  if (o.trimSilence) filters.push('silenceremove=start_periods=1:start_threshold=-45dB');
  if (o.highpassHz && Number(o.highpassHz) > 0) filters.push(`highpass=f=${clamp(o.highpassHz, 20, 500, 80)}`);
  if (o.lowpassHz && Number(o.lowpassHz) > 0) filters.push(`lowpass=f=${clamp(o.lowpassHz, 4000, 20000, 12000)}`);
  if (o.denoiseStrength && Number(o.denoiseStrength) > 0) {
    filters.push(`afftdn=nr=${clamp(o.denoiseStrength, 1, 100, 12)}:nf=-25`);
  }
  if (o.loudnorm) filters.push('loudnorm=I=-20:TP=-1.5:LRA=7');
  if (o.compressor) filters.push('acompressor=threshold=0.089:ratio=4:attack=25:release=250');
  if (o.gainDb && Number(o.gainDb) !== 0) filters.push(`volume=${clamp(o.gainDb, -20, 20, 0)}dB`);
  if (o.fadeInSec && Number(o.fadeInSec) > 0) filters.push(`afade=t=in:st=0:d=${clamp(o.fadeInSec, 0.01, 5, 0.05)}`);
  return filters.join(',');
}

function runFfmpegRaw(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(loadSettings().ffmpegPath || 'ffmpeg', args, { windowsHide: true });
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

/** Max inline reference payload: ~3.5 MiB / 70 s at 24 kHz mono s16le. */
export const CLEANUP_MAX_BYTES = 3.5 * 1024 * 1024;

/**
 * Apply the cleanup chain to `sourceWav`, writing 24 kHz mono s16le to `outWav`.
 * The fade-out needs the produced duration, so it runs as a second pass.
 */
export async function applyVoiceCleanup(sourceWav: string, outWav: string, o: CleanupOptions): Promise<{ durationMs: number; sizeBytes: number }> {
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  const args: string[] = ['-y', '-i', sourceWav];
  if (o.end !== null && o.end !== undefined && Number(o.end) > Number(o.start ?? 0)) {
    args.push('-ss', String(o.start ?? 0), '-to', String(o.end));
  } else if (o.start && Number(o.start) > 0) {
    args.push('-ss', String(o.start));
  }
  const chain = buildCleanupFilters(o);
  if (chain) args.push('-af', chain);
  args.push('-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', outWav);
  await runFfmpegRaw(args);

  let info = readWavInfo(fs.readFileSync(outWav));
  if (o.fadeOutSec && Number(o.fadeOutSec) > 0 && info.durationMs > 500) {
    const d = clamp(o.fadeOutSec, 0.01, 5, 0.1);
    const st = Math.max(0, info.durationMs / 1000 - d);
    const fadeOut = path.join(path.dirname(outWav), path.basename(outWav, '.wav') + '-fade.wav');
    await runFfmpegRaw(['-y', '-i', outWav, '-af', `afade=t=out:st=${st.toFixed(3)}:d=${d}:curve=exp`, '-c:a', 'pcm_s16le', fadeOut]);
    fs.rmSync(outWav, { force: true });
    fs.renameSync(fadeOut, outWav);
    info = readWavInfo(fs.readFileSync(outWav));
  }

  if (info.durationMs < 250) throw new Error('cleanup produced almost no audio — check the cut region');
  if (fs.statSync(outWav).size > CLEANUP_MAX_BYTES) {
    throw new Error(`cleaned clip is ${Math.round(info.durationMs / 1000)} s — too long for the inline reference (max ~70 s); select a shorter region`);
  }
  return { durationMs: info.durationMs, sizeBytes: fs.statSync(outWav).size };
}
