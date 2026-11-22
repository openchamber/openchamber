import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  preserveMalformedJsonFileSync,
  readDurableJsonFileSync,
  writeDurableJsonFileSync,
} from '../shared/durable-json-store.js';

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

// This store rides the shared durable-store primitive (design #976): the
// strict three-state reader judges the file, the preserve helper moves a
// malformed file aside, and the writer is mode-explicit. The schema is the
// reader's value judgement, so a parseable file holding the wrong shape is
// malformed here exactly as a torn one is.
const isStoredKeysValue = (value) => storedKeysSchema.safeParse(value).success;

const readStoredKeys = () => {
  let result;
  try {
    result = readDurableJsonFileSync(voiceKeysPath(), { validateValue: isStoredKeysValue });
  } catch (error) {
    console.warn('[voice] voice-keys.json is unreadable:', error?.message ?? error);
    return {};
  }
  if (result.state === 'missing') return {};
  if (result.state === 'malformed') {
    // The parse error itself is never logged: it quotes the file, and the
    // file holds API keys.
    console.warn('[voice] voice-keys.json is malformed: ignoring its contents');
    return {};
  }
  return storedKeysSchema.parse(result.value);
};

// The update path cannot treat a malformed file as an empty store the way
// a read can: it rewrites the file from what it read, so the stored keys
// would be erased for good. Preserve the malformed bytes to the
// primitive's preserved sibling first, and fail closed when the file
// cannot even be read — an update that cannot see the current keys must
// not replace them. A
// 'replaced' preserve outcome means a valid file landed in the meantime:
// read that instead of the preserved one (bounded — repeated replacement
// is a race no update should chase).
const readStoredKeysForUpdate = (filePath, replacements = 0) => {
  const result = readDurableJsonFileSync(filePath, { validateValue: isStoredKeysValue });
  if (result.state === 'missing') return {};
  if (result.state === 'valid') return storedKeysSchema.parse(result.value);
  const preservation = preserveMalformedJsonFileSync(filePath, { validateValue: isStoredKeysValue });
  if (preservation.preserved) {
    console.warn(`[voice] voice-keys.json is malformed: preserved the unreadable file at ${preservation.preservedPath}`);
    return {};
  }
  if (preservation.outcome === 'missing') return {};
  if (preservation.outcome === 'replaced' && replacements < 3) {
    return readStoredKeysForUpdate(filePath, replacements + 1);
  }
  throw new Error(`Refusing to overwrite the malformed voice keys file at ${filePath}: it could not be preserved`);
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
  const filePath = voiceKeysPath();
  const next = { ...readStoredKeysForUpdate(filePath) };
  for (const kind of VOICE_KEY_KINDS) {
    if (!(kind in patch)) continue;
    const value = patch[kind];
    if (value) next[kind] = value;
    else delete next[kind];
  }
  writeDurableJsonFileSync(filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
  return describeVoiceKeys();
};
