import type { Agent } from '@/lib/opencode/model';
import type { Theme } from '@/types/theme';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useConfigStore } from '@/stores/useConfigStore';
import { filterVisibleAgents } from '@/stores/useAgentsStore';
import { createAgentColorResolver } from '@/lib/agentColors';

// Message footers share one allocation with the composer. Immutable theme and
// roster identities invalidate it; weak keys release obsolete snapshots.
const resolvers = new WeakMap<Theme, WeakMap<Agent[], ReturnType<typeof createAgentColorResolver>>>();

export function useAgentColors() {
  const { currentTheme } = useThemeSystem();
  const agents = useConfigStore((state) => state.agents);
  let byRoster = resolvers.get(currentTheme);
  if (!byRoster) {
    byRoster = new WeakMap();
    resolvers.set(currentTheme, byRoster);
  }
  let resolver = byRoster.get(agents);
  if (!resolver) {
    resolver = createAgentColorResolver(currentTheme, filterVisibleAgents(agents));
    byRoster.set(agents, resolver);
  }
  return resolver;
}
