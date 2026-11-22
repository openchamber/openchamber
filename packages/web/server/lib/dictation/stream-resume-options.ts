import type { DictationStartOptions } from './stream-manager.js';

const RESUME_OPTION_FIELDS = [
  'provider',
  'localModel',
  'openaiModel',
  'openaiBaseUrl',
  'openaiEndpointPath',
  'openaiPrompt',
  'language',
  'correct',
] as const;

function hasCompatibleResumeFields(value: unknown): value is {
  model?: unknown;
  baseUrl?: unknown;
  endpointPath?: unknown;
  prompt?: unknown;
} {
  return value !== null && value !== undefined;
}

export function resumeOptionsOf(startOptions: DictationStartOptions) {
  const config = startOptions.openaiCompatible;
  const compatible = hasCompatibleResumeFields(config) ? config : undefined;
  return {
    provider: startOptions.provider === 'openai-compatible' ? 'openai-compatible' : 'local',
    localModel: startOptions.localModel ?? null,
    openaiModel: compatible?.model ?? null,
    openaiBaseUrl: compatible?.baseUrl ?? null,
    openaiEndpointPath: compatible?.endpointPath ?? null,
    openaiPrompt: String(compatible?.prompt ?? '').trim() || null,
    language: startOptions.language ?? null,
    correct: startOptions.correct === true,
  };
}

type ResumeOptions = ReturnType<typeof resumeOptionsOf>;

export function sameResumeOptions(a: ResumeOptions, b: ResumeOptions) {
  return RESUME_OPTION_FIELDS.every((field) => a[field] === b[field]);
}
