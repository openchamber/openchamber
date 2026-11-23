export type OmniLifecycle = 'active' | 'archived' | 'all';
export type OmniSearchIn = 'everything' | 'titles' | 'messages';
export type OmniAuthor = 'any' | 'user' | 'assistant' | 'reasoning';

export type SearchScope = 'everything' | 'titles' | 'user' | 'assistant' | 'reasoning';

export const searchScopeQuery = (scope: SearchScope): { searchIn: OmniSearchIn; author: OmniAuthor } => (
  scope === 'everything' || scope === 'titles' ? { searchIn: scope, author: 'any' } : { searchIn: 'messages', author: scope }
);
