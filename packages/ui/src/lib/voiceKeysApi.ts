import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * Voice API keys live on the server (`/api/voice/keys`, mode 0600 there);
 * the UI only learns whether each is set. Speech and transcription requests
 * carry no key: the server fills it in.
 */
const voiceApiKeyStateSchema = z.object({
  openai: z.boolean(),
  openaiCompatible: z.boolean(),
  stt: z.boolean(),
});

export type VoiceApiKeyState = z.infer<typeof voiceApiKeyStateSchema>;
export type VoiceApiKeyKind = keyof VoiceApiKeyState;

export const EMPTY_VOICE_API_KEYS = { openai: false, openaiCompatible: false, stt: false } satisfies VoiceApiKeyState;

/** Where builds before the server-side store kept each key in the browser. */
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

/** A string stores the key, null removes it. Answers the new state. */
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

/**
 * Moves keys a previous build left in localStorage to the server, then
 * deletes them from the browser. Only after the server confirmed the write:
 * a failed move keeps them for the next attempt rather than losing them.
 * Answers the new state, or null when there was nothing to move.
 */
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
