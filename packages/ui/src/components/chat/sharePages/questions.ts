import { blockQuestions, parseUiBlock } from '../uiBlocks/catalog';

export function sharePageQuestions(source: string): string[] {
  const parsed = parseUiBlock(source, true);
  return parsed.kind === 'ready' ? blockQuestions(parsed.root) : [];
}
