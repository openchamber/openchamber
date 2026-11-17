/**
 * Server-side Text-to-Speech Service
 *
 * Uses OpenAI's TTS API to generate audio on the server and stream it to clients.
 * This bypasses mobile Safari's audio context restrictions.
 */

import { readOpenCodeCredentials } from '../opencode/auth.js';
import { loadOpenAI } from './openai-sdk.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';

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
const readSpeechBody = async (response, timeoutMs, deadlineAt) => {
  let cancelReader = null;
  let timer = null;
  const deadline = new Promise((_, reject) => {
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
    if (!response.body || typeof response.body.getReader !== 'function') {
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
    const chunks = [];
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

// Voice options from OpenAI
/** @public */
export const TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
  'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
];

async function getOpenAIApiKey() {
  // First check environment variable
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    return envKey;
  }

  // Then the OpenAI credential stored in OpenCode (same as usage tracker)
  try {
    const auth = await readOpenCodeCredentials();
    // Check for openai, codex, or chatgpt aliases
    const openaiAuth = auth.openai || auth.codex || auth.chatgpt;
    if (openaiAuth) {
      // Handle both string format (just the token) and object format
      if (typeof openaiAuth === 'string') {
        return openaiAuth;
      }
      // Try access token first (OAuth), then regular token
      if (openaiAuth.access) {
        return openaiAuth.access;
      }
      if (openaiAuth.token) {
        return openaiAuth.token;
      }
    }
  } catch (error) {
    console.warn('[TTSService] Failed to read OpenCode credentials:', error.message);
  }

  return null;
}

/** @public */
export class TTSService {
  constructor() {
    this._client = null;
    this._lastApiKey = null;
  }

  async _getClient() {
    const apiKey = await getOpenAIApiKey();

    // If API key changed or client doesn't exist, create new client
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

  /**
   * Generate speech and return as a stream
   */
  async generateSpeechStream(options) {
    const {
      text,
      voice = 'coral',
      model = 'gpt-4o-mini-tts',
      speed = 1.0,
      instructions,
      apiKey,
      baseURL,
      timeoutMs = SPEECH_REQUEST_TIMEOUT_MS,
    } = options;

    const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL);
    if (normalizedBaseURLResult.error) {
      throw new Error(normalizedBaseURLResult.error);
    }
    const normalizedBaseURL = normalizedBaseURLResult.value;

    // Use provided API key / baseURL or fall back to configured key
    let client;
    if (normalizedBaseURL || apiKey) {
      const clientOpts = {};
      if (apiKey) clientOpts.apiKey = apiKey;
      if (!apiKey) clientOpts.apiKey = 'not-required';
      if (normalizedBaseURL) clientOpts.baseURL = normalizedBaseURL;
      clientOpts.timeout = timeoutMs;
      clientOpts.maxRetries = 0;
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
      // OpenAI-compatible servers (custom baseURL) may not support `instructions`,
      // but do support `speed`. `response_format: 'mp3'` is the documented default
      // for /v1/audio/speech, and strict servers (e.g. OpenRouter) reject requests
      // that omit it.
      const speechParams = normalizedBaseURL
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
      // Servers that ignore `response_format` may still label the bytes
      // correctly (or return an unexpected type); pass the upstream label
      // through and only fall back to mp3 when the server omits the header.
      const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType,
      };
    } catch (error) {
      console.error('[TTSService] Error generating speech:', error);
      throw new Error(`Failed to generate speech: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Generate speech and return as a buffer (for caching)
   */
  async generateSpeechBuffer(options) {
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

// Export singleton instance
/** @public */
export const ttsService = new TTSService();
