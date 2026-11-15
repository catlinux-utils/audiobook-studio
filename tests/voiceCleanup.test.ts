import { describe, expect, it } from 'vitest';
import { buildCleanupFilters } from '../src/audio/voiceCleanup.js';

describe('buildCleanupFilters', () => {
  it('returns an empty chain when everything is off', () => {
    expect(buildCleanupFilters({})).toBe('');
    expect(buildCleanupFilters({ trimSilence: false, loudnorm: false })).toBe('');
  });

  it('trims leading silence and loudness-normalizes like prepare', () => {
    const chain = buildCleanupFilters({ trimSilence: true, loudnorm: true });
    expect(chain).toBe('silenceremove=start_periods=1:start_threshold=-45dB,loudnorm=I=-20:TP=-1.5:LRA=7');
  });

  it('adds high-pass and low-pass with clamping', () => {
    expect(buildCleanupFilters({ highpassHz: 80 })).toBe('highpass=f=80');
    expect(buildCleanupFilters({ highpassHz: 5 })).toBe('highpass=f=20'); // below min → clamped
    expect(buildCleanupFilters({ lowpassHz: 99999 })).toBe('lowpass=f=20000');
    expect(buildCleanupFilters({ highpassHz: 0, lowpassHz: 0 })).toBe(''); // 0 = off
  });

  it('configures afftdn noise reduction', () => {
    expect(buildCleanupFilters({ denoiseStrength: 12 })).toBe('afftdn=nr=12:nf=-25');
    expect(buildCleanupFilters({ denoiseStrength: 500 })).toBe('afftdn=nr=100:nf=-25');
  });

  it('orders compressor and gain after normalize', () => {
    const chain = buildCleanupFilters({ loudnorm: true, compressor: true, gainDb: 3 });
    expect(chain).toBe('loudnorm=I=-20:TP=-1.5:LRA=7,acompressor=threshold=0.089:ratio=4:attack=25:release=250,volume=3dB');
    expect(buildCleanupFilters({ gainDb: 0 })).toBe('');
  });

  it('includes fade-in but never fade-out (second pass)', () => {
    expect(buildCleanupFilters({ fadeInSec: 0.5 })).toBe('afade=t=in:st=0:d=0.5');
    expect(buildCleanupFilters({ fadeOutSec: 0.5 })).toBe('');
  });

  it('chains everything in filter order', () => {
    const chain = buildCleanupFilters({
      trimSilence: true,
      highpassHz: 100,
      lowpassHz: 12000,
      denoiseStrength: 20,
      loudnorm: true,
      compressor: true,
      gainDb: -2,
      fadeInSec: 0.1,
    });
    expect(chain).toBe(
      [
        'silenceremove=start_periods=1:start_threshold=-45dB',
        'highpass=f=100',
        'lowpass=f=12000',
        'afftdn=nr=20:nf=-25',
        'loudnorm=I=-20:TP=-1.5:LRA=7',
        'acompressor=threshold=0.089:ratio=4:attack=25:release=250',
        'volume=-2dB',
        'afade=t=in:st=0:d=0.1',
      ].join(','),
    );
  });
});
