import * as React from 'react';

import type { ReviewCommentExcerpt } from '@/lib/api/types';

export const MarkdownSuggestionContext = React.createContext<{ excerpt: ReviewCommentExcerpt | null } | null>(null);

export const isSuggestionLanguage = (language: string): boolean => /^suggestion(?::|$)/i.test(language);

export const suggestionPatch = (code: string, excerpt: ReviewCommentExcerpt | null): string => {
  const suggested = code === '' ? [] : code.replace(/\r\n/g, '\n').split('\n');
  const original = excerpt?.lines ?? [];
  const start = excerpt?.startLine ?? 1;
  const at = (count: number) => (count === 0 ? start - 1 : start);
  return [
    `@@ -${at(original.length)},${original.length} +${at(suggested.length)},${suggested.length} @@`,
    ...original.map((line) => `-${line}`),
    ...suggested.map((line) => `+${line}`),
  ].join('\n');
};
