import { z } from 'zod';

import { readBoundedResponseText } from '../guests/response-body.js';

const VOICE_LIST_TIMEOUT_MS = 5_000;
const VOICE_LIST_MAX_BYTES = 1024 * 1024;
const VOICE_LIST_MAX_VOICES = 1000;
const NO_LIST_STATUSES = new Set([404, 405, 501]);

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

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const parseVoiceList = (text) => {
  const parsed = voiceList.safeParse(parseJson(text));
  if (!parsed.success) return [];
  const ids = parsed.data.map((id) => id.trim()).filter(Boolean);
  return [...new Set(ids)].slice(0, VOICE_LIST_MAX_VOICES);
};

const answerWithoutBody = async (response, answer) => {
  await response.body?.cancel().catch(() => {});
  return answer;
};

export const listCustomServerVoices = async (baseURL, apiKey, timeoutMs = VOICE_LIST_TIMEOUT_MS) => {
  let response;
  try {
    response = await fetch(`${baseURL}/audio/voices`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey || 'not-required'}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { code: 'unreachable' };
  }
  if (response.status >= 300 && response.status < 400) return answerWithoutBody(response, { code: 'redirected' });
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
  return { voices: parseVoiceList(body.text) };
};
