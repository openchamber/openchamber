import type React from 'react';

import { useTextareaInlinePicker } from '@/components/inline-picker/useTextareaInlinePicker';
import { emojiInlinePicker } from './emojiInlinePicker';

const EMOJI_ONLY = [emojiInlinePicker];

/** Emoji on `:` for a plain textarea; render the returned node beside it. */
export const useEmojiPicker = (fieldRef: React.RefObject<HTMLTextAreaElement | null>, enabled = true): React.ReactNode => (
  useTextareaInlinePicker(fieldRef, EMOJI_ONLY, enabled)
);
