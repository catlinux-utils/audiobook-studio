/**
 * Web-side mirror of the server's expert-option registry (src/tts/voiceOptions.ts).
 * Only defines labels/min/max/defaults for the bench UI; the server sanitizes
 * everything anyway.
 */

export interface ExpertOptionDef {
  name: string;
  type: 'string' | 'int' | 'float' | 'bool';
  min?: number;
  max?: number;
  /** spec default; absent means "unset" (server default applies) */
  specDefault?: number | string | boolean;
  /** where it applies in generation: 'voice' = saved with the voice, 'book-owned' = per-book setting wins */
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
