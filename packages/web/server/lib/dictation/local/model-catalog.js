/**
 * Catalog of local sherpa-onnx STT models available for dictation.
 * Models are downloaded on demand from the k2-fsa GitHub releases and
 * extracted under the OpenChamber speech-models directory.
 *
 * `type` selects the recognizer construction path in the worker:
 * - 'nemo_transducer': encoder/decoder/joiner transducer (Parakeet)
 * - 'whisper': encoder/decoder Whisper export
 * `files` maps logical roles to file names inside the extracted directory.
 */

import path from 'path';

export const LOCAL_STT_MODEL_CATALOG = {
  'parakeet-tdt-0.6b-v2-int8': {
    type: 'nemo_transducer',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    extractedDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    description: 'NVIDIA Parakeet TDT v2 (English)',
  },
  'parakeet-tdt-0.6b-v3-int8': {
    type: 'nemo_transducer',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    extractedDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    description: 'NVIDIA Parakeet TDT v3 (25 European languages, auto-detected)',
  },
  'whisper-base-int8': {
    type: 'whisper',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-base',
    files: {
      encoder: 'base-encoder.int8.onnx',
      decoder: 'base-decoder.int8.onnx',
      tokens: 'base-tokens.txt',
    },
    description: 'OpenAI Whisper base (multilingual, smaller and lighter)',
  },
  'whisper-tiny-int8': {
    type: 'whisper',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-tiny',
    files: {
      encoder: 'tiny-encoder.int8.onnx',
      decoder: 'tiny-decoder.int8.onnx',
      tokens: 'tiny-tokens.txt',
    },
    description: 'OpenAI Whisper tiny (multilingual, fastest and lightest)',
  },
};

/**
 * Local text-to-speech models (sherpa-onnx OfflineTts). Downloaded and
 * managed through the same pipeline as the STT models.
 */
/**
 * Local text-to-speech models (sherpa-onnx OfflineTts). Downloaded and
 * managed through the same pipeline as the STT models.
 *
 * `languages` lists the languages a model speaks well; the speech service
 * uses it to pick a model for the language a text is written in. Kokoro
 * models carry speaker ids (`voices`); a Piper model is one voice for one
 * language. `lexicon` entries are joined with commas for sherpa-onnx.
 */
export const LOCAL_TTS_MODEL_CATALOG = {
  'kokoro-en-v0_19': {
    type: 'kokoro',
    languages: ['en'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2',
    extractedDir: 'kokoro-en-v0_19',
    files: {
      model: 'model.onnx',
      voices: 'voices.bin',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Kokoro TTS (English, natural voices)',
  },
  'kokoro-multi-lang-v1_1': {
    type: 'kokoro',
    languages: ['zh', 'en'],
    // sherpa-onnx wires this Kokoro build for Chinese and English only;
    // speakers 0-2 are English, 3-102 Chinese.
    defaultSpeakerByLanguage: { en: 0, zh: 3 },
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2',
    extractedDir: 'kokoro-multi-lang-v1_1',
    files: {
      model: 'model.onnx',
      voices: 'voices.bin',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
      lexiconEnglish: 'lexicon-us-en.txt',
      lexiconChinese: 'lexicon-zh.txt',
    },
    lexicon: ['lexiconEnglish', 'lexiconChinese'],
    description: 'Kokoro TTS (Chinese and English, 103 voices)',
  },
  // The larger `ukrainian_tts-medium` build is a character-level model
  // (`phoneme_type: text`); sherpa-onnx phonemizes every Piper model through
  // espeak-ng, which turns that one into noise. `vits-coqui-uk-mai` sounds
  // better but reads Cyrillic only and drops every Latin word (file names,
  // product names), which is unusable in a coding chat. Lada is an espeak
  // model: small, but it reads mixed text.
  'piper-uk_UA-lada-x_low': {
    type: 'vits',
    languages: ['uk'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-uk_UA-lada-x_low.tar.bz2',
    extractedDir: 'vits-piper-uk_UA-lada-x_low',
    files: {
      model: 'uk_UA-lada-x_low.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (Ukrainian)',
  },
  'piper-de_DE-thorsten-medium': {
    type: 'vits',
    languages: ['de'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-de_DE-thorsten-medium.tar.bz2',
    extractedDir: 'vits-piper-de_DE-thorsten-medium',
    files: {
      model: 'de_DE-thorsten-medium.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (German)',
  },
  'piper-fr_FR-siwis-medium': {
    type: 'vits',
    languages: ['fr'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-fr_FR-siwis-medium.tar.bz2',
    extractedDir: 'vits-piper-fr_FR-siwis-medium',
    files: {
      model: 'fr_FR-siwis-medium.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (French)',
  },
  'piper-es_ES-davefx-medium': {
    type: 'vits',
    languages: ['es'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_ES-davefx-medium.tar.bz2',
    extractedDir: 'vits-piper-es_ES-davefx-medium',
    files: {
      model: 'es_ES-davefx-medium.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (Spanish)',
  },
  'piper-it_IT-paola-medium': {
    type: 'vits',
    languages: ['it'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-it_IT-paola-medium.tar.bz2',
    extractedDir: 'vits-piper-it_IT-paola-medium',
    files: {
      model: 'it_IT-paola-medium.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (Italian)',
  },
  'piper-pt_BR-faber-medium': {
    type: 'vits',
    languages: ['pt'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-pt_BR-faber-medium.tar.bz2',
    extractedDir: 'vits-piper-pt_BR-faber-medium',
    files: {
      model: 'pt_BR-faber-medium.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (Portuguese (Brazil))',
  },
  'piper-pl_PL-gosia-medium': {
    type: 'vits',
    languages: ['pl'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-pl_PL-gosia-medium.tar.bz2',
    extractedDir: 'vits-piper-pl_PL-gosia-medium',
    files: {
      model: 'pl_PL-gosia-medium.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (Polish)',
  },
  'piper-ru_RU-irina-medium': {
    type: 'vits',
    languages: ['ru'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-irina-medium.tar.bz2',
    extractedDir: 'vits-piper-ru_RU-irina-medium',
    files: {
      model: 'ru_RU-irina-medium.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (Russian)',
  },
  'piper-nl_NL-pim-medium': {
    type: 'vits',
    languages: ['nl'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-nl_NL-pim-medium.tar.bz2',
    extractedDir: 'vits-piper-nl_NL-pim-medium',
    files: {
      model: 'nl_NL-pim-medium.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (Dutch)',
  },
  'piper-cs_CZ-jirka-medium': {
    type: 'vits',
    languages: ['cs'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-cs_CZ-jirka-medium.tar.bz2',
    extractedDir: 'vits-piper-cs_CZ-jirka-medium',
    files: {
      model: 'cs_CZ-jirka-medium.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (Czech)',
  },
  'piper-tr_TR-dfki-medium': {
    type: 'vits',
    languages: ['tr'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-tr_TR-dfki-medium.tar.bz2',
    extractedDir: 'vits-piper-tr_TR-dfki-medium',
    files: {
      model: 'tr_TR-dfki-medium.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (Turkish)',
  },
  'piper-sv_SE-nst-medium': {
    type: 'vits',
    languages: ['sv'],
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-sv_SE-nst-medium.tar.bz2',
    extractedDir: 'vits-piper-sv_SE-nst-medium',
    files: {
      model: 'sv_SE-nst-medium.onnx',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Piper TTS (Swedish)',
  },
};

export const DEFAULT_LOCAL_STT_MODEL = 'parakeet-tdt-0.6b-v2-int8';
export const DEFAULT_LOCAL_TTS_MODEL = 'kokoro-en-v0_19';

export const LOCAL_STT_MODEL_IDS = Object.keys(LOCAL_STT_MODEL_CATALOG);
export const LOCAL_TTS_MODEL_IDS = Object.keys(LOCAL_TTS_MODEL_CATALOG);

/**
 * @param {string} modelId
 * @returns {boolean}
 */
export function isLocalSttModelId(modelId) {
  return typeof modelId === 'string' && Object.hasOwn(LOCAL_STT_MODEL_CATALOG, modelId);
}

/**
 * @param {string} modelId
 * @returns {boolean}
 */
export function isLocalTtsModelId(modelId) {
  return typeof modelId === 'string' && Object.hasOwn(LOCAL_TTS_MODEL_CATALOG, modelId);
}

/**
 * Any managed local model (STT or TTS).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isLocalModelId(modelId) {
  return isLocalSttModelId(modelId) || isLocalTtsModelId(modelId);
}

/**
 * Spec lookup across both catalogs (STT and TTS).
 * @param {string} modelId
 */
export function getLocalSttModelSpec(modelId) {
  const spec = LOCAL_STT_MODEL_CATALOG[modelId] ?? LOCAL_TTS_MODEL_CATALOG[modelId];
  if (!spec) {
    throw new Error(`Unknown local speech model id: ${modelId}`);
  }
  return {
    id: modelId,
    ...spec,
    requiredFiles: Object.values(spec.files),
  };
}

/**
 * The local TTS model to use for a language, preferring the model the user
 * selected when it speaks that language. Returns null when no catalog model
 * covers the language, in which case callers keep the selected model.
 * @param {string} language BCP-47 primary subtag (`uk`, `zh`...)
 * @param {string} [preferredModelId]
 * @returns {string | null}
 */
export function resolveLocalTtsModelForLanguage(language, preferredModelId) {
  const speaks = (modelId) => LOCAL_TTS_MODEL_CATALOG[modelId]?.languages?.includes(language) === true;
  if (preferredModelId && speaks(preferredModelId)) return preferredModelId;
  const candidate = LOCAL_TTS_MODEL_IDS.find(speaks);
  return candidate ?? null;
}

/**
 * The speaker id a model should use for a language when the caller's
 * speaker was chosen for another language. `undefined` keeps the caller's
 * speaker.
 * @param {string} modelId
 * @param {string} language
 * @returns {number | undefined}
 */
export function getLocalTtsDefaultSpeaker(modelId, language) {
  const speaker = LOCAL_TTS_MODEL_CATALOG[modelId]?.defaultSpeakerByLanguage?.[language];
  return Number.isInteger(speaker) ? speaker : undefined;
}

/**
 * @param {string} modelsDir
 * @param {string} modelId
 * @returns {string}
 */
export function getLocalSttModelDir(modelsDir, modelId) {
  return path.join(modelsDir, getLocalSttModelSpec(modelId).extractedDir);
}
