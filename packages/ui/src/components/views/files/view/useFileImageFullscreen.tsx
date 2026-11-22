import React from 'react';
import { useTabletLayout } from '@/lib/device';
import { registerCloseTabTarget } from '@/lib/closeTabTarget';
import { type useFileKinds } from './useFileKinds';
import { type useFileTabs } from './useFileTabs';

export function useFileImageFullscreen({ fileKinds, tabs, isMobile, visible }: {
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'isSelectedImage' | 'isSvgSource'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  isMobile: boolean;
  visible: boolean;
}) {
  const { enabled: tabletLayout } = useTabletLayout();
  const [requested, setRequested] = React.useState(false);
  const imagePreview = fileKinds.isSelectedImage && !fileKinds.isSvgSource;
  const allowed = (!isMobile || tabletLayout) && visible;
  const available = allowed && Boolean(tabs.selectedFile) && imagePreview;
  const keep = allowed && (!tabs.selectedFile || fileKinds.isSelectedImage);
  if (requested && !keep) setRequested(false);
  const closeTabTarget = React.useCallback((node: HTMLElement | null) => (
    node ? registerCloseTabTarget(() => setRequested(false), { current: node }, 1) : undefined
  ), []);
  return { available, open: requested && keep, setOpen: setRequested, closeTabTarget };
}
