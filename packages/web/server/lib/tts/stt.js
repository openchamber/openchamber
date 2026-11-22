/**
 * Server-side Speech-to-Text Service
 *
 * Proxies audio to any OpenAI-compatible transcription endpoint
 * (e.g. faster-whisper, whisper.cpp) using the OpenAI Node SDK.
 */

import { loadOpenAI } from './openai-sdk.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';

// Transcription is a synchronous user-facing call against a local model
// server the user pointed the service at, and a CPU transcription of an
// uploaded recording can legitimately run near realtime, so its deadline
// is larger than the speech one: 120 s. It is still the whole budget, with
// no SDK retries (the defaults are a 10 minute timeout and 2 retries,
// which would hold the route for about half an hour on a wedged server).
// The user re-issues the request; a stall retry only multiplies the wait.
const TRANSCRIPTION_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Transcribe an audio buffer via an OpenAI-compatible /v1/audio/transcriptions endpoint.
 *
 * @param {object} opts
 * @param {Buffer} opts.audioBuffer  - Raw audio bytes
 * @param {string} opts.mimeType     - MIME type of the audio (e.g. 'audio/webm')
 * @param {string} opts.model        - Model name accepted by the remote server
 * @param {string} [opts.baseURL]    - Base URL of the compatible server (including /v1)
 * @param {string} [opts.apiKey]     - Optional API key for the compatible server
 * @param {string} [opts.language]   - Optional BCP-47 language hint (e.g. 'en')
 * @param {number} [opts.timeoutMs]  - Request deadline (default TRANSCRIPTION_REQUEST_TIMEOUT_MS)
 * @returns {Promise<string>} Transcribed text
 */
export async function transcribeAudio({ audioBuffer, mimeType, model, baseURL, apiKey, language, timeoutMs = TRANSCRIPTION_REQUEST_TIMEOUT_MS }) {
  const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL);
  if (normalizedBaseURLResult.error) {
    throw new Error(normalizedBaseURLResult.error);
  }

  const normalizedBaseURL = normalizedBaseURLResult.value;
  if (!normalizedBaseURL) {
    throw new Error('Custom server URL is required');
  }

  // Only the key the user typed for this server goes to it. The server's own
  // OPENAI_API_KEY belongs to whoever runs it and must not follow a URL that
  // any signed-in user can set (TTS draws the same line in service.js).
  const clientOpts = {
    apiKey: apiKey || 'not-required',
  };
  clientOpts.baseURL = normalizedBaseURL;
  clientOpts.timeout = timeoutMs;
  clientOpts.maxRetries = 0;

  const OpenAI = await loadOpenAI();
  const client = new OpenAI(clientOpts);

  // Derive a sensible filename extension from the MIME type so the server
  // can infer the codec when it isn't explicit in the stream header.
  const ext = mimeTypeToExt(mimeType);
  const filename = `audio.${ext}`;

  const file = await OpenAI.toFile(audioBuffer, filename, { type: mimeType });

  const result = await client.audio.transcriptions.create({
    file,
    model,
    response_format: 'json',
    ...(language ? { language } : {}),
  });

  return result.text ?? '';
}

/**
 * Map a MIME type to a file extension understood by Whisper servers.
 * @param {string} mimeType
 * @returns {string}
 */
function mimeTypeToExt(mimeType) {
  const type = (mimeType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'mp4',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
  };
  return map[type] ?? 'webm';
}
