import React from 'react';

import { useAnnotationAttach, useAnnotationOverlayLabels } from '@/components/browser/useAnnotationAttach';
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

// The bridge answers within a frame of the page being idle; a page without it
// (navigated elsewhere, or one whose own CSP blocks inline scripts) never does.
const BRIDGE_PROBE_TIMEOUT_MS = 1500;

/** The boxes that cut what of the frame is on screen: the window and every scrolling ancestor. */
const clipsOf = (frame: HTMLElement) => {
  const clips = [{ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }];
  for (let parent = frame.parentElement; parent; parent = parent.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (overflowX === 'visible' && overflowY === 'visible') continue;
    clips.push(parent.getBoundingClientRect());
  }
  return clips;
};

/**
 * The desktop shell photographs the part of the frame that is on screen. The
 * page has already torn its overlay down and repainted when the session asks,
 * so the picture shows the page alone. A browser has no way to photograph a
 * frame, so there the annotation goes without a screenshot.
 */
const captureFrame = async (frame: HTMLIFrameElement): Promise<PageCapture | null> => {
  if (!hasDesktopInvoke()) return null;
  const area = visibleFrameArea(frame.getBoundingClientRect(), clipsOf(frame));
  if (!area) return null;
  const capture = await invokeDesktopCommand<PageCapture>('desktop_capture_page_rect', area.window);
  return { ...capture, viewportArea: area.viewport };
};

/**
 * Annotation for a page the app shows in a sandboxed frame (an HTML file's
 * preview, a page an agent drew in the chat): the browser panel's overlay,
 * run inside the frame through the page's bridge, attached to the composer the
 * same way.
 */
export const useFrameAnnotation = ({
  frameRef,
  directory,
  pageKey,
  intro,
  describePage,
}: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  directory: string;
  /** Changes when the frame shows another page; a running session ends with it. */
  pageKey: string;
  /** The first line of the prompt: where the annotated page comes from. */
  intro: string;
  /** Names the page for the agent in place of the frame's own address. */
  describePage: (payload: BrowserAnnotationPayload) => BrowserAnnotationPayload;
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const overlayLabels = useAnnotationOverlayLabels();
  const attachAnnotation = useAnnotationAttach(directory, intro);
  const [isAnnotating, setIsAnnotating] = React.useState(false);
  const hostRef = React.useRef<PreviewFrameHost | null>(null);

  const stop = React.useCallback(() => {
    const host = hostRef.current;
    hostRef.current = null;
    setIsAnnotating(false);
    if (!host) return;
    // The teardown message is posted before the host stops listening; a page
    // that already went away cannot answer it anyway.
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

    const host = createPreviewFrameHost({ frame, capturePage: () => captureFrame(frame) });
    hostRef.current = host;
    setIsAnnotating(true);
    const isCurrent = () => hostRef.current === host;
    const theme = resolveAnnotationOverlayTheme(currentTheme.metadata.variant === 'light' ? 'light' : 'dark');

    void (async () => {
      try {
        if (!(await host.probe(BRIDGE_PROBE_TIMEOUT_MS))) throw new Error('Page bridge did not answer');
        // Focus moves into the page so the overlay's keys (Escape, typing) reach it.
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
  }, [attachAnnotation, currentTheme, describePage, frameRef, overlayLabels, stop, t]);

  // Escape leaves annotation mode from the app side too: the overlay owns the
  // Escape typed inside the page, but focus can be anywhere in the app.
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
