import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { type ImageNeighbor } from '../previews/ImageArtifact';
import { imageNeighborsOf } from '../imageNeighbors';
import { opencodeClient } from '@/lib/opencode/client';
import { type FileNode } from './fileViewTypes';
import { getParentDirectoryPath } from './fileViewPaths';
import { type useFileDirectory } from './useFileDirectory';
import { type useFileKinds } from './useFileKinds';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

export function useFileImageNavigation({ fileDirectory, fileKinds, scope, tabs, files, visible }: {
  fileDirectory: Pick<ReturnType<typeof useFileDirectory>, 'mapDirectoryEntries'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'isSelectedImage' | 'isSvgSource'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'panelRoot' | 'showGitignored' | 'treeScope' | 'treeScopeRef'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile' | 'selectedFilePath'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
  visible: boolean;
}) {
  const { mapDirectoryEntries } = fileDirectory;
  const { isSelectedImage, isSvgSource } = fileKinds;
  const { panelRoot, showGitignored, treeScope, treeScopeRef } = scope;
  const { selectedFile, selectedFilePath } = tabs;
  const imageFolder = visible && selectedFile && isSelectedImage && !isSvgSource ? getParentDirectoryPath(selectedFile.path) : '';
  const [imageFolderListing, setImageFolderListing] = React.useState<{ scope: string; folder: string; readFor: string; entries: FileNode[] } | null>(null);
  const imageFolderListingCurrent = Boolean(imageFolder && imageFolderListing?.scope === treeScope && imageFolderListing.folder === imageFolder);
  const imageFolderHasSelected = Boolean(imageFolderListingCurrent && imageFolderListing?.entries.some((entry) => entry.path === selectedFilePath));
  const imageFolderNeedsRead = Boolean(imageFolder) && !(imageFolderListingCurrent && imageFolderListing?.readFor === selectedFilePath);
  React.useEffect(() => {
    if (!imageFolderNeedsRead) return;
    let cancelled = false;
    const scope = treeScope;
    const folder = imageFolder;
    const readFor = selectedFilePath;
    const respectGitignore = !showGitignored;
    const read = files.listDirectory
      ? files.listDirectory(folder, { respectGitignore }).then((result) => result.entries)
      : opencodeClient.listLocalDirectory(folder, { respectGitignore });
    read.then((entries) => {
      if (cancelled || treeScopeRef.current !== scope) return;
      setImageFolderListing({ scope, folder, readFor, entries: mapDirectoryEntries(folder, entries) });
    }).catch((error) => {
      if (!cancelled) console.warn('Failed to list the image folder:', error);
    });
    return () => {
      cancelled = true;
    };
  }, [files, imageFolder, imageFolderNeedsRead, mapDirectoryEntries, selectedFilePath, showGitignored, treeScope]);
  const imageNeighbors = React.useMemo(() => {
    if (!imageFolderHasSelected || !imageFolderListing || !panelRoot) return null;
    const neighbors = imageNeighborsOf(imageFolderListing.entries, selectedFilePath);
    if (!neighbors) return null;
    const toNeighbor = (node: FileNode): ImageNeighbor => ({
      name: node.name,
      open: () => useUIStore.getState().openContextFile(panelRoot, node.path, { preview: true }),
    });
    return { previous: toNeighbor(neighbors.previous), next: toNeighbor(neighbors.next) };
  }, [imageFolderHasSelected, imageFolderListing, panelRoot, selectedFilePath]);

  return { imageNeighbors };
}
