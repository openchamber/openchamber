import { readOpenCodeCredentials } from '../opencode/auth.js';
import { loadOpenAI } from './openai-sdk.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { createEndpointPathFetch, normalizeEndpointPath } from './endpoint-path.js';
import { isRecord, isString } from '../shared/object-guards.js';
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
  baseURL?: string | undefined;
  endpointPath?: string | undefined;
}

const DEFAULT_SPEECH_PATH = '/audio/speech';

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
      this._client = new OpenAI({ apiKey });
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
      const response = await client.audio.speech.create(speechParams);

      const arrayBuffer = await response.arrayBuffer();
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
      const response = await client.audio.speech.create({
        model,
        voice,
        input: text,
        speed,
        ...(instructions && { instructions }),
        response_format: 'mp3',
      });

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      console.error('[TTSService] Error generating speech buffer:', error);
      throw error;
    }
  }
}

export const ttsService = new TTSService();
