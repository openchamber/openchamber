import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

type VoiceKeyKind = 'openai' | 'openaiCompatible' | 'stt';

const VOICE_KEY_KINDS: VoiceKeyKind[] = ['openai', 'openaiCompatible', 'stt'];

const speechServerOrigin = (address: string | undefined) => {
  if (!address || !URL.canParse(address)) return null;
  const { protocol, origin } = new URL(address);
  return protocol === 'http:' || protocol === 'https:' ? origin : null;
};

const storedKey = z.string().trim().min(1).max(1024);
const storedKeysSchema = z.object({
  openai: storedKey.optional().catch(undefined),
  openaiCompatible: storedKey.optional().catch(undefined),
  stt: storedKey.optional().catch(undefined),
  openaiCompatibleOrigins: z.array(z.string().refine((origin) => speechServerOrigin(origin) === origin)).catch([]),
});
const patchValue = z.union([z.literal(''), z.null(), storedKey]);
export const voiceKeysPatchSchema = z.object({
  openai: patchValue.optional(),
  openaiCompatible: patchValue.optional(),
  stt: patchValue.optional(),
}).strict();

export type VoiceKeysPatch = z.input<typeof voiceKeysPatchSchema>;

const resolveDataDir = () => (process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber'));

const voiceKeysPath = () => path.join(resolveDataDir(), 'voice-keys.json');

const errorDetails = z.object({ code: z.unknown().optional(), message: z.unknown().optional() });

const NO_STORED_KEYS: z.infer<typeof storedKeysSchema> = { openaiCompatibleOrigins: [] };

const readStoredKeys = (): z.infer<typeof storedKeysSchema> => {
  let raw;
  try {
    raw = fs.readFileSync(voiceKeysPath(), 'utf8');
  } catch (error) {
    const details = errorDetails.safeParse(error).data;
    if (details?.code !== 'ENOENT') {
      console.warn('[voice] voice-keys.json is unreadable:', details?.message ?? error);
    }
    return NO_STORED_KEYS;
  }
  try {
    return storedKeysSchema.parse(JSON.parse(raw));
  } catch (error) {
    console.warn('[voice] voice-keys.json is malformed:', errorDetails.safeParse(error).data?.message ?? error);
    return NO_STORED_KEYS;
  }
};

export const readVoiceKey = (kind: VoiceKeyKind) => readStoredKeys()[kind];

export const describeVoiceKeys = () => {
  const keys = readStoredKeys();
  return Object.fromEntries(VOICE_KEY_KINDS.map((kind) => [kind, Boolean(keys[kind])]));
};

const writeStoredKeys = (keys: z.infer<typeof storedKeysSchema>) => {
  const filePath = voiceKeysPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(keys, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
};

const keyIdSecret = crypto.randomBytes(32);
const keyIdOf = (key: string) => crypto.createHmac('sha256', keyIdSecret).update(key).digest('base64url');

export const speechServerKeyId = () => {
  const key = readVoiceKey('openaiCompatible');
  return key === undefined ? undefined : keyIdOf(key);
};

export const readSpeechServerKey = (address: string) => {
  const { openaiCompatible: key, openaiCompatibleOrigins: origins } = readStoredKeys();
  if (key === undefined) return null;
  const origin = speechServerOrigin(address);
  const approved = origin !== null && origins.includes(origin);
  return { keyId: keyIdOf(key), approvedKey: approved ? key : undefined };
};

export const approveSpeechServer = (address: string, keyId: string): 'added' | 'kept' | 'refused' => {
  const keys = readStoredKeys();
  const origin = speechServerOrigin(address);
  if (origin === null || keys.openaiCompatible === undefined || keyIdOf(keys.openaiCompatible) !== keyId) return 'refused';
  if (keys.openaiCompatibleOrigins.includes(origin)) return 'kept';
  writeStoredKeys({ ...keys, openaiCompatibleOrigins: [...keys.openaiCompatibleOrigins, origin] });
  return 'added';
};

export const updateVoiceKeys = (body: VoiceKeysPatch, speechServer?: string) => {
  const patch = voiceKeysPatchSchema.parse(body);
  const next = { ...readStoredKeys() };
  for (const kind of VOICE_KEY_KINDS) {
    if (!(kind in patch)) continue;
    const value = patch[kind];
    if (value) next[kind] = value;
    else delete next[kind];
  }
  if ('openaiCompatible' in patch) {
    const origin = next.openaiCompatible === undefined ? null : speechServerOrigin(speechServer);
    next.openaiCompatibleOrigins = origin === null ? [] : [origin];
  }
  writeStoredKeys(next);
  return describeVoiceKeys();
};
