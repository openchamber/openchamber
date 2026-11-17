import React from 'react';

import { useFrameAnnotation } from '@/components/browser/useFrameAnnotation';
import type { BrowserAnnotationPayload } from '@/lib/browser/contract';
import { previewUrlToFilePath } from '@/lib/browser/previewFrameHost';
import { useI18n } from '@/lib/i18n';

const describePreview = (payload: BrowserAnnotationPayload): BrowserAnnotationPayload => ({
  ...payload,
  pageUrl: previewUrlToFilePath(payload.pageUrl),
});

export const useHtmlPreviewAnnotation = ({
  frameRef,
  directory,
  pageKey,
}: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  directory: string;
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
