import type { InlinePicker } from '@/components/inline-picker/useInlinePicker';
import { matchEmojiTrigger } from '@/lib/emoji/shortcodes';
import { EmojiAutocomplete } from './EmojiAutocomplete';

/** Emoji on `:`: choosing one writes the emoji itself and a space over `:query`. */
export const emojiInlinePicker: InlinePicker = {
  id: 'emoji',
  match: (value, caret) => {
    const query = matchEmojiTrigger(value, caret);
    return query === null ? null : { from: caret - query.length - 1, query };
  },
  typedOnly: true,
  width: 280,
  render: ({ ref, query, style, close, write }) => (
    <EmojiAutocomplete ref={ref} searchQuery={query} onEmojiSelect={(emoji) => write(`${emoji} `)} onClose={close} style={style} />
  ),
};
