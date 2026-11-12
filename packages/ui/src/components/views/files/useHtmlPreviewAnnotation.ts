import React from 'react';

import { useFrameAnnotation } from '@/components/browser/useFrameAnnotation';
import type { BrowserAnnotationPayload } from '@/lib/browser/contract';
import { previewUrlToFilePath } from '@/lib/browser/previewFrameHost';
import { useI18n } from '@/lib/i18n';

// The preview URL carries a grant for the page's folder; the prompt names the file instead.
const describePreview = (payload: BrowserAnnotationPayload): BrowserAnnotationPayload => ({
  ...payload,
  pageUrl: previewUrlToFilePath(payload.pageUrl),
});

/** Annotation for the Files view's HTML preview, run through the server-injected bridge. */
export const useHtmlPreviewAnnotation = ({
  frameRef,
  directory,
  pageKey,
}: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  directory: string;
  /** Changes when the frame shows another page; a running session ends with it. */
  pageKey: string;
}) => {
  const { t } = useI18n();
  return useFrameAnnotation({
    frameRef,
    directory,
    pageKey,
    intro: t('filesView.editor.htmlAnnotate.intro'),
    describePage: describePreview,
  });
};
