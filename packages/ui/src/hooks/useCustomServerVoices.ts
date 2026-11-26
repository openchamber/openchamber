import * as React from 'react';
import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { markKeyProvidersStale, originOf, subscribeKeyProvidersStale } from '@/lib/voice/keyProviders';
import { approveSpeechServer, rememberSpeechServerKeyId } from '@/lib/voice/speechServerKey';
import { useConfigStore } from '@/stores/useConfigStore';

const VOICE_LIST_FAILURES = ['invalid_base_url', 'remote_disabled', 'enterprise_mode', 'rejected_key', 'key_not_sent', 'unreachable', 'redirected', 'list_too_large', 'upstream_error'] as const;
export type VoiceListFailure = (typeof VOICE_LIST_FAILURES)[number];

type CustomServerVoiceList =
  | { kind: 'none' }
  | { kind: 'listed'; voices: readonly string[] }
  | { kind: 'failed'; code: VoiceListFailure };

type VoiceListAnswer = { baseURL: string; runtimeKey: string; list: CustomServerVoiceList };

const NO_LIST = { kind: 'none' } satisfies CustomServerVoiceList;
const LOAD_FAILED = { kind: 'failed', code: 'upstream_error' } satisfies CustomServerVoiceList;

const voiceListAnswerSchema = z.union([
  z.object({ voices: z.array(z.string()) }),
  z.object({ code: z.enum(VOICE_LIST_FAILURES) }),
]);

const keyIdSchema = z.object({ keyId: z.string().optional() });

const parseJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const ROUTE_MISSING_STATUSES = new Set([404, 405]);

export const readVoiceListAnswer = (status: number, text: string): CustomServerVoiceList => {
  const answer = voiceListAnswerSchema.safeParse(parseJson(text));
  if (!answer.success) return ROUTE_MISSING_STATUSES.has(status) ? NO_LIST : LOAD_FAILED;
  if ('code' in answer.data) return { kind: 'failed', code: answer.data.code };
  return answer.data.voices.length > 0 ? { kind: 'listed', voices: answer.data.voices } : NO_LIST;
};

const fetchCustomServerVoices = async (baseURL: string, keyProvider: string | undefined, runtimeKey: string, signal: AbortSignal) => {
  try {
    const response = await runtimeFetch('/api/tts/voices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ baseURL, keyProvider }),
      signal,
    });
    const text = await response.text();
    const list = readVoiceListAnswer(response.status, text);
    const keyId = keyIdSchema.safeParse(parseJson(text));
    if (keyId.success && !signal.aborted) rememberSpeechServerKeyId(runtimeKey, keyId.data.keyId);
    return list;
  } catch {
    return LOAD_FAILED;
  }
};

export function useCustomServerVoices(serverUrl: string, committedUrl: string, keyRevision: number, keyProvider: string | undefined) {
  const baseURL = serverUrl.trim();
  const requestedURL = committedUrl.trim();
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const loadVoiceKeys = useConfigStore((state) => state.refreshVoiceApiKeys);
  const [answer, setAnswer] = React.useState<VoiceListAnswer | null>(null);
  const [retries, setRetries] = React.useState(0);

  React.useEffect(() => {
    if (!requestedURL || baseURL !== requestedURL) return;
    const controller = new AbortController();
    void loadVoiceKeys()
      .then(() => {
        if (controller.signal.aborted || getRuntimeKey() !== runtimeKey) return null;
        return fetchCustomServerVoices(requestedURL, keyProvider, runtimeKey, controller.signal);
      })
      .then((list) => {
        if (list && !controller.signal.aborted) setAnswer({ baseURL: requestedURL, runtimeKey, list });
      });
    return () => controller.abort();
  }, [baseURL, requestedURL, runtimeKey, keyRevision, keyProvider, retries, loadVoiceKeys]);

  React.useEffect(() => subscribeKeyProvidersStale((grantedOrigin) => {
    if (grantedOrigin !== null && grantedOrigin === originOf(baseURL)) setRetries((count) => count + 1);
  }), [baseURL]);

  const retry = React.useCallback(() => {
    void approveSpeechServer(baseURL).then(() => markKeyProvidersStale(originOf(baseURL)));
  }, [baseURL]);

  const list = answer !== null && answer.baseURL === baseURL && answer.runtimeKey === runtimeKey ? answer.list : NO_LIST;
  return { list, retry };
}
