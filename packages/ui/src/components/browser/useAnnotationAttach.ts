import React from 'react';

import { useChatColumnActions } from '@/components/chat/chatColumnSession';
import { useMobileCommentComposerController } from '@/components/chat/composer/comment/MobileCommentComposerContext';
import { createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { createInlineCommentDraftId, useInlineCommentDraftStore, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import { useInputStore } from '@/sync/input-store';
import { readComposerAddress } from '@/hooks/useComposerAddress';
import { formatBrowserAnnotationPrompt } from '@/lib/browser/annotationPrompt';
import { saveAnnotationScreenshot } from '@/lib/browser/annotationScreenshotStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { AnnotationSessionResult } from '@/lib/browser/annotationSession';
import type { BrowserAnnotationOverlayLabels } from '@/lib/browser/annotationOverlay';

export const useAnnotationAttach = (directory: string, intro?: string) => {
  const { t } = useI18n();
  const { pinned, focusInput } = useChatColumnActions();
  const composer = useMobileCommentComposerController();
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

  return React.useCallback(async (result: AnnotationSessionResult, wanted: () => boolean = () => true): Promise<boolean> => {
    const scope = pinned ? composer?.getScope() : null;
    const { inline: target, attachments } = pinned
      ? { inline: scope, attachments: scope && createChatDraftIdentity(scope.runtimeKey, scope.directory, scope.sessionKey) }
      : readComposerAddress(directory);
    if (!target) {
      toast.error(t(pinned ? 'contextPanel.browser.annotate.readOnly' : 'contextPanel.browser.annotate.noSession'));
      return false;
    }

    let attachedScreenshot: AttachedFile | undefined;
    if (result.screenshot) {
      try {
        await addAttachedFile(result.screenshot, attachments, ([landed]) => { attachedScreenshot = landed; }, pinned ? { shared: true } : undefined);
      } catch {
        attachedScreenshot = undefined;
      }
    }
    const screenshot = attachedScreenshot?.filename;
    const screenshotAttached = screenshot !== undefined;
    const draftId = createInlineCommentDraftId();
    if (attachedScreenshot) await saveAnnotationScreenshot(draftId, attachedScreenshot);

    if (!wanted()) return false;
    addInlineCommentDraft(target, {
      id: draftId,
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
    requestAnimationFrame(focusInput);
    return true;
  }, [addAttachedFile, addInlineCommentDraft, composer, directory, focusInput, intro, pinned, t]);
};

export const useAnnotationTextKeeper = () => {
  const { t } = useI18n();
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);

  return React.useCallback((target: InlineCommentDraftTarget, spoken: { text: string; url: string }): boolean => {
    const kept = addInlineCommentDraft(target, {
      source: 'preview-annotation',
      fileLabel: spoken.url || 'browser',
      startLine: 1,
      endLine: 1,
      code: formatBrowserAnnotationPrompt({
        payload: {
          id: 'dictated', pageUrl: spoken.url, pageTitle: '',
          viewport: { width: window.innerWidth, height: window.innerHeight }, devicePixelRatio: window.devicePixelRatio,
          comment: '', elements: [], regions: [], strokes: [],
        },
        screenshotAttached: false,
        intro: t('contextPanel.browser.annotate.intro'),
      }),
      language: 'markdown',
      text: spoken.text.trim(),
    }, { written: true });
    if (kept) toast.success(t('contextPanel.browser.annotate.attached'));
    return kept !== null;
  }, [addInlineCommentDraft, t]);
};

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
