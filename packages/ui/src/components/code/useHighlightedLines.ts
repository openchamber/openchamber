import React from 'react';
import { getHighlightedLines, highlightLines } from '@/components/chat/markdown/highlightedCode';
import { carryUnchangedLines, type ReadyHighlight } from './carryHighlightedLines';

export type HighlightedLinesResult =
  | { status: 'loading'; lines: null; carriedLines: readonly (string | undefined)[] }
  | { status: 'ready'; lines: string[] }
  | { status: 'failed'; lines: null };

type HighlightState = HighlightedLinesResult & {
  code: string;
  language: string;
  lastReady: ReadyHighlight | null;
};

const getHighlightState = (code: string, language: string, lastReady: ReadyHighlight | null): HighlightState => {
  const lines = getHighlightedLines(code, language);
  return lines
    ? { status: 'ready', lines, code, language, lastReady: { code, language, lines } }
    : { status: 'loading', lines: null, carriedLines: carryUnchangedLines(lastReady, code, language), code, language, lastReady };
};

export const useHighlightedLines = (code: string, language: string): HighlightedLinesResult => {
  const normalizedLanguage = (language || 'text').toLowerCase();
  const [state, setState] = React.useState<HighlightState>(() => getHighlightState(code, normalizedLanguage, null));

  React.useEffect(() => {
    setState((previous) => getHighlightState(code, normalizedLanguage, previous.lastReady));
    if (getHighlightedLines(code, normalizedLanguage)) return;

    let active = true;
    void highlightLines(code, normalizedLanguage).then((lines) => {
      if (!active) return;
      setState((previous) => (lines
        ? { status: 'ready', lines, code, language: normalizedLanguage, lastReady: { code, language: normalizedLanguage, lines } }
        : { status: 'failed', lines: null, code, language: normalizedLanguage, lastReady: previous.lastReady }));
    });
    return () => {
      active = false;
    };
  }, [code, normalizedLanguage]);

  const current = React.useMemo(
    () => (state.code === code && state.language === normalizedLanguage
      ? state
      : getHighlightState(code, normalizedLanguage, state.lastReady)),
    [code, normalizedLanguage, state],
  );
  return current;
};
