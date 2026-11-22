import React from 'react';

import { emojiInlinePicker } from '@/components/emoji/emojiInlinePicker';
import type { CaretCoords } from '@/components/inline-picker/placement';
import { useInlinePicker } from '@/components/inline-picker/useInlinePicker';
import { useI18n } from '@/lib/i18n';
import { snippetInlinePicker } from './snippetInlinePicker';

const COMMENT_PICKERS = [snippetInlinePicker, emojiInlinePicker];

export function useCommentFieldPicker({
  text,
  getCaret,
  replaceRange,
  caretCoords,
}: {
  text: string;
  getCaret: () => number;
  replaceRange: (from: number, to: number, insert: string) => void;
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
