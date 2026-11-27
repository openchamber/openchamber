import React from 'react';

import { useFrameAnnotation } from '@/components/browser/useFrameAnnotation';
import type { BrowserAnnotationPayload } from '@/lib/browser/contract';
import { previewUrlToFilePath } from '@/lib/browser/previewFrameHost';
import { useI18n } from '@/lib/i18n';

const describePreview = (payload: BrowserAnnotationPayload, filePath: string): BrowserAnnotationPayload => ({
  ...payload,
  pageUrl: payload.pageUrl === 'about:srcdoc' && filePath
    ? filePath
    : previewUrlToFilePath(payload.pageUrl),
});

export const useHtmlPreviewAnnotation = ({
  frameRef,
  directory,
  pageKey,
  filePath = '',
}: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  directory: string;
  pageKey: string;
  filePath?: string;
}) => {
  const { t } = useI18n();
  const describePage = React.useCallback(
    (payload: BrowserAnnotationPayload) => describePreview(payload, filePath),
    [filePath],
  );
  return useFrameAnnotation({
    frameRef,
    directory,
    pageKey,
    intro: t('filesView.editor.htmlAnnotate.intro'),
    describePage,
  });
};
