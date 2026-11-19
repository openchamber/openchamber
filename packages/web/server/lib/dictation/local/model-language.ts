
const WHISPER_LANGUAGES = new Set([
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it',
  'id', 'hi', 'fi', 'vi', 'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur',
  'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk', 'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn',
  'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw', 'gl', 'mr', 'pa', 'si',
  'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
  'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha',
  'ba', 'jw', 'su',
]);
const WHISPER_V3_MODELS = new Set(['whisper-large-v3-turbo-int8']);

interface ModelLanguageNames {
  [code: string]: string;
}

const QWEN3_LANGUAGES: ModelLanguageNames = {
  zh: 'Chinese', en: 'English', yue: 'Cantonese', ar: 'Arabic', de: 'German', fr: 'French',
  es: 'Spanish', pt: 'Portuguese', id: 'Indonesian', it: 'Italian', ko: 'Korean', ru: 'Russian',
  th: 'Thai', vi: 'Vietnamese', ja: 'Japanese', tr: 'Turkish', hi: 'Hindi', ms: 'Malay',
  nl: 'Dutch', sv: 'Swedish', da: 'Danish', fi: 'Finnish', pl: 'Polish', cs: 'Czech',
  fil: 'Filipino', fa: 'Persian', el: 'Greek', hu: 'Hungarian', mk: 'Macedonian', ro: 'Romanian',
};

export function resolveModelLanguage(modelId: string | undefined, modelType: string, language: string | undefined) {
  const code = String(language ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (!code) return '';
  if (modelType === 'whisper') {
    const known = WHISPER_LANGUAGES.has(code) || (code === 'yue' && modelId !== undefined && WHISPER_V3_MODELS.has(modelId));
    return known ? code : '';
  }
  if (modelType === 'qwen3_asr') return QWEN3_LANGUAGES[code] ?? '';
  return '';
}
