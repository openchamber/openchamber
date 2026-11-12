import React from 'react';
import {
  getCachedHighlightedLines,
  highlightLinesInWorker,
} from '@/components/chat/markdown/markdown-worker';
import { carryUnchangedLines, type ReadyHighlight } from './carryHighlightedLines';

// Tokenize a whole block ONCE in the Shiki worker and expose per-line inner
// HTML. For per-line layouts (diffs, gutters, virtualization) that would
// otherwise spawn one highlighter per row. Cached results are available on the
// first render; cold requests distinguish loading from permanent failure so
// callers can choose whether to reveal their plain-text fallback.
//
// Whole-block tokenization also restores cross-line syntax context (multi-line
// strings / comments) that independent per-line highlighting loses.
//
// While new code is tokenizing, `carriedLines` holds the previous result for
// every line whose text did not change, so a block that grows or is edited in
// place (a streaming write, an agent editing a file) keeps its colours instead
// of flashing to plain text. Lines that changed stay undefined.
export type WorkerHighlightedLinesResult =
  | { status: 'loading'; lines: null; carriedLines: readonly (string | undefined)[] }
  | { status: 'ready'; lines: string[] }
  | { status: 'failed'; lines: null };

type HighlightState = WorkerHighlightedLinesResult & {
  code: string;
  language: string;
  /** The latest ready result, kept across loading states to carry lines from. */
  lastReady: ReadyHighlight | null;
};

const getHighlightState = (code: string, language: string, lastReady: ReadyHighlight | null): HighlightState => {
  const lines = getCachedHighlightedLines(code, language);
  return lines
    ? { status: 'ready', lines, code, language, lastReady: { code, language, lines } }
    : { status: 'loading', lines: null, carriedLines: carryUnchangedLines(lastReady, code, language), code, language, lastReady };
};

export const useWorkerHighlightedLines = (code: string, language: string): WorkerHighlightedLinesResult => {
  const normalizedLanguage = (language || 'text').toLowerCase();
  const [state, setState] = React.useState<HighlightState>(() => getHighlightState(code, normalizedLanguage, null));

  React.useEffect(() => {
    setState((previous) => getHighlightState(code, normalizedLanguage, previous.lastReady));
    if (getCachedHighlightedLines(code, normalizedLanguage)) return;

    let active = true;
    void highlightLinesInWorker(code, normalizedLanguage).then((lines) => {
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
