import {
  ANNOTATION_TEARDOWN_SCRIPT,
  buildAnnotationOverlayScript,
  type BrowserAnnotationOverlayLabels,
  type BrowserAnnotationOverlayTheme,
  type BrowserAnnotationVoice,
} from './annotationOverlay';
import { isBrowserAnnotationPayload, type BrowserAnnotationPayload, type BrowserRect } from './contract';
import { renderAnnotationScreenshot } from './annotationScreenshot';
import type { JsonValue } from '@openchamber/sdk';

export type PageCapture = {
  readonly mime: string;
  readonly base64: string;
  readonly width: number;
  readonly height: number;
  readonly viewportArea?: BrowserRect;
};

export type AnnotationHost = {
  readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  readonly runIsolated?: (script: string) => Promise<JsonValue>;
  readonly capturePage: () => Promise<PageCapture | null>;
};

export type AnnotationSessionResult = {
  readonly payload: BrowserAnnotationPayload;
  readonly screenshot: File | null;
};

const VIEWPORT_SCRIPT = '({ width: window.innerWidth, height: window.innerHeight })';

const readViewport = async (host: AnnotationHost): Promise<{ width: number; height: number } | null> => {
  try {
    const value = await host.executeJavaScript(VIEWPORT_SCRIPT, true);
    if (!value || typeof value !== 'object') return null;
    const record = value as { width?: unknown; height?: unknown };
    if (typeof record.width !== 'number' || typeof record.height !== 'number') return null;
    if (!Number.isFinite(record.width) || !Number.isFinite(record.height)) return null;
    return { width: record.width, height: record.height };
  } catch {
    return null;
  }
};

export const cancelAnnotationSession = async (host: AnnotationHost): Promise<void> => {
  try {
    await host.executeJavaScript(ANNOTATION_TEARDOWN_SCRIPT, false);
  } catch {
    // The page navigated or was destroyed; the overlay went with it.
  }
};

const runOverlay = async (
  host: AnnotationHost,
  theme: BrowserAnnotationOverlayTheme,
  labels: BrowserAnnotationOverlayLabels,
  voice: BrowserAnnotationVoice | null,
): Promise<BrowserAnnotationPayload | null> => {
  let raw;
  let started = false;
  if (host.runIsolated) {
    try {
      raw = await host.runIsolated(buildAnnotationOverlayScript(theme, labels, voice));
      started = true;
    } catch {
      // A desktop app older than this UI, or a page the debugger cannot attach to.
    }
  }
  if (!started) raw = await host.executeJavaScript(buildAnnotationOverlayScript(theme, labels), true);

  if (raw === null || raw === undefined) return null;
  if (!isBrowserAnnotationPayload(raw)) {
    await cancelAnnotationSession(host);
    return null;
  }
  return raw;
};

export const runAnnotationSession = async ({
  host,
  theme,
  labels,
  voice = null,
}: {
  host: AnnotationHost;
  theme: BrowserAnnotationOverlayTheme;
  labels: BrowserAnnotationOverlayLabels;
  voice?: BrowserAnnotationVoice | null;
}): Promise<AnnotationSessionResult | null> => {
  const payload = await runOverlay(host, theme, labels, voice);
  if (!payload) return null;

  try {
    const viewport = await readViewport(host) ?? payload.viewport;
    const capture = await host.capturePage();
    if (!capture || !capture.base64) {
      return { payload, screenshot: null };
    }

    const area = capture.viewportArea ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const screenshot = await renderAnnotationScreenshot({
      base64: capture.base64,
      mime: capture.mime || 'image/jpeg',
      captureWidth: capture.width,
      captureHeight: capture.height,
      cssWidth: area.width,
      cssHeight: area.height,
      cssOrigin: { x: area.x, y: area.y },
      payload,
      accentColor: theme.primary,
      accentFill: theme.primarySoft,
    });
    return { payload, screenshot };
  } catch {
    return { payload, screenshot: null };
  }
};
