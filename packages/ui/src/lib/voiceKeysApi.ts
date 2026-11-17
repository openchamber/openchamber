import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const voiceApiKeyStateSchema = z.object({
  openai: z.boolean(),
  openaiCompatible: z.boolean(),
  stt: z.boolean(),
});

export type VoiceApiKeyState = z.infer<typeof voiceApiKeyStateSchema>;
export type VoiceApiKeyKind = keyof VoiceApiKeyState;

export const EMPTY_VOICE_API_KEYS = { openai: false, openaiCompatible: false, stt: false } satisfies VoiceApiKeyState;

const LEGACY_STORAGE_KEYS = {
  openai: 'openaiApiKey',
  openaiCompatible: 'openaiCompatibleApiKey',
  stt: 'sttApiKey',
} as const satisfies Record<VoiceApiKeyKind, string>;

const VOICE_API_KEY_KINDS = ['openai', 'openaiCompatible', 'stt'] as const satisfies readonly VoiceApiKeyKind[];

export const fetchVoiceApiKeys = async (): Promise<VoiceApiKeyState> => {
  const response = await runtimeFetch('/api/voice/keys', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Failed to read voice keys: ${response.status}`);
  return voiceApiKeyStateSchema.parse(await response.json());
};

export const updateVoiceApiKeys = async (
  patch: Partial<Record<VoiceApiKeyKind, string | null>>,
): Promise<VoiceApiKeyState> => {
  const response = await runtimeFetch('/api/voice/keys', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Failed to save voice keys: ${response.status}`);
  return voiceApiKeyStateSchema.parse(await response.json());
};

export const migrateLegacyVoiceApiKeys = async (): Promise<VoiceApiKeyState | null> => {
  const patch: Partial<Record<VoiceApiKeyKind, string>> = {};
  let legacyPresent = false;
  for (const kind of VOICE_API_KEY_KINDS) {
    const stored = window.localStorage.getItem(LEGACY_STORAGE_KEYS[kind]);
    if (stored === null) continue;
    legacyPresent = true;
    if (stored.trim()) patch[kind] = stored.trim();
  }
  if (!legacyPresent) return null;
  const state = Object.keys(patch).length > 0 ? await updateVoiceApiKeys(patch) : null;
  for (const kind of VOICE_API_KEY_KINDS) {
    window.localStorage.removeItem(LEGACY_STORAGE_KEYS[kind]);
  }
  return state;
};
