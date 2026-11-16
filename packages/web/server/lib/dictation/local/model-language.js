
// external: https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-whisper-model.cc Unknown Whisper language codes terminate the process, so validate hints first.
const WHISPER_LANGUAGES = new Set([
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it',
  'id', 'hi', 'fi', 'vi', 'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur',
  'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk', 'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn',
  'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw', 'gl', 'mr', 'pa', 'si',
  'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
  'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha',
  'ba', 'jw', 'su',
]);
// external: https://github.com/openai/whisper/blob/main/whisper/tokenizer.py Cantonese is available in large-v3 and turbo; earlier exports lack it.
const WHISPER_V3_MODELS = new Set(['whisper-large-v3-turbo-int8']);

// external: https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-recognizer-qwen3-asr-impl.h Qwen3-ASR uses language names in its prompt.
const QWEN3_LANGUAGES = {
  zh: 'Chinese', en: 'English', yue: 'Cantonese', ar: 'Arabic', de: 'German', fr: 'French',
  es: 'Spanish', pt: 'Portuguese', id: 'Indonesian', it: 'Italian', ko: 'Korean', ru: 'Russian',
  th: 'Thai', vi: 'Vietnamese', ja: 'Japanese', tr: 'Turkish', hi: 'Hindi', ms: 'Malay',
  nl: 'Dutch', sv: 'Swedish', da: 'Danish', fi: 'Finnish', pl: 'Polish', cs: 'Czech',
  fil: 'Filipino', fa: 'Persian', el: 'Greek', hu: 'Hungarian', mk: 'Macedonian', ro: 'Romanian',
};

/**
 * @param {string} modelId catalog id
 * @param {string} modelType catalog `type`
 * @param {string | undefined} language user setting
 * @returns {string}
 */
export function resolveModelLanguage(modelId, modelType, language) {
  const code = String(language ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (!code) return '';
  if (modelType === 'whisper') {
    const known = WHISPER_LANGUAGES.has(code) || (code === 'yue' && WHISPER_V3_MODELS.has(modelId));
    return known ? code : '';
  }
  if (modelType === 'qwen3_asr') return QWEN3_LANGUAGES[code] ?? '';
  return '';
}
