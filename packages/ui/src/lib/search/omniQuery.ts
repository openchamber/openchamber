export type OmniLifecycle = 'active' | 'archived' | 'all';
/** `messages`: message text only, so a title match alone does not list a conversation. */
export type OmniSearchIn = 'everything' | 'titles' | 'messages';
export type OmniAuthor = 'any' | 'user' | 'assistant' | 'reasoning';

/** The one narrowing a conversation search offers: where to look for the words. */
export type SearchScope = 'everything' | 'titles' | 'user' | 'assistant' | 'reasoning';

/** An author scope looks in that author's messages only, so titles step aside. */
export const searchScopeQuery = (scope: SearchScope): { searchIn: OmniSearchIn; author: OmniAuthor } => (
  scope === 'everything' || scope === 'titles' ? { searchIn: scope, author: 'any' } : { searchIn: 'messages', author: scope }
);
