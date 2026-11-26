import { loadOpenAI } from './openai-sdk.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { createEndpointPathFetch, normalizeEndpointPath } from './endpoint-path.js';
import { z } from 'zod';
import { echoesKey, failureStatus, keyedCallFailure, keyedCallRefused } from './keyed-call.js';
import type { SpeechClientOptions, SpeechTranscriptionParams } from 'openai';

const DEFAULT_TRANSCRIPTION_PATH = '/audio/transcriptions';

export interface TranscribeAudioOptions {
  audioBuffer: Buffer;
  mimeType: string;
  model: unknown;
  baseURL?: Parameters<typeof normalizeCustomOpenAIBaseURL>[0];
  apiKey?: unknown;
  providerKey?: string | undefined;
  language?: unknown;
  prompt?: string | undefined;
  endpointPath?: Parameters<typeof normalizeEndpointPath>[0];
}

export async function transcribeAudio({ audioBuffer, mimeType, model, baseURL, apiKey, providerKey, language, prompt, endpointPath }: TranscribeAudioOptions) {
  const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL);
  if (normalizedBaseURLResult.error) {
    throw new Error(normalizedBaseURLResult.error);
  }

  const normalizedBaseURL = normalizedBaseURLResult.value;
  if (!normalizedBaseURL) {
    throw new Error('Custom server URL is required');
  }

  const endpointPathResult = normalizeEndpointPath(endpointPath);
  if (endpointPathResult.error) {
    throw new Error(endpointPathResult.error);
  }
  const normalizedEndpointPath = endpointPathResult.value;

  const clientOpts: SpeechClientOptions = {
    apiKey: providerKey || apiKey || 'not-required',
    fetchOptions: { redirect: 'manual' },
  };
  if (providerKey) clientOpts.logLevel = 'off';
  clientOpts.baseURL = normalizedBaseURL;
  if (normalizedEndpointPath) {
    clientOpts.fetch = createEndpointPathFetch({
      endpointPath: normalizedEndpointPath,
      defaultPath: DEFAULT_TRANSCRIPTION_PATH,
    });
  }

  const OpenAI = await loadOpenAI();
  const client = new OpenAI(clientOpts);

  const ext = mimeTypeToExt(mimeType);
  const filename = `audio.${ext}`;

  const file = await OpenAI.toFile(audioBuffer, filename, { type: mimeType });

  const params: SpeechTranscriptionParams = {
    file,
    model,
    response_format: 'json',
  };
  if (language) params.language = language;
  if (prompt) params.prompt = prompt;
  let result;
  try {
    result = await client.audio.transcriptions.create(params);
  } catch (error) {
    throw providerKey ? keyedCallFailure('Transcription', failureStatus.safeParse(error).data?.status) : error;
  }

  if (!providerKey) return result.text ?? '';
  const transcript = z.string().safeParse(result.text ?? '');
  if (!transcript.success || echoesKey(providerKey, transcript.data)) throw keyedCallRefused('Transcription');
  return transcript.data;
}

function mimeTypeToExt(mimeType: string) {
  const [mediaType = ''] = (mimeType || '').split(';');
  const type = mediaType.trim().toLowerCase();
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
  const hasExtension = (key: string): key is keyof typeof map => key in map;
  return hasExtension(type) ? map[type] ?? 'webm' : 'webm';
}
