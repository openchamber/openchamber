import React from 'react';

import { useAnnotationAttach, useAnnotationOverlayLabels } from '@/components/browser/useAnnotationAttach';
import { useChatColumnActions } from '@/components/chat/chatColumnSession';
import { useMobileCommentComposerController } from '@/components/chat/composer/comment/MobileCommentComposerContext';
import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cancelAnnotationSession, runAnnotationSession, type PageCapture } from '@/lib/browser/annotationSession';
import type { BrowserAnnotationPayload } from '@/lib/browser/contract';
import { resolveAnnotationOverlayTheme } from '@/lib/browser/overlayTheme';
import { createPreviewFrameHost, visibleFrameArea, type PreviewFrameHost } from '@/lib/browser/previewFrameHost';
import { hasDesktopInvoke } from '@/lib/desktop';
import { invokeDesktopCommand } from '@/lib/desktopNative';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';

const BRIDGE_PROBE_TIMEOUT_MS = 1500;

const clipsOf = (frame: HTMLElement) => {
  const clips = [{ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }];
  for (let parent = frame.parentElement; parent; parent = parent.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (overflowX === 'visible' && overflowY === 'visible') continue;
    clips.push(parent.getBoundingClientRect());
  }
  return clips;
};

const captureFrame = async (frame: HTMLIFrameElement): Promise<PageCapture | null> => {
  if (!hasDesktopInvoke()) return null;
  const area = visibleFrameArea(frame.getBoundingClientRect(), clipsOf(frame));
  if (!area) return null;
  const capture = await invokeDesktopCommand<PageCapture>('desktop_capture_page_rect', area.window);
  return { ...capture, viewportArea: area.viewport };
};

export const useFrameAnnotation = ({
  frameRef,
  directory,
  pageKey,
  intro,
  describePage,
}: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  directory: string;
  pageKey: string;
  intro: string;
  describePage: (payload: BrowserAnnotationPayload) => BrowserAnnotationPayload;
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const overlayLabels = useAnnotationOverlayLabels();
  const { pinned } = useChatColumnActions();
  const composer = useMobileCommentComposerController();
  const attachAnnotation = useAnnotationAttach(directory, intro);
  const [isAnnotating, setIsAnnotating] = React.useState(false);
  const hostRef = React.useRef<PreviewFrameHost | null>(null);

  const stop = React.useCallback(() => {
    const host = hostRef.current;
    hostRef.current = null;
    setIsAnnotating(false);
    if (!host) return;
    void cancelAnnotationSession(host);
    host.dispose();
  }, []);

  React.useEffect(() => stop, [pageKey, stop]);

  const toggle = React.useCallback(() => {
    if (hostRef.current) {
      stop();
      return;
    }
    const frame = frameRef.current;
    if (!frame) return;
    if (pinned && !composer?.getScope()) {
      toast.error(t('contextPanel.browser.annotate.readOnly'));
      return;
    }

    const host = createPreviewFrameHost({ frame, capturePage: () => captureFrame(frame) });
    hostRef.current = host;
    setIsAnnotating(true);
    const isCurrent = () => hostRef.current === host;
    const theme = resolveAnnotationOverlayTheme(currentTheme.metadata.variant === 'light' ? 'light' : 'dark');

    void (async () => {
      try {
        if (!(await host.probe(BRIDGE_PROBE_TIMEOUT_MS))) throw new Error('Page bridge did not answer');
        frame.focus();
        const result = await runAnnotationSession({ host, theme, labels: overlayLabels });
        if (!isCurrent()) return;
        if (result) await attachAnnotation({ ...result, payload: describePage(result.payload) });
      } catch {
        if (isCurrent()) toast.error(t('contextPanel.browser.annotate.failed'));
      } finally {
        if (isCurrent()) {
          hostRef.current = null;
          setIsAnnotating(false);
          host.dispose();
        }
      }
    })();
  }, [attachAnnotation, composer, currentTheme, describePage, frameRef, overlayLabels, pinned, stop, t]);

  React.useEffect(() => {
    if (!isAnnotating) return;
    const handler = (event: KeyboardEvent) => {
      if (isIMECompositionEvent(event) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isAnnotating, stop]);

  return { isAnnotating, toggle };
};
