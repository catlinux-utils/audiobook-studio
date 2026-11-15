import { describe, expect, it } from 'vitest';
import { parseVolumedetect, parseSilencedetect, suggestCleanup } from '../src/audio/analyze.js';

const VOLUMEDTECT_OUT = `
[Parsed_volumedetect_0 @ 0x0] mean_volume: -19.2 dB
[Parsed_volumedetect_0 @ 0x0] max_volume: -1.4 dB
`;

describe('parseVolumedetect', () => {
  it('extracts mean and peak levels', () => {
    expect(parseVolumedetect(VOLUMEDTECT_OUT)).toEqual({ meanDb: -19.2, peakDb: -1.4 });
  });

  it('returns nulls for empty output', () => {
    expect(parseVolumedetect('')).toEqual({ meanDb: null, peakDb: null });
  });
});

describe('parseSilencedetect', () => {
  it('detects leading silence with an end line', () => {
    const out = 'silence_start: 0\nsilence_end: 0.42 | silence_duration: 0.42\n';
    expect(parseSilencedetect(out, 12)).toEqual({ leadingSilenceSec: 0.42, trailingSilenceSec: 0 });
  });

  it('detects trailing silence when the stream ends inside it (no end line)', () => {
    const out = 'silence_start: 11.3\n';
    const r = parseSilencedetect(out, 12);
    expect(r.leadingSilenceSec).toBe(0);
    expect(r.trailingSilenceSec).toBeCloseTo(0.7, 5);
  });

  it('detects trailing silence printed at EOF', () => {
    const out = 'silence_start: 11.5\nsilence_end: 12 | silence_duration: 0.5\n';
    const r = parseSilencedetect(out, 12);
    expect(r.leadingSilenceSec).toBe(0);
    expect(r.trailingSilenceSec).toBeCloseTo(0, 5);
  });

  it('ignores mid-file silence', () => {
    const out = 'silence_start: 3\nsilence_end: 3.6 | silence_duration: 0.6\nsilence_start: 7\nsilence_end: 7.2 | silence_duration: 0.2\n';
    expect(parseSilencedetect(out, 12)).toEqual({ leadingSilenceSec: 0, trailingSilenceSec: 0 });
  });

  it('handles both edges at once', () => {
    const out = 'silence_start: -0.01\nsilence_end: 0.8 | silence_duration: 0.81\nspeech...\nsilence_start: 11.0\n';
    const r = parseSilencedetect(out, 12);
    expect(r.leadingSilenceSec).toBeCloseTo(0.8, 5);
    expect(r.trailingSilenceSec).toBeCloseTo(1.0, 5);
  });
});

describe('suggestCleanup', () => {
  it('suggests nothing for a clean reference', () => {
    const s = suggestCleanup({ durationSec: 12, meanDb: -20, peakDb: -3, leadingSilenceSec: 0.05, trailingSilenceSec: 0.1 });
    expect(s.options).toEqual({ trimSilence: true });
    expect(s.notes).toEqual(['reference looks clean — no changes suggested']);
  });

  it('cuts measured edge silence', () => {
    const s = suggestCleanup({ durationSec: 12, meanDb: -20, peakDb: -3, leadingSilenceSec: 0.5, trailingSilenceSec: 0.9 });
    expect(s.options.start).toBeCloseTo(0.45, 5);
    expect(s.options.end).toBeCloseTo(11.15, 5);
    expect(s.notes.some((n) => n.includes('leading silence'))).toBe(true);
    expect(s.notes.some((n) => n.includes('trailing silence'))).toBe(true);
  });

  it('normalizes a hot recording', () => {
    const s = suggestCleanup({ durationSec: 12, meanDb: -8, peakDb: -0.2, leadingSilenceSec: 0, trailingSilenceSec: 0 });
    expect(s.options.loudnorm).toBe(true);
    expect(s.notes.some((n) => n.includes('peak'))).toBe(true);
  });

  it('normalizes a quiet recording', () => {
    const s = suggestCleanup({ durationSec: 12, meanDb: -31, peakDb: -12, leadingSilenceSec: 0, trailingSilenceSec: 0 });
    expect(s.options.loudnorm).toBe(true);
    expect(s.notes.some((n) => n.includes('quiet'))).toBe(true);
  });

  it('combines everything in one suggestion', () => {
    const s = suggestCleanup({ durationSec: 20, meanDb: -30, peakDb: -0.5, leadingSilenceSec: 0.6, trailingSilenceSec: 1.2 });
    expect(s.options.start).toBeCloseTo(0.55, 5);
    expect(s.options.end).toBeCloseTo(18.85, 5);
    expect(s.options.loudnorm).toBe(true);
    expect(s.options.trimSilence).toBe(true);
    expect(s.notes).toHaveLength(3);
  });
});
