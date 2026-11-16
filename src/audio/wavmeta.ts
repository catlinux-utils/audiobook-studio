/**
 * Minimal WAV (RIFF) header reader — duration + format, no external deps.
 * audio.cpp returns 16-bit PCM mono @ 24 kHz, but we parse the real headers
 * so any format works.
 */
import fs from 'node:fs';
export interface WavInfo {
  durationMs: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** Format info plus the byte range of the PCM data chunk. */
export interface WavData extends WavInfo {
  /** offset of the first PCM sample byte */
  dataOffset: number;
  dataBytes: number;
}

export function readWavData(buf: Buffer): WavData {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 24000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = 0;
  let dataBytes = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataBytes = size || buf.length - dataOffset;
      break;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (dataBytes === 0) throw new Error('WAV data chunk missing');
  const blockAlign = Math.max(1, channels * (bitsPerSample / 8));
  const samples = dataBytes / blockAlign;
  return {
    durationMs: Math.round((samples / sampleRate) * 1000),
    sampleRate,
    channels,
    bitsPerSample,
    dataOffset,
    dataBytes,
  };
}

export function readWavInfo(buf: Buffer): WavInfo {
  const { durationMs, sampleRate, channels, bitsPerSample } = readWavData(buf);
  return { durationMs, sampleRate, channels, bitsPerSample };
}

/** readWavInfo straight from a file — reads only the header area so big
 *  chapter WAVs don't need a full read into memory; falls back to a full
 *  read when the data chunk header sits beyond the first 64 KB. */
export function readWavFileInfo(file: string): WavInfo {
  const fd = fs.openSync(file, 'r');
  let head: Buffer;
  try {
    head = Buffer.alloc(Math.min(65536, fs.fstatSync(fd).size));
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  try {
    return readWavInfo(head);
  } catch (err) {
    if (err instanceof Error && err.message === 'WAV data chunk missing') {
      return readWavInfo(fs.readFileSync(file));
    }
    throw err;
  }
}
