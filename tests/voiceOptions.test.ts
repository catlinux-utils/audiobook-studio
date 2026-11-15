import { describe, expect, it } from 'vitest';
import { sanitizeExpertOptions, expertOptionsToRequest } from '../src/tts/voiceOptions.js';

describe('sanitizeExpertOptions', () => {
  it('accepts known options with correct types', () => {
    const { options, rejected } = sanitizeExpertOptions({
      instruct: '  calm narrator  ',
      shift: 0.2,
      denoise: false,
      num_inference_steps: 48,
      guidance_scale: 3,
    });
    expect(rejected).toEqual([]);
    expect(options).toEqual({
      instruct: 'calm narrator',
      shift: 0.2,
      denoise: false,
      num_inference_steps: 48,
      guidance_scale: 3,
    });
  });

  it('rejects unknown option names', () => {
    const { options, rejected } = sanitizeExpertOptions({ nope: 1, shift: 0.3 });
    expect(rejected).toEqual(['nope']);
    expect(options).toEqual({ shift: 0.3 });
  });

  it('clamps numeric values to the registry range', () => {
    const { options } = sanitizeExpertOptions({ num_inference_steps: 999, shift: 5, class_temperature: -3 });
    expect(options.num_inference_steps).toBe(128);
    expect(options.shift).toBe(1);
    expect(options.class_temperature).toBe(0);
  });

  it('parses string booleans and drops invalid ones', () => {
    const { options } = sanitizeExpertOptions({ denoise: 'false', preprocess_prompt: 'true', postprocess_output: 'kinda' });
    expect(options.denoise).toBe(false);
    expect(options.preprocess_prompt).toBe(true);
    expect(options.postprocess_output).toBeUndefined();
  });

  it('drops empty/blank values entirely', () => {
    const { options } = sanitizeExpertOptions({ instruct: '   ', duration_sec: '', shift: null });
    expect(options).toEqual({});
  });

  it('returns empty for non-object input', () => {
    expect(sanitizeExpertOptions(null).options).toEqual({});
    expect(sanitizeExpertOptions('x').options).toEqual({});
    expect(sanitizeExpertOptions(42).rejected).toEqual([]);
  });

  it('truncates very long instruct strings', () => {
    const { options } = sanitizeExpertOptions({ instruct: 'a'.repeat(600) });
    expect((options.instruct as string).length).toBe(500);
  });
});

describe('expertOptionsToRequest', () => {
  it('maps snake_case options onto request fields', () => {
    const req = expertOptionsToRequest({
      instruct: 'slow',
      duration_sec: 12,
      shift: 0.3,
      denoise: false,
      preprocess_prompt: true,
      postprocess_output: false,
      layer_penalty_factor: 7,
      position_temperature: 0,
      class_temperature: 0.4,
      num_inference_steps: 64,
      guidance_scale: 2.5,
      speed: 0.9,
    });
    expect(req).toEqual({
      instruct: 'slow',
      durationSec: 12,
      shift: 0.3,
      denoise: false,
      preprocessPrompt: true,
      postprocessOutput: false,
      layerPenaltyFactor: 7,
      positionTemperature: 0,
      classTemperature: 0.4,
      numInferenceSteps: 64,
      guidanceScale: 2.5,
      speed: 0.9,
    });
  });

  it('ignores values of the wrong type and empty options', () => {
    const req = expertOptionsToRequest({ denoise: 'yes', shift: 'fast', instruct: 5 });
    expect(req).toEqual({});
    expect(expertOptionsToRequest({})).toEqual({});
  });
});
