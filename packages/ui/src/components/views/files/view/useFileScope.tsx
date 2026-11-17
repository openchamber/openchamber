import React from 'react';
import { useZoneInteractive } from '@/components/layout/zoneInteractiveContext';
import { useGitStatus, useGitStore } from '@/stores/useGitStore';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { normalizePath } from './fileViewPaths';
import { type FilesViewOptions } from './fileViewTypes';

export function useFileScope({ isMobile, mode, visible }: {
  isMobile: boolean;
  mode: FilesViewOptions['mode'];
  visible: boolean;
}) {
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();
  const zoneInteractive = useZoneInteractive();

  const panelDirectory = useEffectiveDirectory() ?? '';
  const currentDirectory = panelContentDirectory(useDraftSpaceTarget(), panelDirectory) ?? '';
  const root = normalizePath(currentDirectory.trim());
  const panelRoot = normalizePath(panelDirectory.trim());
  const treeEnabled = isMobile || mode === 'full';
  const treeActive = treeEnabled && visible;
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const fileScope = JSON.stringify([runtimeKey, root]);
  const fileScopeRef = React.useRef(fileScope);
  fileScopeRef.current = fileScope;
  const treeScope = JSON.stringify([runtimeKey, root, showHidden, showGitignored]);
  const treeScopeRef = React.useRef(treeScope);
  treeScopeRef.current = treeScope;
  const gitStatus = useGitStatus(treeActive ? currentDirectory : null);

  return { showHidden, showGitignored, zoneInteractive, currentDirectory, root, panelRoot, treeEnabled, treeActive, runtimeKey, fileScope, fileScopeRef, treeScope, treeScopeRef, gitStatus };
}
