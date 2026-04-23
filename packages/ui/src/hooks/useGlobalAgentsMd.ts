/**
 * Global AGENTS.md hook
 *
 * Fetches and exposes global AGENTS.md files that apply across all
 * projects (~/AGENTS.md and ~/.config/opencode/AGENTS.md).
 */

import React from 'react';

export type GlobalAgentEntry = {
  path: string;
  content: string;
};

export type GlobalAgentsMdState = {
  active: GlobalAgentEntry[];
  count: number;
  paths: string[];
  loading: boolean;
  error: string | null;
};

export function useGlobalAgentsMd(): GlobalAgentsMdState {
  const [state, setState] = React.useState<GlobalAgentsMdState>({
    active: [],
    count: 0,
    paths: [],
    loading: true,
    error: null,
  });

  React.useEffect(() => {
    let cancelled = false;

    const fetchGlobalAgents = async () => {
      try {
        const res = await fetch('/api/global-agents-md');
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          setState({
            active: data.active || [],
            count: data.count || 0,
            paths: data.paths || [],
            loading: false,
            error: null,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    };

    void fetchGlobalAgents();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
