/**
 * Server-side Speech-to-Text Service
 *
 * Proxies audio to any OpenAI-compatible transcription endpoint
 * (e.g. faster-whisper, whisper.cpp) using the OpenAI Node SDK.
 */

import OpenAI, { toFile } from 'openai';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';

/**
 * Transcribe an audio buffer via an OpenAI-compatible /v1/audio/transcriptions endpoint.
 *
 * @param {object} opts
 * @param {Buffer} opts.audioBuffer  - Raw audio bytes
 * @param {string} opts.mimeType     - MIME type of the audio (e.g. 'audio/webm')
 * @param {string} opts.model        - Model name accepted by the remote server
 * @param {string} [opts.baseURL]    - Base URL of the compatible server (including /v1)
 * @param {string} [opts.language]   - Optional BCP-47 language hint (e.g. 'en')
 * @returns {Promise<string>} Transcribed text
 */
export async function transcribeAudio({ audioBuffer, mimeType, model, baseURL, language }) {
  const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL);
  if (normalizedBaseURLResult.error) {
    throw new Error(normalizedBaseURLResult.error);
  }

  const normalizedBaseURL = normalizedBaseURLResult.value;
  if (!normalizedBaseURL) {
    throw new Error('Custom server URL is required');
  }

  const clientOpts = {
    apiKey: process.env.OPENAI_API_KEY || 'not-required',
  };
  clientOpts.baseURL = normalizedBaseURL;

  const client = new OpenAI(clientOpts);

  // Derive a sensible filename extension from the MIME type so the server
  // can infer the codec when it isn't explicit in the stream header.
  const ext = mimeTypeToExt(mimeType);
  const filename = `audio.${ext}`;

  const file = await toFile(audioBuffer, filename, { type: mimeType });

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
