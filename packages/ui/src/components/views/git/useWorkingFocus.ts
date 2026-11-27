import React from 'react';
import { findRepoFile } from '@/lib/path-utils';
import type { ChangesGroupConfig } from './ChangesPanel';
import type { WorkingEntrySelection } from './UnifiedWorkingChangesBody';
import type { WorkingFocusRequest } from './useUnifiedGitPanel';
import { useScrollToSection } from './useScrollToSection';

type WorkingGroupId = WorkingEntrySelection['groupId'];

export function useWorkingFocus(options: {
  focusRequest: WorkingFocusRequest | null;
  groups: readonly ChangesGroupConfig[];
  directory: string;
  revealGroup: (groupId: WorkingGroupId) => void;
  expand: (key: string) => void;
  select: (selection: WorkingEntrySelection) => void;
}) {
  const { focusRequest, groups, directory, revealGroup, expand, select } = options;
  const handledNonceRef = React.useRef(0);
  const { registerSectionRef, scrollTo, cancel } = useScrollToSection();

  const revealEntry = React.useCallback((selection: WorkingEntrySelection) => {
    const key = `${selection.groupId}:${selection.path}`;
    revealGroup(selection.groupId);
    expand(key);
    select(selection);
  }, [expand, revealGroup, select]);

  const focus = React.useCallback((selection: WorkingEntrySelection) => {
    revealEntry(selection);
    scrollTo(`${selection.groupId}:${selection.path}`);
  }, [revealEntry, scrollTo]);

  React.useEffect(() => {
    if (!focusRequest || focusRequest.nonce === handledNonceRef.current) return;
    const ordered = [...groups].sort((a, b) => {
      const aFirst = (a.id === 'staged') === focusRequest.staged ? 0 : 1;
      const bFirst = (b.id === 'staged') === focusRequest.staged ? 0 : 1;
      return aFirst - bFirst;
    });
    for (const group of ordered) {
      const listed = findRepoFile(focusRequest.path, directory, group.entries.map((entry) => entry.path));
      if (!listed) continue;
      handledNonceRef.current = focusRequest.nonce;
      focus({ groupId: group.id as WorkingGroupId, path: listed });
      return;
    }
  }, [directory, focus, focusRequest, groups]);

  const registerSectionRefs = React.useMemo(() => {
    const forGroup = (groupId: WorkingGroupId) => (path: string, node: HTMLElement | null) => {
      registerSectionRef(`${groupId}:${path}`, node);
    };
    return { staged: forGroup('staged'), unstaged: forGroup('unstaged') };
  }, [registerSectionRef]);

  return { registerSectionRef: registerSectionRefs, focus, revealEntry, cancel };
}
