import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';

type ResolvedWorkspace = { name: string; type: string };

/**
 * Workspace identity is cached per directory because the header asks for it on every
 * session change, while the answer only moves when workspaces are created or removed.
 */
const cache = new Map<string, Map<string, ResolvedWorkspace>>();

/**
 * Name and provider of the workspace a session runs in, or null when it runs on the
 * host. A chat routed into a workspace is otherwise indistinguishable from one that is
 * not, which hides the single most consequential fact about where files are written.
 */
export function useSessionWorkspaceBadge(workspaceID: string | null, directory: string | null): ResolvedWorkspace | null {
  const key = directory ?? '';
  const [resolved, setResolved] = React.useState<ResolvedWorkspace | null>(() => (workspaceID ? cache.get(key)?.get(workspaceID) ?? null : null));

  React.useEffect(() => {
    if (!workspaceID) {
      setResolved(null);
      return;
    }
    const known = cache.get(key)?.get(workspaceID);
    if (known) {
      setResolved(known);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const workspaces = await opencodeClient.experimentalWorkspaces.list(directory || undefined);
        const scoped = cache.get(key) ?? new Map<string, ResolvedWorkspace>();
        for (const workspace of workspaces) {
          if (typeof workspace?.id !== 'string') continue;
          scoped.set(workspace.id, { name: workspace.name || workspace.id, type: String(workspace.type ?? '') });
        }
        cache.set(key, scoped);
        if (!cancelled) setResolved(scoped.get(workspaceID) ?? null);
      } catch {
        // An unresolvable name must not hide the fact that this session is isolated;
        // the caller falls back to a generic label.
        if (!cancelled) setResolved(null);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceID, directory, key]);

  return resolved;
}
