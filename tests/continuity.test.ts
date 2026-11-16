import { describe, expect, it } from 'vitest';
import {
  adaptiveTrimThresholdDb,
  boundaryKind,
  buildContinuityFilters,
  edgeFadeSec,
  gapFor,
  loudnessGainDb,
  analyzePauses,
  applyContinuity,
  measureWavMeanDbfs,
  measureWavNoiseFloorDbfs,
  silenceWav,
} from '../src/audio/continuity.js';
import { readWavData, readWavInfo } from '../src/audio/wavmeta.js';
import { chunkText } from '../src/ingest/chunker.js';

/** Build a 16-bit WAV of `ms` duration with per-sample generator fn(i) → int16. */
function mkWav(ms: number, fn: (i: number) => number): Buffer {
  const wav = silenceWav(ms);
  const { dataOffset, dataBytes } = readWavData(wav);
  const samples = dataBytes / 2;
  for (let i = 0; i < samples; i++) wav.writeInt16LE(fn(i), dataOffset + i * 2);
  return wav;
}

const amp = (db: number) => Math.round(32767 * Math.pow(10, db / 20));

describe('measureWavMeanDbfs', () => {
  it('measures a full-scale square-ish signal near 0 dBFS', () => {
    const wav = silenceWav(10);
    const data = readWavData(wav);
    for (let i = 0; i < data.dataBytes / 2; i++) wav.writeInt16LE(i % 2 === 0 ? 32767 : -32768, data.dataOffset + i * 2);
    const dbfs = measureWavMeanDbfs(wav);
    expect(dbfs).not.toBeNull();
    expect(dbfs!).toBeGreaterThan(-1);
  });

  it('a −6 dB constant is about −6 dBFS RMS', () => {
    const wav = silenceWav(10);
    const { dataOffset, dataBytes } = readWavData(wav);
    const amp = Math.round(32767 * Math.pow(10, -6 / 20)); // −6 dBFS amplitude
    for (let i = 0; i < dataBytes / 2; i++) wav.writeInt16LE(amp, dataOffset + i * 2);
    expect(measureWavMeanDbfs(wav)).toBeCloseTo(-6, 0);
  });

  it('digital silence → null (must not be amplified)', () => {
    const wav = silenceWav(10); // all zeros
    expect(measureWavMeanDbfs(wav)).toBeNull();
  });

  it('non-16-bit formats → null', () => {
    // 8-bit header variant would need a hand-built buffer; emulate by corrupting bitsPerSample
    const wav = silenceWav(10);
    wav.writeUInt16LE(32, 34); // claim 32-bit
    expect(measureWavMeanDbfs(wav)).toBeNull();
  });
});

describe('measureWavNoiseFloorDbfs', () => {
  it('digital silence → null', () => {
    expect(measureWavNoiseFloorDbfs(silenceWav(50))).toBeNull();
  });

  it('constant level → floor equals that level', () => {
    const wav = mkWav(100, () => amp(-40));
    expect(measureWavNoiseFloorDbfs(wav)).toBeCloseTo(-40, 0);
  });

  it('loud speech over a quiet noise floor → floor reflects the quiet part', () => {
    // first half at −20 dB ("speech"), second half at −40 dB ("noise floor")
    const half = Math.round((150 / 1000) * 24000);
    const wav = mkWav(300, (i) => (i < half ? amp(-20) : amp(-40)));
    const floor = measureWavNoiseFloorDbfs(wav);
    expect(floor).not.toBeNull();
    expect(floor!).toBeLessThan(-36);
    expect(floor!).toBeGreaterThan(-44);
  });

  it('non-16-bit formats → null', () => {
    const wav = silenceWav(50);
    wav.writeUInt16LE(32, 34);
    expect(measureWavNoiseFloorDbfs(wav)).toBeNull();
  });
});

describe('adaptiveTrimThresholdDb', () => {
  it('clean floor (null) → default −45', () => {
    expect(adaptiveTrimThresholdDb(null)).toBe(-45);
  });

  it('sits just above a modest noise floor — speech-safe', () => {
    expect(adaptiveTrimThresholdDb(-50)).toBe(-45);
    expect(adaptiveTrimThresholdDb(-55)).toBe(-50);
    expect(adaptiveTrimThresholdDb(-57)).toBe(-52);
  });

  it('clamps low enough that soft word onsets (−35 dBFS) survive', () => {
    expect(adaptiveTrimThresholdDb(-45)).toBe(-40);
    expect(adaptiveTrimThresholdDb(-40)).toBe(-35);
    expect(adaptiveTrimThresholdDb(-20)).toBe(-35);
  });
});

describe('edgeFadeSec', () => {
  it('is always a tiny click-removal fade — no baked edge ramps', () => {
    expect(edgeFadeSec(null)).toBe(0.01);
    expect(edgeFadeSec(-60)).toBe(0.01);
    expect(edgeFadeSec(-40)).toBe(0.01);
  });
});

describe('loudnessGainDb', () => {
  it('moves measured level to the target', () => {
    expect(loudnessGainDb(-23, -20)).toBe(3);
    expect(loudnessGainDb(-18, -20)).toBe(-2);
  });

  it('clamps to ±maxGain', () => {
    expect(loudnessGainDb(-60, -20, 6)).toBe(6);
    expect(loudnessGainDb(-5, -20, 6)).toBe(-6);
  });

  it('null measurement → no gain', () => {
    expect(loudnessGainDb(null)).toBe(0);
  });
});

describe('applyContinuity', () => {
  /** speech/pause sandwich: lenSec pieces alternating −20 dB speech and −55 dB pause */
  function mkConversation(pausesSec: number[]): Buffer {
    const speech = (ms: number) => (i: number) => amp(-20) * (i % 2 === 0 ? 1 : -1);
    const noise = (ms: number) => (i: number) => amp(-55) * (((i * 7919) % 3) - 1);
    const wav = silenceWav(pausesSec.reduce((a, b) => a + 1000 + b * 1000, 0) + 1000 + 500);
    const { dataOffset } = readWavData(wav);
    let pos = 0;
    const put = (ms: number, fn: (i: number) => number) => {
      const n = Math.round((ms / 1000) * 24000);
      for (let i = 0; i < n; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, fn(i))), dataOffset + (pos + i) * 2);
      pos += n;
    };
    pausesSec.forEach((p) => {
      put(1000, speech(1000));
      put(p * 1000, noise(p * 1000));
    });
    put(1000, speech(1000));
    put(500, noise(500)); // trailing room tone
    return wav;
  }
  const countPauses = (buf: Buffer): number[] => {
    const w = readWavData(buf);
    const win = Math.round(0.05 * w.sampleRate);
    const nWin = Math.floor(w.dataBytes / 2 / win);
    const out: number[] = [];
    let run = 0;
    for (let i = 0; i < nWin; i++) {
      let sum = 0;
      for (let j = 0; j < win; j++) sum += buf.readInt16LE(w.dataOffset + (i * win + j) * 2) ** 2;
      const db = 20 * Math.log10(Math.sqrt(sum / win) / 32768);
      if (db < -45) run++; else { if (run >= 3) out.push(run * 50); run = 0; }
    }
    if (run >= 3) out.push(run * 50);
    return out;
  };

  it('caps long pauses and extends short ones to the target', () => {
    // pauses: 0.8 s (too long), 0.3 s (too short), 0.45 s (near target)
    const src = mkConversation([0.8, 0.3, 0.45]);
    const out = applyContinuity(src, {
      targetPauseSec: 0.4,
      thresholdDb: -45,
      leadKeepSec: 0.22,
      tailKeepSec: 0.33,
      gainDb: 0,
    });
    expect(out).not.toBeNull();
    const pauses = countPauses(out!);
    // 3 normalized in-take pauses (plus possibly the trailing room-tone run)
    expect(pauses.length).toBeGreaterThanOrEqual(3);
    for (const p of pauses.slice(0, 3)) {
      expect(p).toBeGreaterThanOrEqual(350);
      expect(p).toBeLessThanOrEqual(460);
    }
    // total ≈ speech 3 s + 3×0.4 s pauses + trailing pad
    const info = readWavInfo(out!);
    expect(info.durationMs).toBeGreaterThanOrEqual(4000 + 3 * 350 + 300);
    expect(info.durationMs).toBeLessThanOrEqual(4000 + 3 * 460 + 600);
  });

  it('keeps sub-minimum pauses untouched', () => {
    const src = mkConversation([0.8, 0.12, 0.12]);
    const out = applyContinuity(src, { targetPauseSec: 0.4, thresholdDb: -45, gainDb: 0 });
    // only the 0.8 s pause is normalized; the 120 ms gaps stay as-is
    expect(readWavInfo(out!).durationMs).toBeGreaterThan(3900);
  });

  it('fades speech into and out of normalized pauses (no hard step)', () => {
    // −55 dB pauses are natural (not digital at the −60 cutoff) but still
    // normalized → boundaries get a ~10 ms fade instead of a hard sample step
    const src = mkConversation([0.8, 0.3]);
    const out = applyContinuity(src, { targetPauseSec: 0.4, thresholdDb: -45, gainDb: 0 });
    expect(out).not.toBeNull();
    const w = readWavData(out!);
    const sr = w.sampleRate;
    // the run between speech pieces: find a pause region and check that the
    // first samples of speech after it start from low amplitude (faded in)
    const win = Math.round(0.05 * sr);
    const total = w.dataBytes / 2;
    const db = (s: number) => {
      let sum = 0;
      for (let j = 0; j < win; j++) { const v = out!.readInt16LE(w.dataOffset + (s + j) * 2); sum += v * v; }
      const r = Math.sqrt(sum / win) / 32768;
      return 20 * Math.log10(r);
    };
    let speechStart = -1;
    let transitions = 0;
    for (let s = win; s < total - win; s += win) {
      if (db(s) > -35 && db(s - win) < -45) {
        transitions++;
        if (transitions === 2) { speechStart = s; break; } // after the first pause, not the leading pad
      }
    }
    expect(speechStart).toBeGreaterThan(0);
    // a faded onset ramps through intermediate amplitudes; a hard cut jumps
    // from room tone (~±100) straight to full speech amplitude
    const onset = (() => {
      for (let s = speechStart - win; s < speechStart + win; s++) {
        if (Math.abs(out!.readInt16LE(w.dataOffset + s * 2)) > 3000) return s;
      }
      return -1;
    })();
    expect(onset).toBeGreaterThan(0);
    const hasRamp = (() => {
      for (let s = Math.max(0, onset - 240); s < onset; s++) {
        const a = Math.abs(out!.readInt16LE(w.dataOffset + s * 2));
        if (a > 300 && a < 2000) return true;
      }
      return false;
    })();
    expect(hasRamp).toBe(true);
  });

  it('null for non-16-bit formats', () => {
    const wav = silenceWav(100);
    wav.writeUInt16LE(32, 34);
    expect(applyContinuity(wav, { targetPauseSec: 0.4, thresholdDb: -45 })).toBeNull();
  });
});

describe('applyContinuity — digital-silence dropout fill', () => {
  /** like mkConversation but pauses are exact zeros (model dropout) except
   *  the last, which carries −50 dB room tone as the filler source */
  function mkDropout(pausesSec: number[]): Buffer {
    const speech = (i: number) => amp(-20) * (i % 2 === 0 ? 1 : -1);
    const tone = (i: number) => amp(-50) * (((i * 7919) % 3) - 1);
    const wav = silenceWav(pausesSec.reduce((a, b) => a + 1000 + b * 1000, 0) + 1000 + 500);
    const { dataOffset } = readWavData(wav);
    let pos = 0;
    const put = (ms: number, fn: (i: number) => number) => {
      const n = Math.round((ms / 1000) * 24000);
      for (let i = 0; i < n; i++) wav.writeInt16LE(fn(i), dataOffset + (pos + i) * 2);
      pos += n;
    };
    pausesSec.forEach((p) => {
      put(1000, speech);
      const n = Math.round(p * 24000);
      if (p === 0.5) for (let i = 0; i < n; i++) wav.writeInt16LE(tone(i), dataOffset + (pos + i) * 2);
      pos += n; // other pauses stay digital silence (zeros from silenceWav)
    });
    put(1000, speech);
    put(500, tone); // trailing room tone
    return wav;
  }

  it('replaces digital-silence pauses with the take’s own room tone', () => {
    const src = mkDropout([0.8, 0.5]);
    const out = applyContinuity(src, { targetPauseSec: 0.4, thresholdDb: -45, gainDb: 0 });
    expect(out).not.toBeNull();
    const w = readWavData(out!);
    const win = Math.round(0.05 * w.sampleRate);
    const nWin = Math.floor(w.dataBytes / 2 / win);
    // no window inside the narration may be pure digital silence anymore
    for (let i = 1; i < nWin - 1; i++) {
      let sum = 0;
      for (let j = 0; j < win; j++) sum += out!.readInt16LE(w.dataOffset + (i * win + j) * 2) ** 2;
      const db = 20 * Math.log10(Math.sqrt(sum / win) / 32768);
      expect(db).toBeGreaterThan(-70);
    }
    // pauses normalized to the target like natural ones
    const pauses = analyzePauses(out!, 150)!;
    expect(pauses.length).toBeGreaterThanOrEqual(2);
    for (const p of pauses.slice(0, 2)) expect(p).toBeGreaterThanOrEqual(350);
  });
});

describe('boundaryKind', () => {
  it('classifies real chunker output', () => {
    // paragraph 1 fills the budget so the packer flushes exactly at '\n\n'
    const text = 'Ala ma kota. Kot ma Alę! A kot robi psikot i tyle.\n\nNowy akapit zaczyna się tutaj. I ciągnie dalej, oraz jeszcze jeden, dłuższy na koniec, sporo znaków w środku żeby przekroczyć budżet.';
    const chunks = chunkText(text, 60);
    expect(chunks.length).toBeGreaterThan(1);
    // walk adjacent pairs — every kind must be one of the three
    for (let i = 0; i < chunks.length - 1; i++) {
      const kind = boundaryKind(chunks[i]!, chunks[i + 1]!);
      expect(['paragraph', 'sentence', 'soft']).toContain(kind);
    }
    // the chunk pair crossing '\n\n' is a paragraph boundary
    const paraPair = chunks.findIndex((c, i) => i > 0 && chunks[i]!.charStart - chunks[i - 1]!.charEnd >= 2);
    expect(paraPair).toBeGreaterThan(0);
    expect(boundaryKind(chunks[paraPair - 1]!, chunks[paraPair]!)).toBe('paragraph');
  });

  it('mid-sentence (soft cut) chunks end without terminal punctuation', () => {
    const text = 'To jedno bardzo długie zdanie bez znaków interpunkcyjnych w środku, które musi zostać przycięte w połowie, bo przekracza limit znaków.'; // comma split
    const chunks = chunkText(text, 60);
    const soft = chunks.filter((c) => c.softCut);
    expect(soft.length).toBeGreaterThan(0);
    const idx = chunks.findIndex((c) => c.softCut);
    expect(boundaryKind(chunks[idx]!)).toBe('soft');
    expect(boundaryKind(chunks[idx]!)).not.toBe('sentence');
  });

  it('adjacent sentence spans → sentence', () => {
    expect(boundaryKind({ text: 'Koniec zdania.', charStart: 0, charEnd: 14 }, { text: 'Nowe zdanie.', charStart: 14, charEnd: 26 })).toBe('sentence');
  });

  it('closing quotes after punctuation still count as sentence end', () => {
    expect(boundaryKind({ text: '— Nie wierzę!”', charEnd: 14, charStart: 0 }, { charStart: 14, charEnd: 20 })).toBe('sentence');
  });

  it('paragraph detection needs no text when offsets gap ≥ 2', () => {
    expect(boundaryKind({ charEnd: 40 }, { charStart: 42, charEnd: 80 })).toBe('paragraph');
  });
});

describe('gapFor', () => {
  it('maps kinds to configured pauses', () => {
    const gaps = { sentence: 300, paragraph: 550, soft: 120 };
    expect(gapFor('sentence', gaps)).toBe(300);
    expect(gapFor('paragraph', gaps)).toBe(550);
    expect(gapFor('soft', gaps)).toBe(120);
  });
});

describe('silenceWav', () => {
  it('round-trips through the WAV reader with the exact duration', () => {
    const info = readWavInfo(silenceWav(300, 24000));
    expect(info).toMatchObject({ durationMs: 300, sampleRate: 24000, channels: 1, bitsPerSample: 16 });
    const info2 = readWavInfo(silenceWav(120, 24000));
    expect(info2.durationMs).toBe(120);
  });

  it('rejects non-positive durations', () => {
    expect(() => silenceWav(0)).toThrow();
    expect(() => silenceWav(-5)).toThrow();
  });
});
