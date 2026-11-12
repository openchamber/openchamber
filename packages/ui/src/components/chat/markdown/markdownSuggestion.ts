import * as React from 'react';

import type { ReviewCommentExcerpt } from '@/lib/api/types';

/**
 * Set around a review comment's body: a ```suggestion fence in it is the
 * change the reviewer proposes for the lines the comment sits on, drawn as a
 * diff against `excerpt`. A host that sends no excerpt shows the suggestion
 * as added lines. Outside a review comment the fence stays ordinary code.
 */
export const MarkdownSuggestionContext = React.createContext<{ excerpt: ReviewCommentExcerpt | null } | null>(null);

/** GitHub's fence, and GitLab's with a line range (`suggestion:-0+2`). */
export const isSuggestionLanguage = (language: string): boolean => /^suggestion(?::|$)/i.test(language);

/** The suggestion as one hunk replacing the excerpt's lines; an empty suggestion deletes them. */
export const suggestionPatch = (code: string, excerpt: ReviewCommentExcerpt | null): string => {
  const suggested = code === '' ? [] : code.replace(/\r\n/g, '\n').split('\n');
  const original = excerpt?.lines ?? [];
  const start = excerpt?.startLine ?? 1;
  // A side with no lines names the line before the hunk, as unified diffs do.
  const at = (count: number) => (count === 0 ? start - 1 : start);
  return [
    `@@ -${at(original.length)},${original.length} +${at(suggested.length)},${suggested.length} @@`,
    ...original.map((line) => `-${line}`),
    ...suggested.map((line) => `+${line}`),
  ].join('\n');
};
