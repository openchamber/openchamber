import React from 'react';
import { getHighlightedLines, highlightLines } from '@/components/chat/markdown/highlightedCode';
import { carryUnchangedLines, type ReadyHighlight } from './carryHighlightedLines';

// Tokenize a whole block ONCE and expose per-line inner HTML. For per-line
// layouts (diffs, gutters, virtualization) that would otherwise highlight row
// by row. Results are available on the first render once Highlights has
// loaded; until then the hook distinguishes loading from permanent failure
// (a runtime where Highlights cannot run) so callers can choose whether to
// reveal their plain-text fallback.
//
// Whole-block tokenization also restores cross-line syntax context (multi-line
// strings / comments) that independent per-line highlighting loses.
//
// While new code is tokenizing, `carriedLines` holds the previous result for
// every line whose text did not change, so a block that grows or is edited in
// place (a streaming write, an agent editing a file) keeps its colours instead
// of flashing to plain text. Lines that changed stay undefined.
export type HighlightedLinesResult =
  | { status: 'loading'; lines: null; carriedLines: readonly (string | undefined)[] }
  | { status: 'ready'; lines: string[] }
  | { status: 'failed'; lines: null };

type HighlightState = HighlightedLinesResult & {
  code: string;
  language: string;
  /** The latest ready result, kept across loading states to carry lines from. */
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

  // Props changed and the effect has not committed yet: answer for the new
  // code now, carrying from the result already on screen.
  const current = React.useMemo(
    () => (state.code === code && state.language === normalizedLanguage
      ? state
      : getHighlightState(code, normalizedLanguage, state.lastReady)),
    [code, normalizedLanguage, state],
  );
  return current;
};
