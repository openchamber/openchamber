import { isVSCodeRuntime } from '@/lib/desktop';
import type { SearchScope } from '@/lib/search/omniQuery';
import { useUIStore } from '@/stores/useUIStore';

const NO_SCOPES: readonly SearchScope[] = [];
const MESSAGE_SCOPES: readonly SearchScope[] = ['everything', 'titles', 'user', 'assistant'];
const MESSAGE_AND_REASONING_SCOPES: readonly SearchScope[] = [...MESSAGE_SCOPES, 'reasoning'];

export function useSearchScopes(): readonly SearchScope[] {
  const messageSearch = useUIStore((state) => state.messageSearchEnabled);
  const reasoning = useUIStore((state) => state.messageSearchReasoningEnabled && state.showReasoningTraces);
  if (!messageSearch || isVSCodeRuntime()) return NO_SCOPES;
  return reasoning ? MESSAGE_AND_REASONING_SCOPES : MESSAGE_SCOPES;
}

export const effectiveSearchScope = (scope: SearchScope, scopes: readonly SearchScope[]): SearchScope => (
  scopes.includes(scope) ? scope : 'everything'
);
