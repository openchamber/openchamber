import { SnippetAutocomplete } from '@/components/chat/SnippetAutocomplete';
import { matchSnippetTrigger } from '@/components/chat/composer/language/triggers';
import type { InlinePicker } from '@/components/inline-picker/useInlinePicker';

/**
 * Snippets on `#`, the composer's picker for comment fields: choosing one
 * writes `#trigger ` over the typed query, and expansion happens when the
 * message is sent.
 */
export const snippetInlinePicker: InlinePicker = {
  id: 'snippet',
  match: (value, caret) => {
    const query = matchSnippetTrigger(value, caret);
    return query === null ? null : { from: caret - query.length - 1, query };
  },
  width: 420,
  render: ({ ref, query, style, close, write }) => (
    <SnippetAutocomplete ref={ref} searchQuery={query} onSnippetSelect={(_snippet, trigger) => write(`#${trigger} `)} onClose={close} style={style} />
  ),
};
