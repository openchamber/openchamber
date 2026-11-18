import type { SayVoice } from './capability-runtime.js';

type Script = 'hangul' | 'kana' | 'han' | 'cyrillic' | 'greek' | 'arabic' | 'hebrew' | 'thai' | 'devanagari' | 'latin';

export interface DetectedTextLanguage {
  language: string;
  script: Script;
}

const SCRIPT_RANGES: [Script, RegExp][] = [
  ['hangul', /[가-힯ᄀ-ᇿ㄰-㆏]/g],
  ['kana', /[぀-ヿ]/g],
  ['han', /[一-鿿㐀-䶿]/g],
  ['cyrillic', /[Ѐ-ӿ]/g],
  ['greek', /[Ͱ-Ͽ]/g],
  ['arabic', /[؀-ۿ]/g],
  ['hebrew', /[֐-׿]/g],
  ['thai', /[฀-๿]/g],
  ['devanagari', /[ऀ-ॿ]/g],
  ['latin', /[A-Za-zÀ-ɏ]/g],
];

const SCRIPT_LANGUAGE = {
  hangul: 'ko',
  greek: 'el',
  arabic: 'ar',
  hebrew: 'he',
  thai: 'th',
  devanagari: 'hi',
};

const hasScriptLanguage = (script: Script): script is keyof typeof SCRIPT_LANGUAGE => script in SCRIPT_LANGUAGE;

const LATIN_MARKERS = {
  pl: /[łęąńśźż]/i,
  cs: /[řěůťďň]/i,
  tr: /[ğışİ]/,
  pt: /[ãõ]/i,
  es: /[ñ¿¡]/,
  de: /[ß]/,
  fr: /[œ]/i,
  sv: /[å]/i,
};

const STOPWORDS = {
  en: ['the', 'and', 'is', 'to', 'of', 'that', 'you', 'with', 'for', 'this', 'are', 'it', 'not', 'have', 'can', 'will', 'your', 'from', 'which', 'when'],
  de: ['und', 'der', 'die', 'das', 'ist', 'nicht', 'mit', 'ein', 'eine', 'auch', 'sich', 'auf', 'für', 'wird', 'werden', 'oder', 'aber', 'wenn', 'sind', 'kann'],
  fr: ['le', 'la', 'les', 'et', 'est', 'une', 'des', 'pour', 'que', 'qui', 'dans', 'pas', 'vous', 'sur', 'avec', 'sont', 'nous', 'cette', 'mais', 'plus'],
  es: ['el', 'la', 'los', 'las', 'que', 'es', 'una', 'por', 'para', 'con', 'del', 'como', 'pero', 'más', 'este', 'esta', 'son', 'tiene', 'puede', 'también'],
  it: ['il', 'la', 'che', 'di', 'è', 'una', 'per', 'non', 'con', 'del', 'della', 'come', 'sono', 'anche', 'questo', 'questa', 'gli', 'nel', 'più', 'essere'],
  pt: ['o', 'a', 'os', 'as', 'que', 'é', 'uma', 'para', 'com', 'não', 'do', 'da', 'como', 'mas', 'também', 'este', 'esta', 'são', 'você', 'pode'],
  pl: ['i', 'nie', 'jest', 'się', 'na', 'to', 'że', 'jak', 'ale', 'dla', 'oraz', 'przez', 'czy', 'tym', 'jego', 'można', 'jeśli', 'tego', 'które', 'także'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'niet', 'dat', 'met', 'voor', 'ook', 'zijn', 'maar', 'als', 'wordt', 'deze', 'kan', 'naar', 'bij', 'dan'],
  cs: ['a', 'je', 'se', 'na', 'to', 'že', 'jak', 'ale', 'pro', 'nebo', 'jsou', 'může', 'také', 'tento', 'když', 'jeho', 'které', 'být', 'aby', 'ještě'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'de', 'da', 'ama', 'gibi', 'daha', 'var', 'olarak', 'çok', 'ne', 'her', 'kadar', 'sonra', 'değil', 'olan', 'ise'],
  sv: ['och', 'att', 'det', 'är', 'en', 'som', 'för', 'inte', 'med', 'till', 'den', 'kan', 'har', 'ett', 'men', 'också', 'eller', 'från', 'när', 'vara'],
  uk: ['і', 'та', 'що', 'це', 'не', 'як', 'для', 'він', 'вона', 'але', 'або', 'також', 'тільки', 'вже', 'якщо', 'його', 'цей', 'ця', 'бути', 'коли'],
  ru: ['и', 'что', 'это', 'не', 'как', 'для', 'он', 'она', 'но', 'или', 'также', 'только', 'уже', 'если', 'его', 'этот', 'эта', 'быть', 'когда', 'чтобы'],
};

type StopwordLanguage = keyof typeof STOPWORDS;

const LATIN_LANGUAGES: StopwordLanguage[] = ['en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'nl', 'cs', 'tr', 'sv'];
const CYRILLIC_LANGUAGES: StopwordLanguage[] = ['uk', 'ru'];

const countMatches = (text: string, pattern: RegExp) => {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
};

const scoreStopwords = (words: string[], languages: StopwordLanguage[]) => {
  const scores: Record<string, number> = {};
  for (const language of languages) {
    const list = new Set(STOPWORDS[language]);
    let hits = 0;
    for (const word of words) {
      if (list.has(word)) hits += 1;
    }
    scores[language] = hits;
  }
  return scores;
};

const bestOf = (scores: Record<string, number>, fallback: string) => {
  let best = fallback;
  let bestScore = 0;
  for (const [language, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = language;
      bestScore = score;
    }
  }
  return best;
};

const pickByMarkers = (text: string, markers: Record<string, RegExp>) => {
  for (const [language, pattern] of Object.entries(markers)) {
    if (pattern.test(text)) return language;
  }
  return null;
};

export function detectTextLanguage(text: string): DetectedTextLanguage {
  const source = text;
  const counts = SCRIPT_RANGES.map<[Script, number]>(([script, pattern]) => [script, countMatches(source, pattern)]);
  const letters = counts.reduce((sum, [, count]) => sum + count, 0);
  if (letters === 0) return { language: 'en', script: 'latin' };

  const kana = counts.find(([script]) => script === 'kana')?.[1] ?? 0;
  const han = counts.find(([script]) => script === 'han')?.[1] ?? 0;
  if (kana > 0 && kana + han >= letters * 0.3) return { language: 'ja', script: 'kana' };
  if (han > 0 && han >= letters * 0.3) return { language: 'zh', script: 'han' };

  const [script] = counts.reduce((best, entry) => (entry[1] > best[1] ? entry : best));

  if (hasScriptLanguage(script)) return { language: SCRIPT_LANGUAGE[script], script };

  const words = source.toLowerCase().split(/[^\p{L}\p{M}']+/u).filter(Boolean);

  if (script === 'cyrillic') {
    const scores = scoreStopwords(words, CYRILLIC_LANGUAGES);
    const ukMarkers = countMatches(source, /[іїєґ]/gi);
    const ruMarkers = countMatches(source, /[ыэъё]/gi);
    if (ukMarkers !== ruMarkers) return { language: ukMarkers > ruMarkers ? 'uk' : 'ru', script };
    if (scores.uk !== scores.ru) return { language: (scores.uk ?? 0) > (scores.ru ?? 0) ? 'uk' : 'ru', script };
    return { language: ruMarkers > 0 ? 'ru' : 'uk', script };
  }

  const scores = scoreStopwords(words, LATIN_LANGUAGES);
  const marked = pickByMarkers(source, LATIN_MARKERS);
  if (marked && (scores[marked] ?? 0) * 2 >= (scores[bestOf(scores, marked)] ?? 0)) {
    return { language: marked, script };
  }
  return { language: bestOf(scores, 'en'), script };
}

function localePrefixesForLanguage(language: string) {
  const table = {
    en: ['en_US', 'en_GB', 'en'],
    uk: ['uk_UA', 'uk'],
    ru: ['ru_RU', 'ru'],
    de: ['de_DE', 'de'],
    fr: ['fr_FR', 'fr_CA', 'fr'],
    es: ['es_ES', 'es_MX', 'es'],
    it: ['it_IT', 'it'],
    pt: ['pt_BR', 'pt_PT', 'pt'],
    pl: ['pl_PL', 'pl'],
    nl: ['nl_NL', 'nl_BE', 'nl'],
    cs: ['cs_CZ', 'cs'],
    tr: ['tr_TR', 'tr'],
    sv: ['sv_SE', 'sv'],
    zh: ['zh_CN', 'zh_TW', 'zh_HK', 'zh'],
    ja: ['ja_JP', 'ja'],
    ko: ['ko_KR', 'ko'],
    el: ['el_GR', 'el'],
    ar: ['ar_001', 'ar_SA', 'ar'],
    he: ['he_IL', 'he'],
    th: ['th_TH', 'th'],
    hi: ['hi_IN', 'hi'],
  };
  const hasPrefixes = (key: string): key is keyof typeof table => key in table;
  return hasPrefixes(language) ? table[language] ?? [language] : [language];
}

export function pickVoiceForLanguage(language: string, voices: ReadonlyArray<SayVoice>) {
  const prefixes = localePrefixesForLanguage(language);
  for (const prefix of prefixes) {
    const matching = voices.filter((voice) => voice.locale === prefix || voice.locale.startsWith(`${prefix}_`) || (prefix === language && voice.locale.startsWith(`${language}_`)));
    const [first] = matching;
    if (!first) continue;
    const enhanced = matching.find((voice) => /\((Enhanced|Premium)\)/i.test(voice.name));
    return (enhanced ?? first).name;
  }
  return null;
}

export function languageOfLocale(locale: string | null | undefined) {
  if (!locale) return null;
  const [language = ''] = locale.split(/[_-]/);
  return language.toLowerCase();
}
