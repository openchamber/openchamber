import React from 'react';
import {
  getCachedHighlightedLines,
  highlightLinesInWorker,
} from '@/components/chat/markdown/markdown-worker';

// Tokenize a whole block ONCE in the Shiki worker and expose per-line inner
// HTML. For per-line layouts (diffs, gutters, virtualization) that would
// otherwise spawn one highlighter per row. Cached results are available on the
// first render; cold requests distinguish loading from permanent failure so
// callers can choose whether to reveal their plain-text fallback.
//
// Whole-block tokenization also restores cross-line syntax context (multi-line
// strings / comments) that independent per-line highlighting loses.
export type WorkerHighlightedLinesResult =
  | { status: 'loading'; lines: null }
  | { status: 'ready'; lines: string[] }
  | { status: 'failed'; lines: null };

type HighlightState = WorkerHighlightedLinesResult & {
  code: string;
  language: string;
};

const getHighlightState = (code: string, language: string): HighlightState => {
  const lines = getCachedHighlightedLines(code, language);
  return lines
    ? { status: 'ready', lines, code, language }
    : { status: 'loading', lines: null, code, language };
};

export const useWorkerHighlightedLines = (code: string, language: string): WorkerHighlightedLinesResult => {
  const normalizedLanguage = (language || 'text').toLowerCase();
  const [state, setState] = React.useState<HighlightState>(() => getHighlightState(code, normalizedLanguage));

  React.useEffect(() => {
    const cached = getCachedHighlightedLines(code, normalizedLanguage);
    if (cached) {
      setState({ status: 'ready', lines: cached, code, language: normalizedLanguage });
      return;
    }

    setState({ status: 'loading', lines: null, code, language: normalizedLanguage });
    let active = true;
    void highlightLinesInWorker(code, normalizedLanguage).then((lines) => {
      if (!active) return;
      setState(lines
        ? { status: 'ready', lines, code, language: normalizedLanguage }
        : { status: 'failed', lines: null, code, language: normalizedLanguage });
    });
    return () => {
      active = false;
    };
  }, [code, normalizedLanguage]);

  if (state.code !== code || state.language !== normalizedLanguage) {
    return getHighlightState(code, normalizedLanguage);
  }
  return state;
};
