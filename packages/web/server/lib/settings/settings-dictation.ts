import { z } from 'zod';
import { isBoolean, isString } from '../shared/object-guards.js';
import type { SanitizedSettings, SettingsDocument } from './settings-helpers.js';

const STT_SERVER_URL_MAX_LENGTH = 2048;
const STT_ENDPOINT_PATH_MAX_LENGTH = 1024;
const STT_MODEL_MAX_LENGTH = 256;
const STT_LANGUAGE_MAX_LENGTH = 64;
const STT_PROMPT_MAX_LENGTH = 4096;

export const sanitizeDictationSettings = (candidate: SettingsDocument, result: SanitizedSettings) => {
  if (isBoolean(candidate.dictationEnabled)) {
    result.dictationEnabled = candidate.dictationEnabled;
  }
  const dictationAutoSend = z.boolean().safeParse(candidate.dictationAutoSend);
  if (dictationAutoSend.success) result.dictationAutoSend = dictationAutoSend.data;
  if (isString(candidate.sttProvider)) {
    const provider = candidate.sttProvider.trim();
    if (provider === 'local' || provider === 'openai-compatible') {
      result.sttProvider = provider;
    } else if (provider === 'server') {
      result.sttProvider = 'openai-compatible';
    } else if (provider === 'browser' || provider === 'wasm') {
      result.sttProvider = 'local';
    }
  }
  if (isString(candidate.sttServerUrl)) {
    const trimmed = candidate.sttServerUrl.trim();
    if (trimmed.length <= STT_SERVER_URL_MAX_LENGTH) {
      result.sttServerUrl = trimmed;
    }
  }
  if (isString(candidate.sttModel)) {
    const trimmed = candidate.sttModel.trim();
    if (trimmed.length <= STT_MODEL_MAX_LENGTH) {
      result.sttModel = trimmed;
    }
  }
  const sttEndpointPath = z.string().trim().safeParse(candidate.sttEndpointPath);
  if (sttEndpointPath.success && sttEndpointPath.data.length <= STT_ENDPOINT_PATH_MAX_LENGTH) {
    result.sttEndpointPath = sttEndpointPath.data;
  }
  if (isString(candidate.sttLocalModel)) {
    const trimmed = candidate.sttLocalModel.trim();
    if (trimmed.length <= STT_MODEL_MAX_LENGTH) {
      result.sttLocalModel = trimmed;
    }
  }
  if (isString(candidate.sttLanguage)) {
    const trimmed = candidate.sttLanguage.trim();
    if (trimmed.length <= STT_LANGUAGE_MAX_LENGTH) {
      result.sttLanguage = trimmed;
    }
  }
  const sttPrompt = z.string().max(STT_PROMPT_MAX_LENGTH).safeParse(candidate.sttPrompt);
  if (sttPrompt.success) result.sttPrompt = sttPrompt.data;
  if (candidate.sttCorrectTranscript === true || candidate.sttCorrectTranscript === false) {
    result.sttCorrectTranscript = candidate.sttCorrectTranscript;
  }
};
