import React from 'react';
import { type FilesViewOptions } from './fileViewTypes';

export function useFileLayout({ isMobile, mode }: {
  isMobile: boolean;
  mode: FilesViewOptions['mode'];
}) {
  const showEditorTabsRow = mode !== 'editor-only';
  const suppressFileLoadingIndicator = mode === 'editor-only' && !isMobile;
  const [showMobilePageContent, setShowMobilePageContent] = React.useState(false);

  return { showEditorTabsRow, suppressFileLoadingIndicator, showMobilePageContent, setShowMobilePageContent };
}
