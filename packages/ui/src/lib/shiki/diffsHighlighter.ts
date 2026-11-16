import { canUseWASM, EXTENSION_TO_FILE_FORMAT, setCustomExtension, type HighlighterTypes } from '@pierre/diffs';

import { LANGUAGE_RELATIVES } from './languageRelatives';

// @pierre/diffs runs one highlighter type per thread and throws when a render
// asks for another, so the worker pool and every main-thread File or PatchDiff
// pass this same value. Highlights needs WebAssembly with SIMD; where that is
// missing, Shiki's JavaScript engine highlights instead.
export const DIFFS_HIGHLIGHTER: HighlighterTypes = canUseWASM() ? 'highlights' : 'shiki-js';

/** The language to give @pierre/diffs for an explicit `lang`. */
export const toDiffsLanguage = (lang: string | null): string | undefined => {
  if (!lang) return undefined;
  return DIFFS_HIGHLIGHTER === 'highlights' ? LANGUAGE_RELATIVES.get(lang) ?? lang : lang;
};

// Config files @pierre/diffs does not recognize by name.
const FILE_NAME_LANGUAGES = {
  '.editorconfig': 'toml',
  '.gitmodules': 'toml',
  '.npmrc': 'toml',
};

// Diffs infer the language from the file name; the pool forwards these
// mappings to its workers.
if (DIFFS_HIGHLIGHTER === 'highlights') {
  for (const [extension, lang] of Object.entries(EXTENSION_TO_FILE_FORMAT)) {
    const alias = lang && LANGUAGE_RELATIVES.get(lang);
    if (alias) setCustomExtension(extension, alias);
  }
  for (const [name, lang] of Object.entries(FILE_NAME_LANGUAGES)) setCustomExtension(name, lang);
}
