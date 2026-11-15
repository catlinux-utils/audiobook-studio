/**
 * Client for the local audio.cpp server (https://github.com/0xShug0/audio.cpp).
 *
 * We use POST /v1/audio/speech with binary WAV responses (documented default),
 * voice cloning via inline `voice_ref` base64 payloads (<= 5 MiB, documented),
 * and family options (num_inference_steps / guidance_scale / speed / seed).
 * Busy servers answer HTTP 503 — surfaced as `ServerBusyError` so the queue
 * can back off without failing the chunk.
 */

export class ServerBusyError extends Error {
  constructor(message = 'audio.cpp server is busy (503)') {
    super(message);
    this.name = 'ServerBusyError';
  }
}

export class TtsRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public transient = false,
  ) {
    super(message);
    this.name = 'TtsRequestError';
  }
}

export interface SynthesizeRequest {
  input: string;
  /** Synthesis language code (e.g. "pl"); omitted → OmniVoice auto-detects.
   *  Auto-detect misfires on short/odd text and garbles or drops words. */
  language?: string;
  /** voice_dir name on the server (optional; inline voice_ref takes priority). */
  voice?: string;
  /** inline cloning reference, raw base64 of a WAV file */
  voiceRefBase64?: string;
  referenceText?: string;
  numInferenceSteps?: number;
  guidanceScale?: number;
  speed?: number;
  seed?: string;
  // ---- expert-mode options (OmniVoice request options, see tts/voiceOptions.ts) ----
  /** voice-design instruction: speaker attributes, accent, style, delivery */
  instruct?: string;
  /** force a target output duration (seconds); empty = model estimate */
  durationSec?: number;
  /** diffusion timestep schedule shift (default 0.1) */
  shift?: number;
  /** add the denoise control token when reference audio is present (default true) */
  denoise?: boolean;
  /** preprocess the speaker reference before tokenization (default true) */
  preprocessPrompt?: boolean;
  /** apply output postprocessing/trimming (default true) */
  postprocessOutput?: boolean;
  /** layer-order penalty for masked codebook-position selection (default 5) */
  layerPenaltyFactor?: number;
  /** Gumbel temperature for masked-position selection (default 5) */
  positionTemperature?: number;
  /** audio-token class sampling temperature; 0 = greedy (default 0) */
  classTemperature?: number;
  signal?: AbortSignal;
}

export interface HealthInfo {
  status: string;
  backend?: string;
  models?: number;
  version?: string;
  git?: string;
}

export class AudioCppClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async health(timeoutMs = 5000): Promise<HealthInfo> {
    const res = await fetch(this.url('/health'), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new TtsRequestError(res.status, `health check failed: ${res.status}`);
    return (await res.json()) as HealthInfo;
  }

  async listVoices(): Promise<string[]> {
    const res = await fetch(this.url(`/v1/audio/voices?model=${encodeURIComponent(this.model)}`));
    if (!res.ok) throw new TtsRequestError(res.status, `voices list failed: ${res.status}`);
    const body = (await res.json()) as { voices?: string[] };
    return body.voices ?? [];
  }

  /**
   * Synthesize one text segment; resolves with raw WAV bytes.
   * Retries on 503 (busy) with capped exponential backoff.
   */
  async synthesize(req: SynthesizeRequest, opts?: { retries?: number }): Promise<Buffer> {
    const retries = opts?.retries ?? 6;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await this.synthesizeOnce(req);
      } catch (err) {
        const busy = err instanceof ServerBusyError;
        const transient = err instanceof TtsRequestError && err.transient;
        if ((busy || transient) && attempt <= retries) {
          await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000), req.signal);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Transcribe a server-local audio file via POST /v1/audio/transcriptions.
   * Returns the plain transcript text.
   */
  async transcribe(audioPath: string, language?: string, timeoutMs = 300_000): Promise<string> {
    const body: Record<string, unknown> = { model: this.model, audio: audioPath };
    if (language) body.language = language;
    const res = await fetch(this.url('/v1/audio/transcriptions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new TtsRequestError(res.status, await errorMessage(res));
    const data = (await res.json()) as Record<string, unknown>;
    const text = data.text ?? data.transcript ?? data.result;
    if (typeof text !== 'string') throw new TtsRequestError(res.status, 'unexpected transcription response shape');
    return text.trim();
  }

  private async synthesizeOnce(req: SynthesizeRequest): Promise<Buffer> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: req.input,
      response_format: 'wav',
    };
    if (req.language) body.language = req.language;
    if (req.voice) body.voice = req.voice;
    if (req.voiceRefBase64) body.voice_ref = { type: 'base64', data: req.voiceRefBase64 };
    if (req.referenceText) body.reference_text = req.referenceText;

    const options: Record<string, unknown> = {};
    if (req.numInferenceSteps !== undefined) options.num_inference_steps = req.numInferenceSteps;
    if (req.guidanceScale !== undefined) options.guidance_scale = req.guidanceScale;
    if (req.speed !== undefined && req.speed !== 1) options.speed = req.speed;
    if (req.instruct !== undefined && req.instruct !== '') options.instruct = req.instruct;
    if (req.durationSec !== undefined) options.duration_sec = req.durationSec;
    if (req.shift !== undefined) options.shift = req.shift;
    if (req.denoise !== undefined) options.denoise = req.denoise;
    if (req.preprocessPrompt !== undefined) options.preprocess_prompt = req.preprocessPrompt;
    if (req.postprocessOutput !== undefined) options.postprocess_output = req.postprocessOutput;
    if (req.layerPenaltyFactor !== undefined) options.layer_penalty_factor = req.layerPenaltyFactor;
    if (req.positionTemperature !== undefined) options.position_temperature = req.positionTemperature;
    if (req.classTemperature !== undefined) options.class_temperature = req.classTemperature;
    if (Object.keys(options).length > 0) body.options = options;
    if (req.seed) body.seed = req.seed;

    const res = await fetch(this.url('/v1/audio/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (res.status === 503) throw new ServerBusyError(await errorMessage(res));
    if (!res.ok) throw new TtsRequestError(res.status, await errorMessage(res));

    const contentType = res.headers.get('content-type') ?? '';
    if (!/audio\/wav|application\/octet-stream/i.test(contentType)) {
      // some builds return JSON errors with 200 in odd configs — treat as failure
      throw new TtsRequestError(res.status, `unexpected content-type: ${contentType}`, true);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 44) throw new TtsRequestError(res.status, 'response too short to be a WAV', true);
    // RIFF-declared total size vs actual bytes: catches truncated responses
    // (contended servers occasionally cut the body mid-transfer)
    if (buf.length >= 8) {
      const declared = buf.readUInt32LE(4) + 8;
      if (buf.length < declared) {
        throw new TtsRequestError(res.status, `truncated WAV response: got ${buf.length} of ${declared} bytes`, true);
      }
    }
    return buf;
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300) || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
