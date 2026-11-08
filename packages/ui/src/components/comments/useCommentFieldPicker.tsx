import React from 'react';

import { emojiInlinePicker } from '@/components/emoji/emojiInlinePicker';
import type { CaretCoords } from '@/components/inline-picker/placement';
import { useInlinePicker } from '@/components/inline-picker/useInlinePicker';
import { useI18n } from '@/lib/i18n';
import { snippetInlinePicker } from './snippetInlinePicker';

const COMMENT_PICKERS = [snippetInlinePicker, emojiInlinePicker];

/**
 * The `#snippet` and `:emoji` pickers of a comment field, at its caret. The
 * host reports every text or caret change through `sync` (`typed` false for a
 * paste or a caret move), gives its keydown to `handleKeyDown` first, and
 * renders `picker` inside the field's wrapper, whose width the list keeps to.
 */
export function useCommentFieldPicker({
  text,
  getCaret,
  replaceRange,
  caretCoords,
}: {
  text: string;
  getCaret: () => number;
  /** Replace `[from, to)` with `insert` and leave the caret after it. */
  replaceRange: (from: number, to: number, insert: string) => void;
  /** Where the character at `position` is drawn, in viewport coordinates. */
  caretCoords: (position: number) => CaretCoords | null;
}) {
  const { direction } = useI18n();
  const textRef = React.useRef(text);
  React.useLayoutEffect(() => {
    textRef.current = text;
  }, [text]);
  return useInlinePicker({
    pickers: COMMENT_PICKERS,
    getText: React.useCallback(() => textRef.current, []),
    getCaret,
    replaceRange,
    caretCoords,
    rightToLeft: direction === 'rtl',
  });
}
