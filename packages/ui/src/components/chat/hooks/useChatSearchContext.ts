import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import { useChatSearchStore, type SearchContext } from '@/stores/useChatSearchStore';
import { getSearchablePartId } from './chatSearchPartIdentity';

export { getSearchablePartId } from './chatSearchPartIdentity';

export type SearchablePartType = 'text' | 'reasoning';

export const getSearchablePartType = (part: Part): SearchablePartType | null => {
  if (part.type === 'text' || part.type === 'reasoning') {
    return part.type;
  }
  return null;
};

export const useChatSearchContext = (
  messageId: string,
  part: Part,
  partIndex: number,
  override?: SearchContext,
): SearchContext | undefined => {
  const isOpen = useChatSearchStore((state) => state.isOpen);
  const query = useChatSearchStore((state) => state.query);
  const caseSensitive = useChatSearchStore((state) => state.flags.caseSensitive);
  const wholeWord = useChatSearchStore((state) => state.flags.wholeWord);
  const isRegex = useChatSearchStore((state) => state.flags.regex);
  const includeThinking = useChatSearchStore((state) => state.flags.includeThinking ?? false);
  const partType = getSearchablePartType(part);
  const partId = getSearchablePartId(messageId, part, partIndex);

  return React.useMemo(() => {
    if (override) {
      return override;
    }
    if (!isOpen || !query || !partType) {
      return undefined;
    }
    if (partType === 'reasoning' && !includeThinking) {
      return undefined;
    }

    return {
      query,
      caseSensitive,
      wholeWord,
      isRegex,
      messageId,
      partId,
      partType,
    } satisfies SearchContext;
  }, [caseSensitive, includeThinking, isOpen, isRegex, messageId, override, partId, partType, query, wholeWord]);
};
