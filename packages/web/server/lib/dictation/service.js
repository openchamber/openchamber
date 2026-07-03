/**
 * Dictation service: resolves STT providers, tracks local model download
 * state, and exposes a readiness snapshot for the status route.
 *
 * Providers:
 * - 'local' (default): sherpa-onnx Parakeet running in a worker process.
 *   Models auto-download in the background on first use.
 * - 'openai-compatible': any OpenAI-compatible /v1/audio/transcriptions
 *   endpoint (faster-whisper, whisper.cpp, OpenAI).
 */

import { DictationWorkerClient, WorkerBackedTranscriptionSession } from './local/worker-client.js';
import { OpenAICompatibleTranscriptionSession } from './openai-compatible-session.js';
import {
  DEFAULT_LOCAL_STT_MODEL,
  LOCAL_STT_MODEL_CATALOG,
  LOCAL_STT_MODEL_IDS,
  isLocalSttModelId,
} from './local/model-catalog.js';
import { ensureLocalSttModel, isLocalSttModelInstalled } from './local/model-downloader.js';

export function createDictationService({ modelsDir }) {
  const workerClient = new DictationWorkerClient();
  /** modelId -> 'downloading' | 'error' */
  const downloadStates = new Map();
  /** modelId -> last download error message */
  const downloadErrors = new Map();
  /** modelId -> in-flight ensure promise */
  const downloadPromises = new Map();

  const startModelDownload = (modelId) => {
    const existing = downloadPromises.get(modelId);
    if (existing) {
      return existing;
    }
    downloadStates.set(modelId, 'downloading');
    downloadErrors.delete(modelId);
    const promise = ensureLocalSttModel({ modelsDir, modelId })
      .then(() => {
        downloadStates.delete(modelId);
        downloadPromises.delete(modelId);
      })
      .catch((error) => {
        downloadStates.set(modelId, 'error');
        downloadErrors.set(modelId, error?.message || String(error));
        downloadPromises.delete(modelId);
      });
    downloadPromises.set(modelId, promise);
    return promise;
  };

  const resolveLocalModelId = (requested) => {
    return isLocalSttModelId(requested) ? requested : DEFAULT_LOCAL_STT_MODEL;
  };

  /**
   * Create a connected StreamingTranscriptionSession for one dictation.
   * Returns { session } on success or { error, retryable, reasonCode } when
   * the provider is not ready.
   *
   * @param {{ provider?: string, language?: string, localModel?: string,
   *           openaiCompatible?: { baseUrl?: string, model?: string, apiKey?: string } }} options
   */
  const createSttSession = async (options = {}) => {
    const provider = options.provider === 'openai-compatible' ? 'openai-compatible' : 'local';

    if (provider === 'openai-compatible') {
      const config = options.openaiCompatible || {};
      const session = new OpenAICompatibleTranscriptionSession({
        baseURL: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey || undefined,
        language: options.language || undefined,
      });
      try {
        await session.connect();
      } catch (error) {
        return {
          error: error?.message || String(error),
          retryable: false,
          reasonCode: 'stt_not_configured',
        };
      }
      return { session };
    }

    const modelId = resolveLocalModelId(options.localModel);
    const installed = await isLocalSttModelInstalled(modelsDir, modelId);
    if (!installed) {
      const state = downloadStates.get(modelId);
      if (state === 'error') {
        const message = downloadErrors.get(modelId) || 'Model download failed';
        // Allow a retry on the next attempt.
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

    const session = new WorkerBackedTranscriptionSession(workerClient, { modelsDir, modelId });
    try {
      await session.connect();
    } catch (error) {
      return {
        error: error?.message || String(error),
        retryable: true,
        reasonCode: 'stt_unavailable',
      };
    }
    return { session };
  };

  /**
   * Readiness snapshot for the status route and UI gating.
   * @param {{ provider?: string, localModel?: string }} [options]
   */
  const getStatus = async (options = {}) => {
    const provider = options.provider === 'openai-compatible' ? 'openai-compatible' : 'local';
    const modelId = resolveLocalModelId(options.localModel);

    const models = await Promise.all(
      LOCAL_STT_MODEL_IDS.map(async (id) => ({
        id,
        description: LOCAL_STT_MODEL_CATALOG[id].description,
        installed: await isLocalSttModelInstalled(modelsDir, id),
        downloading: downloadStates.get(id) === 'downloading',
        downloadError: downloadErrors.get(id) || null,
      })),
    );

    if (provider === 'openai-compatible') {
      return { provider, available: true, models };
    }

    const model = models.find((entry) => entry.id === modelId) || null;
    if (model?.installed) {
      return { provider, available: true, activeModel: modelId, models };
    }
    if (model?.downloading) {
      return {
        provider,
        available: false,
        reasonCode: 'model_download_in_progress',
        activeModel: modelId,
        models,
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
      };
    }
    return {
      provider,
      available: false,
      reasonCode: 'models_missing',
      activeModel: modelId,
      models,
    };
  };

  /**
   * Kick off a background download for a model (used by the status route's
   * download action so Settings can pre-download models).
   */
  const requestModelDownload = async (modelId) => {
    if (!isLocalSttModelId(modelId)) {
      return { ok: false, error: 'Unknown model id' };
    }
    if (await isLocalSttModelInstalled(modelsDir, modelId)) {
      return { ok: true, installed: true };
    }
    void startModelDownload(modelId);
    return { ok: true, installed: false };
  };

  const shutdown = () => {
    workerClient.shutdown();
  };

  return {
    createSttSession,
    getStatus,
    requestModelDownload,
    shutdown,
  };
}
