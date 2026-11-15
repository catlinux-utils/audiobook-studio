/**
 * Expert-mode synthesis options for voice cloning.
 *
 * OmniVoice accepts many more request controls than the studio exposes by
 * default (see runtime/bin/model_specs/omnivoice.json). This registry defines
 * which ones expert mode may set, their types/clamps, and their spec defaults.
 * Everything here is sent into the /v1/audio/speech `options` object; the
 * transcript (reference_text), language and seed are per-run inputs, while
 * num_inference_steps / guidance_scale / speed remain book-owned in generation
 * (the bench can still experiment with them).
 */

export type ExpertOptionType = 'string' | 'int' | 'float' | 'bool';

export interface ExpertOptionDef {
  /** OmniVoice request-option name (goes into body.options) */
  name: string;
  type: ExpertOptionType;
  min?: number;
  max?: number;
  /** spec default; absent means "unset" (server default applies) */
  specDefault?: number | string | boolean;
  /** where it applies in generation */
  scope: 'voice' | 'book-owned';
  label: string;
  description: string;
}

export const EXPERT_OPTIONS: ExpertOptionDef[] = [
  {
    name: 'instruct', type: 'string', scope: 'voice',
    label: 'Instruction',
    description: 'Voice-design instruction: speaker attributes, accent, style, delivery (e.g. "calm narrator, slightly slower").',
  },
  {
    name: 'duration_sec', type: 'float', min: 0, max: 600, scope: 'voice',
    label: 'Target duration (s)',
    description: 'Force a target output duration; empty = model estimate. Forcing too short drops words.',
  },
  {
    name: 'shift', type: 'float', min: 0, max: 1, specDefault: 0.1, scope: 'voice',
    label: 'Timestep shift',
    description: 'Diffusion timestep schedule shift. Higher values can lengthen output; default 0.1.',
  },
  {
    name: 'denoise', type: 'bool', specDefault: true, scope: 'voice',
    label: 'Denoise token',
    description: 'Adds the denoise control token when reference audio is present.',
  },
  {
    name: 'preprocess_prompt', type: 'bool', specDefault: true, scope: 'voice',
    label: 'Preprocess reference',
    description: 'Server-side preprocessing of the speaker reference before tokenization (loudness/resample).',
  },
  {
    name: 'postprocess_output', type: 'bool', specDefault: true, scope: 'voice',
    label: 'Postprocess output',
    description: 'Output postprocessing and trimming (edge silence etc.).',
  },
  {
    name: 'layer_penalty_factor', type: 'float', min: 0, max: 50, specDefault: 5, scope: 'voice',
    label: 'Layer penalty',
    description: 'Layer-order penalty for masked audio-codebook position selection. Higher = stricter ordering.',
  },
  {
    name: 'position_temperature', type: 'float', min: 0, max: 20, specDefault: 5, scope: 'voice',
    label: 'Position temperature',
    description: 'Gumbel temperature for masked-position selection. 0 = fully deterministic positions.',
  },
  {
    name: 'class_temperature', type: 'float', min: 0, max: 5, specDefault: 0, scope: 'voice',
    label: 'Class temperature',
    description: 'Audio-token class sampling temperature; 0 = greedy. Small values (0.1-0.5) can un-stick repetitions.',
  },
  {
    name: 'num_inference_steps', type: 'int', min: 1, max: 128, specDefault: 32, scope: 'book-owned',
    label: 'Inference steps',
    description: 'Diffusion-LM steps. More = more faithful text, slower. Book setting wins in generation.',
  },
  {
    name: 'guidance_scale', type: 'float', min: 0, max: 10, specDefault: 2, scope: 'book-owned',
    label: 'Guidance',
    description: 'Classifier-free guidance. Higher = closer to text, can flatten prosody. Book setting wins in generation.',
  },
  {
    name: 'speed', type: 'float', min: 0.5, max: 2, specDefault: 1, scope: 'book-owned',
    label: 'Speed',
    description: 'Feeds target-length estimation; <1 gives the model more room per word. Book setting wins in generation.',
  },
];

const BY_NAME = new Map(EXPERT_OPTIONS.map((o) => [o.name, o]));

export type ExpertOptions = Partial<Record<string, string | number | boolean>>;

/** Fields of SynthesizeRequest produced from expert options (structural copy). */
export interface ExpertRequestFields {
  instruct?: string;
  durationSec?: number;
  shift?: number;
  denoise?: boolean;
  preprocessPrompt?: boolean;
  postprocessOutput?: boolean;
  layerPenaltyFactor?: number;
  positionTemperature?: number;
  classTemperature?: number;
  numInferenceSteps?: number;
  guidanceScale?: number;
  speed?: number;
}

/** Map stored expert options onto the synthesize-request field names. */
export function expertOptionsToRequest(o: ExpertOptions): ExpertRequestFields {
  const out: ExpertRequestFields = {};
  const n = (k: string): number | undefined => (typeof o[k] === 'number' ? (o[k] as number) : undefined);
  const b = (k: string): boolean | undefined => (typeof o[k] === 'boolean' ? (o[k] as boolean) : undefined);
  const s = (k: string): string | undefined => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : undefined);
  out.instruct = s('instruct');
  out.durationSec = n('duration_sec');
  out.shift = n('shift');
  out.denoise = b('denoise');
  out.preprocessPrompt = b('preprocess_prompt');
  out.postprocessOutput = b('postprocess_output');
  out.layerPenaltyFactor = n('layer_penalty_factor');
  out.positionTemperature = n('position_temperature');
  out.classTemperature = n('class_temperature');
  out.numInferenceSteps = n('num_inference_steps');
  out.guidanceScale = n('guidance_scale');
  out.speed = n('speed');
  return out;
}

/** Clamp/validate one option value; returns undefined when it should be dropped. */
function sanitizeOne(def: ExpertOptionDef, value: unknown): string | number | boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  switch (def.type) {
    case 'string': {
      const s = String(value).trim();
      return s ? s.slice(0, 500) : undefined;
    }
    case 'bool': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    }
    case 'int': {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return undefined;
      return Math.min(def.max ?? n, Math.max(def.min ?? n, n));
    }
    case 'float': {
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      const clamped = Math.min(def.max ?? n, Math.max(def.min ?? n, n));
      return Math.round(clamped * 1000) / 1000;
    }
  }
}

/** Whitelist + clamp an expert-options object from the client. */
export function sanitizeExpertOptions(raw: unknown): { options: ExpertOptions; rejected: string[] } {
  const options: ExpertOptions = {};
  const rejected: string[] = [];
  if (!raw || typeof raw !== 'object') return { options, rejected };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const def = BY_NAME.get(key);
    if (!def) {
      rejected.push(key);
      continue;
    }
    const clean = sanitizeOne(def, value);
    if (clean === undefined) continue;
    // dropping a value equal to the spec default keeps stored options minimal
    options[key] = clean;
  }
  return { options, rejected };
}
