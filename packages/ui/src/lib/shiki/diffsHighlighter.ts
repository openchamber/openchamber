import { canUseWASM, EXTENSION_TO_FILE_FORMAT, setCustomExtension, type HighlighterTypes } from '@pierre/diffs';

import { LANGUAGE_RELATIVES } from './languageRelatives';

export const DIFFS_HIGHLIGHTER: HighlighterTypes = canUseWASM() ? 'highlights' : 'shiki-js';

export const toDiffsLanguage = (lang: string | null): string | undefined => {
  if (!lang) return undefined;
  return DIFFS_HIGHLIGHTER === 'highlights' ? LANGUAGE_RELATIVES.get(lang) ?? lang : lang;
};

const FILE_NAME_LANGUAGES = {
  '.editorconfig': 'toml',
  '.gitmodules': 'toml',
  '.npmrc': 'toml',
};

if (DIFFS_HIGHLIGHTER === 'highlights') {
  for (const [extension, lang] of Object.entries(EXTENSION_TO_FILE_FORMAT)) {
    const alias = lang && LANGUAGE_RELATIVES.get(lang);
    if (alias) setCustomExtension(extension, alias);
  }
  for (const [name, lang] of Object.entries(FILE_NAME_LANGUAGES)) setCustomExtension(name, lang);
}
