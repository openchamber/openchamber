import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

type VoiceKeyKind = 'openai' | 'openaiCompatible' | 'stt';

const VOICE_KEY_KINDS: VoiceKeyKind[] = ['openai', 'openaiCompatible', 'stt'];

const storedKey = z.string().trim().min(1).max(1024);
const storedKeysSchema = z.object({
  openai: storedKey.optional().catch(undefined),
  openaiCompatible: storedKey.optional().catch(undefined),
  stt: storedKey.optional().catch(undefined),
});
const patchValue = z.union([z.literal(''), z.null(), storedKey]);
const patchSchema = z.object({
  openai: patchValue.optional(),
  openaiCompatible: patchValue.optional(),
  stt: patchValue.optional(),
}).strict();

export type VoiceKeysPatch = z.input<typeof patchSchema>;

const resolveDataDir = () => (process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber'));

const voiceKeysPath = () => path.join(resolveDataDir(), 'voice-keys.json');

const errorDetails = z.object({ code: z.unknown().optional(), message: z.unknown().optional() });

const readStoredKeys = (): z.infer<typeof storedKeysSchema> => {
  let raw;
  try {
    raw = fs.readFileSync(voiceKeysPath(), 'utf8');
  } catch (error) {
    const details = errorDetails.safeParse(error).data;
    if (details?.code !== 'ENOENT') {
      console.warn('[voice] voice-keys.json is unreadable:', details?.message ?? error);
    }
    return {};
  }
  try {
    return storedKeysSchema.parse(JSON.parse(raw));
  } catch (error) {
    console.warn('[voice] voice-keys.json is malformed:', errorDetails.safeParse(error).data?.message ?? error);
    return {};
  }
};

export const readVoiceKey = (kind: VoiceKeyKind) => readStoredKeys()[kind];

export const describeVoiceKeys = () => {
  const keys = readStoredKeys();
  return Object.fromEntries(VOICE_KEY_KINDS.map((kind) => [kind, Boolean(keys[kind])]));
};

export const updateVoiceKeys = (body: VoiceKeysPatch) => {
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
