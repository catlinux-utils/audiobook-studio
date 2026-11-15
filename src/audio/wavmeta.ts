/**
 * Minimal WAV (RIFF) header reader — duration + format, no external deps.
 * audio.cpp returns 16-bit PCM mono @ 24 kHz, but we parse the real headers
 * so any format works.
 */
export interface WavInfo {
  durationMs: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export function readWavInfo(buf: Buffer): WavInfo {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 24000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataBytes = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataBytes = size || buf.length - offset - 8;
      break;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (dataBytes === 0) throw new Error('WAV data chunk missing');
  const blockAlign = Math.max(1, channels * (bitsPerSample / 8));
  const samples = dataBytes / blockAlign;
  return { durationMs: Math.round((samples / sampleRate) * 1000), sampleRate, channels, bitsPerSample };
}
