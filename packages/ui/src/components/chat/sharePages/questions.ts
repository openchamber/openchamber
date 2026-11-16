import { blockQuestions, parseUiBlock } from '../uiBlocks/catalog';

/**
 * The questions a shared `ui` page asks, read off its own fields (Choice,
 * Input, DateInput, Slider), or none when the program does not parse. Loaded
 * on demand: the parser is the UI block language, which the chat keeps out of
 * its first load.
 */
export function sharePageQuestions(source: string): string[] {
  const parsed = parseUiBlock(source, true);
  return parsed.kind === 'ready' ? blockQuestions(parsed.root) : [];
}
