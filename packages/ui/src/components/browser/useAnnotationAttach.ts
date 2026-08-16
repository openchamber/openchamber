import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { formatBrowserAnnotationPrompt } from '@/lib/browser/annotationPrompt';
import type { AnnotationSessionResult } from '@/lib/browser/annotationSession';
import type { BrowserAnnotationOverlayLabels } from '@/lib/browser/annotationOverlay';

/**
 * Attaches a finished annotation to the active composer.
 *
 * The screenshot is attached before the text so that a failed image upload
 * cannot leave a prompt claiming an attachment that never arrived — the text
 * states what actually happened.
 */
export const useAnnotationAttach = (directory: string) => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

  return React.useCallback(async (result: AnnotationSessionResult): Promise<void> => {
    const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
    if (!sessionKey) {
      toast.error(t('contextPanel.browser.annotate.noSession'));
      return;
    }

    let screenshotAttached = false;
    if (result.screenshot) {
      try {
        await addAttachedFile(result.screenshot);
        screenshotAttached = true;
      } catch {
        screenshotAttached = false;
      }
    }

    addInlineCommentDraft({ directory, sessionKey }, {
      source: 'preview-annotation',
      fileLabel: result.payload.pageUrl || 'browser',
      startLine: 1,
      endLine: 1,
      code: formatBrowserAnnotationPrompt({
        payload: result.payload,
        screenshotAttached,
        intro: t('contextPanel.browser.annotate.intro'),
      }),
      language: 'markdown',
      text: '',
    });

    toast.success(t('contextPanel.browser.annotate.attached'));
  }, [addAttachedFile, addInlineCommentDraft, currentSessionId, directory, newSessionDraftOpen, t]);
};

/** Overlay labels, resolved through i18n so the in-page UI follows the app locale. */
export const useAnnotationOverlayLabels = (): BrowserAnnotationOverlayLabels => {
  const { t } = useI18n();
  return React.useMemo(() => ({
    select: t('contextPanel.browser.annotate.tool.element'),
    marquee: t('contextPanel.browser.annotate.tool.region'),
    draw: t('contextPanel.browser.annotate.tool.draw'),
    commentPlaceholder: t('contextPanel.browser.annotate.commentPlaceholder'),
    submit: t('contextPanel.browser.annotate.submit'),
  }), [t]);
};
