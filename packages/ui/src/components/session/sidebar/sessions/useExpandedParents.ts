import React from 'react';
import { z } from 'zod';
import { toggleExpandedParentKey } from '../utils';

export const SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents.v3';

const expandedParentsSchema = z.array(z.string());

const readExpandedParents = (): Set<string> => {
  try {
    const raw = globalThis.localStorage.getItem(SESSION_EXPANDED_STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed = expandedParentsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? new Set(parsed.data) : new Set();
  } catch {
    return new Set();
  }
};

export const useExpandedParents = () => {
  const [expandedParents, setExpandedParents] = React.useState(readExpandedParents);
  const expandedParentsRef = React.useRef(expandedParents);
  expandedParentsRef.current = expandedParents;

  const toggleParent = React.useCallback((key: string) => {
    const next = toggleExpandedParentKey(expandedParentsRef.current, key);
    expandedParentsRef.current = next;
    setExpandedParents(next);
    try {
      globalThis.localStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // The mounted list keeps the user's change; a remount rereads durable storage.
    }
  }, []);

  return { expandedParents, toggleParent };
};
