import type { Snippet } from '@/types/snippet';

const SNIPPET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const SUGGESTED_NAME_WORDS = 3;
const SUGGESTED_NAME_MAX_LENGTH = 32;

const CYRILLIC_TO_LATIN = new Map(Object.entries({
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ё: 'e', ъ: '', ы: 'y', э: 'e',
}));

export const isValidSnippetName = (name: string): boolean => SNIPPET_NAME_PATTERN.test(name);

export const normalizeSnippetNameInput = (value: string): string => value
  .replace(/\s+/g, '-')
  .replace(/[^a-z0-9_-]/gi, '')
  .slice(0, 80);

export const findSnippetByTrigger = (snippets: readonly Snippet[], name: string): Snippet | undefined => {
  const key = name.toLowerCase();
  return snippets.find((snippet) => snippet.name.toLowerCase() === key || snippet.aliases.some((alias) => alias.toLowerCase() === key));
};

export const snippetNameProblem = (name: string, snippets: readonly Snippet[], own?: Snippet): 'invalid' | 'taken' | null => {
  if (!isValidSnippetName(name)) return 'invalid';
  const owner = findSnippetByTrigger(snippets, name);
  return owner && owner.filePath !== own?.filePath ? 'taken' : null;
};

export const uniqueSnippetName = (base: string, snippets: readonly Snippet[]): string => {
  let name = base;
  for (let counter = 2; findSnippetByTrigger(snippets, name); counter += 1) {
    name = `${base}-${counter}`;
  }
  return name;
};

export const withoutSnippetToken = (text: string, name: string): string => {
  if (!isValidSnippetName(name)) return text;
  const pattern = new RegExp(`#${name}(?![a-z0-9_-]) ?`, 'gi');
  const last = [...text.matchAll(pattern)].at(-1);
  if (!last || last.index === undefined) return text;
  return text.slice(0, last.index) + text.slice(last.index + last[0].length);
};

export const suggestSnippetName = (text: string, snippets: readonly Snippet[]): string => {
  const words = text
    .toLowerCase()
    .replace(/[Ѐ-ӿ]/g, (letter) => CYRILLIC_TO_LATIN.get(letter) ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, SUGGESTED_NAME_WORDS);
  const base = words.join('-').slice(0, SUGGESTED_NAME_MAX_LENGTH).replace(/-+$/, '');
  return uniqueSnippetName(isValidSnippetName(base) ? base : 'snippet', snippets);
};
