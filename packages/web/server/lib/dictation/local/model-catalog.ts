
import path from 'path';

export interface LocalModelCatalogEntry {
  type: 'nemo_transducer' | 'whisper' | 'qwen3_asr' | 'kokoro' | 'vits';
  archiveUrl: string;
  extractedDir: string;
  files: Record<string, string>;
  description: string;
  languages?: string[];
  defaultSpeakerByLanguage?: Record<string, number>;
  lexicon?: string[];
}

export interface LocalModelCatalog {
  [modelId: string]: LocalModelCatalogEntry;
}

export const LOCAL_STT_MODEL_CATALOG: LocalModelCatalog = {
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
  'parakeet-ultra-int8': {
    type: 'nemo_transducer',
    archiveUrl:
      'https://github.com/openchamber/openchamber/releases/download/asr-models/sherpa-onnx-nemo-parakeet-ultra-int8.tar.bz2',
    extractedDir: 'sherpa-onnx-nemo-parakeet-ultra-int8',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    description: 'Moondream Parakeet Ultra (25 European languages, auto-detected)',
  },
  'whisper-large-v3-turbo-int8': {
    type: 'whisper',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-turbo',
    files: {
      encoder: 'turbo-encoder.int8.onnx',
      decoder: 'turbo-decoder.int8.onnx',
      tokens: 'turbo-tokens.txt',
    },
    description: 'OpenAI Whisper large-v3 turbo (99 languages, auto-detected)',
  },
  'qwen3-asr-0.6b-int8': {
    type: 'qwen3_asr',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2',
    extractedDir: 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25',
    files: {
      convFrontend: 'conv_frontend.onnx',
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      tokenizer: 'tokenizer',
    },
    description: 'Qwen3-ASR 0.6B (30 languages, auto-detected)',
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

export const LOCAL_TTS_MODEL_CATALOG: LocalModelCatalog = {
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

export const DEFAULT_LOCAL_STT_MODEL = 'parakeet-ultra-int8';

export const PREVIOUS_DEFAULT_LOCAL_STT_MODEL = 'parakeet-tdt-0.6b-v2-int8';

export const REPLACED_DEFAULT_LOCAL_STT_MODEL = 'parakeet-tdt-0.6b-v3-int8';

export const RETIRED_LOCAL_MODEL_DIRS = ['sherpa-onnx-whisper-base'];

export const DEFAULT_LOCAL_TTS_MODEL = 'kokoro-en-v0_19';

export const LOCAL_STT_MODEL_IDS = Object.keys(LOCAL_STT_MODEL_CATALOG);
export const LOCAL_TTS_MODEL_IDS = Object.keys(LOCAL_TTS_MODEL_CATALOG);

export function isLocalSttModelId(modelId: unknown): modelId is string {
  return typeof modelId === 'string' && Object.hasOwn(LOCAL_STT_MODEL_CATALOG, modelId);
}

export function isLocalTtsModelId(modelId: unknown): modelId is string {
  return typeof modelId === 'string' && Object.hasOwn(LOCAL_TTS_MODEL_CATALOG, modelId);
}

export function isLocalModelId(modelId: unknown): modelId is string {
  return isLocalSttModelId(modelId) || isLocalTtsModelId(modelId);
}

export function getLocalSttModelSpec(modelId: string) {
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

export function resolveLocalTtsModelForLanguage(language: string, preferredModelId?: string) {
  const speaks = (modelId: string) => LOCAL_TTS_MODEL_CATALOG[modelId]?.languages?.includes(language) === true;
  if (preferredModelId && speaks(preferredModelId)) return preferredModelId;
  const candidate = LOCAL_TTS_MODEL_IDS.find(speaks);
  return candidate ?? null;
}

export function getLocalTtsDefaultSpeaker(modelId: string, language: string) {
  const speaker = LOCAL_TTS_MODEL_CATALOG[modelId]?.defaultSpeakerByLanguage?.[language];
  return Number.isInteger(speaker) ? speaker : undefined;
}

export function getLocalSttModelDir(modelsDir: string, modelId: string) {
  return path.join(modelsDir, getLocalSttModelSpec(modelId).extractedDir);
}
