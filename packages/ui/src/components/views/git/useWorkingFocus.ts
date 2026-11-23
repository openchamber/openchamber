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
  const { registerSectionRef, scrollTo } = useScrollToSection();

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
      const groupId = group.id as WorkingGroupId;
      revealGroup(groupId);
      expand(`${groupId}:${listed}`);
      select({ groupId, path: listed });
      scrollTo(`${groupId}:${listed}`);
      return;
    }
  }, [directory, expand, focusRequest, groups, revealGroup, scrollTo, select]);

  return React.useMemo(() => {
    const forGroup = (groupId: WorkingGroupId) => (path: string, node: HTMLElement | null) => {
      registerSectionRef(`${groupId}:${path}`, node);
    };
    return { staged: forGroup('staged'), unstaged: forGroup('unstaged') };
  }, [registerSectionRef]);
}
