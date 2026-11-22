import { readOpenCodeCredentials } from '../opencode/auth.js';
import { loadOpenAI } from './openai-sdk.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { createEndpointPathFetch, normalizeEndpointPath } from './endpoint-path.js';
import { isFunction, isRecord, isString } from '../shared/object-guards.js';
import type OpenAI from 'openai';
import type { ClientOptions } from 'openai';
import type { SpeechCreateParams } from 'openai/resources/audio/speech';

type SpeechCredential = string | {
  type?: string;
  key?: string;
  access?: string | undefined;
  token?: string;
};

export interface SpeechOptions {
  text: string;
  voice?: SpeechCreateParams['voice'];
  model?: SpeechCreateParams['model'];
  speed?: number;
  instructions?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number;
  baseURL?: string | undefined;
  endpointPath?: string | undefined;
}

const DEFAULT_SPEECH_PATH = '/audio/speech';

// Speech generation is a synchronous user-facing call, usually against a
// local model server the user pointed the service at. The OpenAI SDK
// defaults (a 10 minute timeout and 2 retries) would hold a voice route
// for about half an hour when that server wedges, so the deadline here is
// the whole budget: 60 s, no retries. The user re-issues the request from
// the UI; a stall retry only multiplies the wait.
const SPEECH_REQUEST_TIMEOUT_MS = 60_000;

// One speech response is a few minutes of mp3 (the service always requests
// response_format 'mp3'): even 320 kbps audio for the longest, slowest
// response the API can produce stays under ~50 MB. The cap is sized
// generously above that; past it the response is not speech, it is a
// wedged or hostile server streaming forever, and buffering it would grow
// the process until it dies.
const SPEECH_BODY_MAX_BYTES = 64 * 1024 * 1024;

// The SDK deadline covers the wait for the response. The speech body is
// read after the create call settles, so that read is bounded by what is
// left of the SAME budget: callers pass the deadline instant they armed
// for the create call, and a server that answers near it and then stalls
// the body fails at the original deadline, not a second full timeout
// later. The body is consumed through its reader so the deadline
// can cancel the ACTIVE read — body.cancel() cannot do that once a read
// has locked the stream (e.g. from arrayBuffer()), which would leave the
// upstream connection open (Codex P2 on PR #839).
const readSpeechBody = async (response: Response, timeoutMs: number, deadlineAt: number) => {
  let cancelReader: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first so the timeout error wins the race, then cancel
      // through the reader that owns the locked stream: this terminates
      // the pending read and closes the upstream connection.
      reject(new Error(`Speech request timed out after ${timeoutMs} ms`));
      cancelReader?.();
    }, Math.max(0, deadlineAt - Date.now()));
    timer.unref?.();
  });

  const readBounded = (async () => {
    if (!response.body || !isFunction(response.body.getReader)) {
      // No reader to stream or cancel through. The SDK's fetch responses
      // always expose one, so this is non-standard response shapes only;
      // the read still races the deadline above and its result is
      // rejected over the cap, so this path is never an uncapped,
      // undeadlined arrayBuffer().
      const body = await response.arrayBuffer();
      if (body.byteLength > SPEECH_BODY_MAX_BYTES) {
        throw new Error(`Speech response exceeded the ${SPEECH_BODY_MAX_BYTES}-byte limit`);
      }
      return body;
    }
    const reader = response.body.getReader();
    cancelReader = () => {
      reader.cancel().catch(() => {});
    };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SPEECH_BODY_MAX_BYTES) {
        // Fail as soon as the cap is crossed: cancel the stream instead
        // of buffering a body that is already known to be rejected.
        cancelReader();
        throw new Error(`Speech response exceeded the ${SPEECH_BODY_MAX_BYTES}-byte limit`);
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body.buffer;
  })();

  try {
    return await Promise.race([readBounded, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
  'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
];

async function getOpenAIApiKey() {
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    return envKey;
  }

  try {
    const auth: Record<string, SpeechCredential> = await readOpenCodeCredentials();
    const openaiAuth = auth.openai || auth.codex || auth.chatgpt;
    if (openaiAuth) {
      if (isString(openaiAuth)) {
        return openaiAuth;
      }
      if (openaiAuth.access) {
        return openaiAuth.access;
      }
      if (openaiAuth.token) {
        return openaiAuth.token;
      }
    }
  } catch (error) {
    console.warn('[TTSService] Failed to read OpenCode credentials:', isRecord(error) ? error.message : undefined);
  }

  return null;
}

export class TTSService {
  _client: OpenAI | null;
  _lastApiKey: string | null;

  constructor() {
    this._client = null;
    this._lastApiKey = null;
  }

  async _getClient() {
    const apiKey = await getOpenAIApiKey();

    if (apiKey && (!this._client || this._lastApiKey !== apiKey)) {
      const OpenAI = await loadOpenAI();
      this._client = new OpenAI({ apiKey, timeout: SPEECH_REQUEST_TIMEOUT_MS, maxRetries: 0 });
      this._lastApiKey = apiKey;
    }

    return this._client;
  }

  async isAvailable() {
    return Boolean(await getOpenAIApiKey());
  }

  async generateSpeechStream(options: SpeechOptions) {
    const {
      text,
      voice = 'coral',
      model = 'gpt-4o-mini-tts',
      speed = 1.0,
      instructions,
      apiKey,
      baseURL,
      timeoutMs = SPEECH_REQUEST_TIMEOUT_MS,
      endpointPath,
    } = options;

    const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL);
    if (normalizedBaseURLResult.error) {
      throw new Error(normalizedBaseURLResult.error);
    }
    const normalizedBaseURL = normalizedBaseURLResult.value;

    const endpointPathResult = normalizeEndpointPath(endpointPath);
    if (endpointPathResult.error) {
      throw new Error(endpointPathResult.error);
    }
    const normalizedEndpointPath = endpointPathResult.value;
    if (normalizedEndpointPath && !normalizedBaseURL) {
      throw new Error('A custom endpoint path needs a custom server URL');
    }

    let client;
    if (normalizedBaseURL || apiKey) {
      const clientOpts: ClientOptions = { fetchOptions: { redirect: 'manual' } };
      if (apiKey) clientOpts.apiKey = apiKey;
      if (!apiKey) clientOpts.apiKey = 'not-required';
      if (normalizedBaseURL) clientOpts.baseURL = normalizedBaseURL;
      clientOpts.timeout = timeoutMs;
      clientOpts.maxRetries = 0;
      if (normalizedEndpointPath) {
        clientOpts.fetch = createEndpointPathFetch({
          endpointPath: normalizedEndpointPath,
          defaultPath: DEFAULT_SPEECH_PATH,
        });
      }
      const OpenAI = await loadOpenAI();
      client = new OpenAI(clientOpts);
    } else {
      client = await this._getClient();
    }

    if (!client) {
      throw new Error('TTS service not available. Configure OpenAI in OpenCode, provide an API key, or set a custom server URL in settings.');
    }

    if (!text.trim()) {
      throw new Error('Text is required for TTS');
    }

    try {
      const speechParams: SpeechCreateParams = normalizedBaseURL
        ? { model, voice, input: text, speed, response_format: 'mp3' }
        : {
            model,
            voice,
            input: text,
            speed,
            ...(instructions && { instructions }),
            response_format: 'mp3',
          };

      console.log('[TTSService] Generating speech — model:', model, 'voice:', voice, 'baseURL:', normalizedBaseURL ?? '(openai)');
      const deadlineAt = Date.now() + timeoutMs;
      const response = await client.audio.speech.create(speechParams, { timeout: timeoutMs });

      const arrayBuffer = await readSpeechBody(response, timeoutMs, deadlineAt);
      const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType,
      };
    } catch (error) {
      console.error('[TTSService] Error generating speech:', error);
      throw new Error(`Failed to generate speech: ${(isRecord(error) ? error.message : undefined) || 'Unknown error'}`);
    }
  }

  
  async generateSpeechBuffer(options: SpeechOptions) {
    const { timeoutMs = SPEECH_REQUEST_TIMEOUT_MS } = options;
    const client = await this._getClient();
    if (!client) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable or configure OpenAI in OpenCode.');
    }

    const {
      text,
      voice = 'coral',
      model = 'gpt-4o-mini-tts',
      speed = 1.0,
      instructions
    } = options;

    try {
      const deadlineAt = Date.now() + timeoutMs;
      const response = await client.audio.speech.create({
        model,
        voice,
        input: text,
        speed,
        ...(instructions && { instructions }),
        response_format: 'mp3',
      }, { timeout: timeoutMs });

      const arrayBuffer = await readSpeechBody(response, timeoutMs, deadlineAt);
      return Buffer.from(arrayBuffer);
    } catch (error) {
      console.error('[TTSService] Error generating speech buffer:', error);
      throw error;
    }
  }
}

export const ttsService = new TTSService();
