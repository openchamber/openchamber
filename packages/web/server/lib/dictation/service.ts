import { readVoiceKey } from '../tts/voice-keys.js';
import { approvedProviderKey } from '../tts/provider-keys.js';
import { detectTextLanguage } from '../tts/language-detect.js';

import { rm } from 'fs/promises';
import path from 'path';
import { z } from 'zod';

import { DictationWorkerClient, WorkerBackedTranscriptionSession } from './local/worker-client.js';
import { OpenAICompatibleTranscriptionSession } from './openai-compatible-session.js';
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  PREVIOUS_DEFAULT_LOCAL_STT_MODEL,
  REPLACED_DEFAULT_LOCAL_STT_MODEL,
  getLocalTtsDefaultSpeaker,
  resolveLocalTtsModelForLanguage,
  LOCAL_STT_MODEL_CATALOG,
  LOCAL_STT_MODEL_IDS,
  LOCAL_TTS_MODEL_CATALOG,
  LOCAL_TTS_MODEL_IDS,
  RETIRED_LOCAL_MODEL_DIRS,
  getLocalSttModelDir,
  isLocalModelId,
  isLocalSttModelId,
  isLocalTtsModelId,
} from './local/model-catalog.js';
import { ensureLocalSttModel, isLocalSttModelInstalled } from './local/model-downloader.js';
import type { LocalModelCatalog } from './local/model-catalog.js';
import type { DictationSessionResult, DictationStartOptions } from './stream-manager.js';

export interface DictationStatusOptions {
  provider?: string | undefined;
  localModel?: string | undefined;
}

export interface SynthesizeSpeechOptions {
  text: string;
  model?: string | undefined;
  speakerId?: number | undefined;
  speed?: number | undefined;
  language?: string | undefined;
  languageSample?: string | undefined;
}

interface OpenAICompatibleWireConfig {
  baseUrl?: unknown;
  model?: unknown;
  apiKey?: unknown;
  endpointPath?: unknown;
  prompt?: unknown;
  keyProvider?: unknown;
}

function hasConfigFields(value: unknown): value is OpenAICompatibleWireConfig {
  return Boolean(value);
}

function hasMessage(value: unknown): value is { message?: unknown } {
  return value !== null && value !== undefined;
}

export function createDictationService({ modelsDir }: { modelsDir: string }) {
  for (const dir of RETIRED_LOCAL_MODEL_DIRS) {
    void rm(path.join(modelsDir, dir), { recursive: true, force: true }).catch(() => undefined);
  }
  const workerClient = new DictationWorkerClient();
  const downloadStates = new Map<string, 'downloading' | 'error'>();
  const downloadErrors = new Map<string, unknown>();
  const downloadPromises = new Map<string, Promise<void>>();
  const downloadProgress = new Map<string, number | null>();

  const startModelDownload = (modelId: string) => {
    const existing = downloadPromises.get(modelId);
    if (existing) {
      return existing;
    }
    downloadStates.set(modelId, 'downloading');
    downloadErrors.delete(modelId);
    downloadProgress.set(modelId, 0);
    const promise = ensureLocalSttModel({
      modelsDir,
      modelId,
      onProgress: (downloadedBytes, totalBytes) => {
        downloadProgress.set(
          modelId,
          totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null,
        );
      },
    })
      .then(() => {
        downloadStates.delete(modelId);
        downloadPromises.delete(modelId);
        downloadProgress.delete(modelId);
      })
      .catch((cause: unknown) => {
        downloadStates.set(modelId, 'error');
        downloadErrors.set(modelId, (hasMessage(cause) && cause.message) || String(cause));
        downloadPromises.delete(modelId);
        downloadProgress.delete(modelId);
      });
    downloadPromises.set(modelId, promise);
    return promise;
  };

  const resolveLocalModelId = async (requested: DictationStartOptions['localModel']) => {
    if (isLocalSttModelId(requested)) {
      return requested;
    }
    if (await isLocalSttModelInstalled(modelsDir, PREVIOUS_DEFAULT_LOCAL_STT_MODEL)) {
      return PREVIOUS_DEFAULT_LOCAL_STT_MODEL;
    }
    if (
      !(await isLocalSttModelInstalled(modelsDir, DEFAULT_LOCAL_STT_MODEL))
      && (await isLocalSttModelInstalled(modelsDir, REPLACED_DEFAULT_LOCAL_STT_MODEL))
    ) {
      return REPLACED_DEFAULT_LOCAL_STT_MODEL;
    }
    return DEFAULT_LOCAL_STT_MODEL;
  };

  const createSttSession = async (options: DictationStartOptions = {}): Promise<DictationSessionResult> => {
    const provider = options.provider === 'openai-compatible' ? 'openai-compatible' : 'local';

    if (provider === 'openai-compatible') {
      const wireConfig = options.openaiCompatible;
      const config = hasConfigFields(wireConfig) ? wireConfig : {};
      const promptOption = z.string().trim().min(1).safeParse(config.prompt);
      const baseURL = z.string().safeParse(config.baseUrl).data;
      const keyProvider = z.string().safeParse(config.keyProvider).data;
      const apiKey = config.apiKey || readVoiceKey('stt');
      const session = new OpenAICompatibleTranscriptionSession({
        baseURL: config.baseUrl,
        model: config.model,
        apiKey,
        resolveProviderKey: apiKey ? undefined : () => approvedProviderKey(keyProvider, baseURL),
        language: options.language || undefined,
        prompt: promptOption.success ? promptOption.data : undefined,
        endpointPath: config.endpointPath,
      });
      try {
        await session.connect();
      } catch (error) {
        return {
          error: (hasMessage(error) && error.message) || String(error),
          retryable: false,
          reasonCode: 'stt_not_configured',
        };
      }
      return { session };
    }

    const modelId = await resolveLocalModelId(options.localModel);
    if (modelId === REPLACED_DEFAULT_LOCAL_STT_MODEL && !isLocalSttModelId(options.localModel)
      && downloadStates.get(DEFAULT_LOCAL_STT_MODEL) !== 'error') {
      void startModelDownload(DEFAULT_LOCAL_STT_MODEL);
    }
    const installed = await isLocalSttModelInstalled(modelsDir, modelId);
    if (!installed) {
      const state = downloadStates.get(modelId);
      if (state === 'error') {
        const message = downloadErrors.get(modelId) || 'Model download failed';
        downloadStates.delete(modelId);
        return {
          error: `Failed to download dictation model: ${message}`,
          retryable: true,
          reasonCode: 'model_download_failed',
        };
      }
      void startModelDownload(modelId);
      return {
        error: 'Dictation model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      };
    }

    const session = new WorkerBackedTranscriptionSession(workerClient, {
      modelsDir,
      modelId,
      language: options.language,
    });
    try {
      await session.connect();
    } catch (error) {
      const message = (hasMessage(error) && error.message) || String(error);
      if (/Load model|Protobuf parsing failed/i.test(`${message}`)) {
        await rm(getLocalSttModelDir(modelsDir, modelId), { recursive: true, force: true })
          .catch(() => undefined);
        return {
          error: 'Dictation model files were corrupt and have been removed; retry to re-download',
          retryable: true,
          reasonCode: 'model_corrupt',
        };
      }
      return {
        error: message,
        retryable: true,
        reasonCode: 'stt_unavailable',
      };
    }
    return { session };
  };

  const getStatus = async (options: DictationStatusOptions = {}) => {
    const provider = options.provider === 'openai-compatible' ? 'openai-compatible' : 'local';
    const modelId = await resolveLocalModelId(options.localModel);

    const describeModel = async (id: string, catalog: LocalModelCatalog) => {
      const model = catalog[id];
      if (model === undefined) throw new TypeError("Cannot read properties of undefined (reading 'description')");
      return {
        id,
        description: model.description,
        installed: await isLocalSttModelInstalled(modelsDir, id),
        downloading: downloadStates.get(id) === 'downloading',
        downloadProgress: downloadProgress.get(id) ?? null,
        downloadError: downloadErrors.get(id) || null,
      };
    };

    const models = await Promise.all(
      LOCAL_STT_MODEL_IDS.map((id) => describeModel(id, LOCAL_STT_MODEL_CATALOG)),
    );
    const ttsModels = await Promise.all(
      LOCAL_TTS_MODEL_IDS.map((id) => describeModel(id, LOCAL_TTS_MODEL_CATALOG)),
    );

    if (provider === 'openai-compatible') {
      return { provider, available: true, models, ttsModels };
    }

    const model = models.find((entry) => entry.id === modelId) || null;
    if (model?.installed) {
      return { provider, available: true, activeModel: modelId, models, ttsModels };
    }
    if (model?.downloading) {
      return {
        provider,
        available: false,
        reasonCode: 'model_download_in_progress',
        activeModel: modelId,
        models,
        ttsModels,
      };
    }
    if (model?.downloadError) {
      return {
        provider,
        available: false,
        reasonCode: 'model_download_failed',
        error: model.downloadError,
        activeModel: modelId,
        models,
        ttsModels,
      };
    }
    return {
      provider,
      available: false,
      reasonCode: 'models_missing',
      activeModel: modelId,
      models,
      ttsModels,
    };
  };

  const synthesizeSpeech = async ({ text, model, speakerId, speed, language, languageSample }: SynthesizeSpeechOptions) => {
    const requestedModelId = isLocalTtsModelId(model) ? model : DEFAULT_LOCAL_TTS_MODEL;
    let modelId = requestedModelId;
    let resolvedLanguage = null;
    if (language === 'auto') {
      resolvedLanguage = detectTextLanguage(languageSample || text).language;
      const forLanguage = resolveLocalTtsModelForLanguage(resolvedLanguage, requestedModelId);
      if (forLanguage && forLanguage !== requestedModelId) {
        modelId = forLanguage;
        speakerId = getLocalTtsDefaultSpeaker(modelId, resolvedLanguage);
      }
    }
    const installed = await isLocalSttModelInstalled(modelsDir, modelId);
    if (!installed) {
      const state = downloadStates.get(modelId);
      if (state === 'error') {
        const message = downloadErrors.get(modelId) || 'Model download failed';
        downloadStates.delete(modelId);
        return {
          error: `Failed to download TTS model: ${message}`,
          retryable: true,
          reasonCode: 'model_download_failed',
        };
      }
      void startModelDownload(modelId);
      return {
        error: 'TTS model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      };
    }

    const result = await workerClient.synthesizeSpeech({
      modelsDir,
      modelId,
      text,
      speakerId,
      speed,
    });
    return { audio: result.audio, format: result.format, modelId, language: resolvedLanguage };
  };

  const requestModelDownload = async (modelId: string | undefined) => {
    if (!isLocalModelId(modelId)) {
      return { ok: false, error: 'Unknown model id' };
    }
    if (await isLocalSttModelInstalled(modelsDir, modelId)) {
      return { ok: true, installed: true };
    }
    void startModelDownload(modelId);
    return { ok: true, installed: false };
  };

  const deleteModel = async (modelId: string | undefined) => {
    if (!isLocalModelId(modelId)) {
      return { ok: false, error: 'Unknown model id' };
    }
    if (downloadStates.get(modelId) === 'downloading') {
      return { ok: false, error: 'Model is downloading' };
    }
    await rm(getLocalSttModelDir(modelsDir, modelId), { recursive: true, force: true });
    downloadErrors.delete(modelId);
    return { ok: true };
  };

  const shutdown = () => {
    workerClient.shutdown();
  };

  return {
    createSttSession,
    synthesizeSpeech,
    getStatus,
    requestModelDownload,
    deleteModel,
    shutdown,
  };
}
