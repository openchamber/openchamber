import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * API keys for voice services the user typed in Settings: OpenAI read-aloud,
 * a custom OpenAI-compatible speech server, and a custom transcription
 * server. They live here, mode 0600, like every other credential the server
 * keeps; browsers hold only whether each one is set. Routes fill a request's
 * key from here, so a key never travels with a request from the UI.
 */
const VOICE_KEY_KINDS = ['openai', 'openaiCompatible', 'stt'];

const storedKey = z.string().trim().min(1).max(1024);
const storedKeysSchema = z.object({
  openai: storedKey.optional().catch(undefined),
  openaiCompatible: storedKey.optional().catch(undefined),
  stt: storedKey.optional().catch(undefined),
});
// A string sets the key, null or '' removes it, an absent kind stays as is.
const patchValue = z.union([z.literal(''), z.null(), storedKey]);
const patchSchema = z.object({
  openai: patchValue.optional(),
  openaiCompatible: patchValue.optional(),
  stt: patchValue.optional(),
}).strict();

const resolveDataDir = () => (process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber'));

const voiceKeysPath = () => path.join(resolveDataDir(), 'voice-keys.json');

const readStoredKeys = () => {
  let raw;
  try {
    raw = fs.readFileSync(voiceKeysPath(), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[voice] voice-keys.json is unreadable:', error?.message ?? error);
    }
    return {};
  }
  try {
    return storedKeysSchema.parse(JSON.parse(raw));
  } catch (error) {
    console.warn('[voice] voice-keys.json is malformed:', error?.message ?? error);
    return {};
  }
};

/** The stored key for one kind, or undefined. */
export const readVoiceKey = (kind) => readStoredKeys()[kind];

/** Which kinds have a key; never the keys themselves. */
export const describeVoiceKeys = () => {
  const keys = readStoredKeys();
  return Object.fromEntries(VOICE_KEY_KINDS.map((kind) => [kind, Boolean(keys[kind])]));
};

/**
 * Apply a patch from `/api/voice/keys` and answer the new state. Throws on a
 * malformed patch before anything is written.
 */
export const updateVoiceKeys = (body) => {
  const patch = patchSchema.parse(body);
  const next = { ...readStoredKeys() };
  for (const kind of VOICE_KEY_KINDS) {
    if (!(kind in patch)) continue;
    const value = patch[kind];
    if (value) next[kind] = value;
    else delete next[kind];
  }
  const filePath = voiceKeysPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  return describeVoiceKeys();
};
