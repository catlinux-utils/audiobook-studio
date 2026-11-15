/**
 * Reference-audio analysis for expert mode: measure peak/mean loudness and
 * edge silence with ffmpeg (volumedetect / silencedetect), then turn the
 * measurements into suggested cleanup options. The parsers are pure so the
 * suggestion logic is unit-testable without spawning ffmpeg.
 */

import fs from 'node:fs';
import { runFfmpeg } from '../tts/qa.js';
import { readWavInfo } from './wavmeta.js';
import type { CleanupOptions } from './voiceCleanup.js';

export interface AudioAnalysis {
  durationSec: number;
  meanDb: number | null;
  peakDb: number | null;
  leadingSilenceSec: number;
  trailingSilenceSec: number;
}

export interface CleanupSuggestion {
  options: CleanupOptions;
  notes: string[];
}

/** Parse volumedetect stderr ("mean_volume: -18.2 dB", "max_volume: -1.0 dB"). */
export function parseVolumedetect(stderr: string): { meanDb: number | null; peakDb: number | null } {
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  return { meanDb: mean ? Number(mean[1]) : null, peakDb: peak ? Number(peak[1]) : null };
}

/**
 * Parse silencedetect stderr against the file duration. ffmpeg prints
 * "silence_start: X" / "silence_end: Y | silence_duration: Z"; a silence that
 * runs into EOF may have no end line.
 */
export function parseSilencedetect(stderr: string, durationSec: number): { leadingSilenceSec: number; trailingSilenceSec: number } {
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));

  let leadingSilenceSec = 0;
  if (starts.length > 0 && starts[0]! <= 0.15) {
    leadingSilenceSec = ends.length > 0 ? Math.min(ends[0]!, durationSec) : durationSec;
  }

  let trailingSilenceSec = 0;
  if (starts.length > ends.length) {
    // stream ended inside a silence region — the last start has no end line
    trailingSilenceSec = Math.max(0, durationSec - starts[starts.length - 1]!);
  } else if (ends.length > 0 && durationSec - ends[ends.length - 1]! <= 0.3) {
    // end printed at/near EOF
    trailingSilenceSec = Math.max(0, durationSec - ends[ends.length - 1]!);
  }
  return { leadingSilenceSec, trailingSilenceSec };
}

/** Turn measurements into concrete cleanup options + human-readable reasons. */
export function suggestCleanup(a: AudioAnalysis): CleanupSuggestion {
  const notes: string[] = [];
  const options: CleanupOptions = { trimSilence: true };

  if (a.leadingSilenceSec > 0.25) {
    options.start = Math.max(0, Math.round((a.leadingSilenceSec - 0.05) * 100) / 100);
    notes.push(`cut ${a.leadingSilenceSec.toFixed(2)} s of leading silence`);
  }
  if (a.trailingSilenceSec > 0.25) {
    options.end = Math.round((a.durationSec - a.trailingSilenceSec + 0.05) * 100) / 100;
    notes.push(`cut ${a.trailingSilenceSec.toFixed(2)} s of trailing silence`);
  }
  if (a.peakDb !== null && a.peakDb > -1.5) {
    options.loudnorm = true;
    notes.push(`peak ${a.peakDb.toFixed(1)} dBFS — very hot, normalize to -20 LUFS`);
  } else if (a.meanDb !== null && a.meanDb < -25) {
    options.loudnorm = true;
    notes.push(`mean level ${a.meanDb.toFixed(1)} dB — quiet recording, normalize to -20 LUFS`);
  }
  if (notes.length === 0) notes.push('reference looks clean — no changes suggested');
  return { options, notes };
}

/** Run both ffmpeg measurements against a WAV on disk. */
export async function analyzeWav(wavPath: string): Promise<AudioAnalysis> {
  const [vol, sil] = await Promise.all([
    runFfmpeg(['-y', '-i', wavPath, '-af', 'volumedetect', '-f', 'null', '-']),
    runFfmpeg(['-y', '-i', wavPath, '-af', 'silencedetect=noise=-45dB:d=0.25', '-f', 'null', '-']),
  ]);
  const durationMs = readWavInfo(fs.readFileSync(wavPath)).durationMs;
  const durationSec = durationMs / 1000;
  return {
    durationSec,
    ...parseVolumedetect(vol),
    ...parseSilencedetect(sil, durationSec),
  };
}
