import { z } from 'zod';

import { readBoundedResponseText } from '../guests/response-body.js';
import { echoesKey } from './keyed-call.js';

const VOICE_LIST_TIMEOUT_MS = 5_000;
const VOICE_LIST_MAX_BYTES = 1024 * 1024;
const VOICE_LIST_MAX_VOICES = 1000;
const NO_LIST_STATUSES = new Set([400, 404, 405, 410, 422, 501]);

const voiceId = z.union([
  z.string(),
  z.object({ id: z.string() }).transform((voice) => voice.id),
  z.object({ name: z.string() }).transform((voice) => voice.name),
]);
const voiceIds = z.array(z.unknown()).transform((items) => items.flatMap((item) => {
  const parsed = voiceId.safeParse(item);
  return parsed.success ? [parsed.data] : [];
}));
const voiceGroup = z.object({ voices: voiceIds });
const voiceList = z.union([
  z.object({ voices: voiceIds }).transform((answer) => answer.voices),
  z.object({ data: z.array(z.unknown()) }).transform((answer) => answer.data.flatMap((group) => {
    const parsed = voiceGroup.safeParse(group);
    return parsed.success ? parsed.data.voices : [];
  })),
]);

const parseVoiceIds = (text: string) => {
  try {
    return voiceList.safeParse(JSON.parse(text));
  } catch {
    return null;
  }
};

export const parseVoiceList = (text: string): string[] => {
  const parsed = parseVoiceIds(text);
  if (!parsed?.success) return [];
  const ids = parsed.data.map((id) => id.trim()).filter(Boolean);
  return [...new Set(ids)].slice(0, VOICE_LIST_MAX_VOICES);
};

export type VoiceListAnswer =
  | { voices: string[]; code?: undefined }
  | { code: 'unreachable' | 'redirected' | 'rejected_key' | 'list_too_large' | 'upstream_error' };

const answerWithoutBody = async (response: Response, answer: VoiceListAnswer): Promise<VoiceListAnswer> => {
  await response.body?.cancel().catch(() => {});
  return answer;
};

const VOICE_LIST_PATH = '/audio/voices';

const redirectsToVoiceList = (response: Response, requestURL: string) => {
  const location = response.headers.get('location');
  if (!location) return false;
  try {
    return new URL(location, requestURL).pathname.replace(/\/$/, '').endsWith(VOICE_LIST_PATH);
  } catch {
    return false;
  }
};

export const listCustomServerVoices = async (baseURL: string, { apiKey, providerKey }: { apiKey?: string | undefined; providerKey?: string | undefined } = {}, timeoutMs = VOICE_LIST_TIMEOUT_MS): Promise<VoiceListAnswer> => {
  const requestURL = `${baseURL}${VOICE_LIST_PATH}`;
  let response: Response;
  try {
    response = await fetch(requestURL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${providerKey || apiKey || 'not-required'}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { code: 'unreachable' };
  }
  if (response.status >= 300 && response.status < 400) {
    return answerWithoutBody(response, redirectsToVoiceList(response, requestURL) ? { code: 'redirected' } : { voices: [] });
  }
  if (response.status === 401 || response.status === 403) return answerWithoutBody(response, { code: 'rejected_key' });
  if (NO_LIST_STATUSES.has(response.status)) return answerWithoutBody(response, { voices: [] });
  if (!response.ok) return answerWithoutBody(response, { code: 'upstream_error' });
  let body;
  try {
    body = await readBoundedResponseText(response, VOICE_LIST_MAX_BYTES);
  } catch {
    return { code: 'unreachable' };
  }
  if (body.tooLarge) return { code: 'list_too_large' };
  const voices = parseVoiceList(body.text);
  if (echoesKey(providerKey, ...voices)) return { code: 'upstream_error' };
  return { voices };
};
