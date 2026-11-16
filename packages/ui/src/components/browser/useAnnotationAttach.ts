import React from 'react';

import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useInputStore } from '@/sync/input-store';
import { readComposerAddress } from '@/hooks/useComposerAddress';
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
export const useAnnotationAttach = (directory: string, intro?: string) => {
  const { t } = useI18n();
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

  return React.useCallback(async (result: AnnotationSessionResult): Promise<void> => {
    const { inline: target, attachments } = readComposerAddress(directory);
    if (!target) {
      toast.error(t('contextPanel.browser.annotate.noSession'));
      return;
    }

    // The screenshot joins the composer's files under the annotation's name
    // for it: the annotation's row shows it, and it goes and leaves with the
    // annotation, never as a chip in the prompt.
    let screenshot: string | undefined;
    if (result.screenshot) {
      try {
        await addAttachedFile(result.screenshot, attachments, ([landed]) => { screenshot = landed?.filename; });
      } catch {
        screenshot = undefined;
      }
    }
    const screenshotAttached = screenshot !== undefined;

    // The overlay is gone by now, so a refusal would lose the comment and marks.
    // The comment is the draft's own text, as for every other comment, so the
    // composer shows and edits it apart from the prompt; the model reads it
    // after the prompt.
    addInlineCommentDraft(target, {
      source: 'preview-annotation',
      fileLabel: result.payload.pageUrl || result.payload.pageTitle || 'browser',
      startLine: 1,
      endLine: 1,
      code: formatBrowserAnnotationPrompt({
        payload: { ...result.payload, comment: '' },
        screenshotAttached,
        intro: intro ?? t('contextPanel.browser.annotate.intro'),
      }),
      language: 'markdown',
      text: result.payload.comment.trim(),
      screenshot,
    }, { written: true });

    toast.success(t('contextPanel.browser.annotate.attached'));
    // Focus leaves the page for the composer so Enter sends the prompt.
    requestAnimationFrame(focusChatInput);
  }, [addAttachedFile, addInlineCommentDraft, directory, intro, t]);
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
