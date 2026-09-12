import * as React from 'react';
import type { Agent } from '@opencode-ai/sdk/v2';
import { resolveComposerAgentDirectory } from '@/lib/composerAgentDirectory';
import { normalizePath } from '@/lib/pathNormalization';
import { useConfigStore } from '@/stores/useConfigStore';
import {
  filterVisibleAgents,
  selectLoadedAgentsForDirectory,
  useAgentsStore,
  type AgentWithExtras,
} from '@/stores/useAgentsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getAllSyncSessionMap } from '@/sync/sync-refs';

/**
 * The directory a composer's agent scope belongs to, resolved from its
 * session/draft identity. `undefined` means the identity is not known yet.
 */
export const useComposerAgentDirectory = (sessionId: string | null): string | null | undefined => {
  const getDirectoryForSession = useSessionUIStore((state) => state.getDirectoryForSession);
  const newSessionDraft = useSessionUIStore((state) => state.newSessionDraft);
  const globalSessionIsKnown = useGlobalSessionsStore((state) =>
    sessionId ? state.entityById.has(sessionId) : false,
  );

  return resolveComposerAgentDirectory({
    sessionId,
    sessionDirectory: sessionId ? getDirectoryForSession(sessionId) : null,
    // The global index is the reactive side; sync child stores can hold a
    // session before it is indexed there.
    sessionIsKnown: globalSessionIsKnown || (sessionId ? getAllSyncSessionMap().has(sessionId) : false),
    draft: newSessionDraft,
  });
};

/**
 * Agents a composer-bound picker may offer for `directory`.
 *
 * `directory` is tri-state on purpose:
 * - a path — that directory's own list, loaded on demand;
 * - `null` — a composer with no project directory (temp chat); only the
 *   no-directory list applies and the ambient project must not leak in;
 * - `undefined` — the target directory is not known yet, so the ambient list
 *   stays (fail open; never render an empty picker over a scope we cannot read).
 *
 * Until a scoped list has loaded, the ambient list is the fallback. That
 * fallback never offers another project's project-scoped agents.
 */
export const useVisibleAgentsForDirectory = (directory: string | null | undefined): Agent[] => {
  // Normalize once so this lookup key matches the send guard's
  // `normalizePath(...)` lookup against the same `agentsByDirectory` entry.
  const normalizedDirectory = directory === undefined ? undefined : normalizePath(directory);
  const scopedAgents = useAgentsStore((state) => selectLoadedAgentsForDirectory(state, normalizedDirectory));
  const ambientAgents = useConfigStore((state) => state.agents);

  React.useEffect(() => {
    if (normalizedDirectory === undefined) return;
    void useAgentsStore.getState().loadAgents(normalizedDirectory);
  }, [normalizedDirectory]);

  return React.useMemo(
    () => selectVisibleAgents(scopedAgents, ambientAgents),
    [ambientAgents, scopedAgents],
  );
};

/**
 * The picker's choosing rule, kept pure so it can be tested without rendering.
 *
 * A loaded scoped list is authoritative even when empty: an empty directory
 * list is a real answer, not a loading state. The ambient fallback keeps the
 * picker usable while a scope loads, but an agent scoped to another project
 * must not be offered there.
 */
export const selectVisibleAgents = (
  scopedAgents: Agent[] | undefined,
  ambientAgents: Agent[],
): Agent[] => {
  if (scopedAgents) {
    return filterVisibleAgents(scopedAgents);
  }

  return filterVisibleAgents(ambientAgents).filter(
    // SAFETY: stored agents carry the optional `scope` extension; an absent
    // scope means user/default scope, never 'project'.
    (agent) => (agent as AgentWithExtras).scope !== 'project',
  );
};
