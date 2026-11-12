/**
 * An annotation host for an HTML preview frame in the Files view.
 *
 * The preview is an opaque-origin sandbox, so the app cannot call into it the
 * way the browser panel calls `webview.executeJavaScript`. The server puts a
 * small bridge into every previewed HTML page (`packages/web/server/lib/fs/
 * preview-bridge.js`): it evaluates code the frame's parent posts and posts
 * the settled value back. This module is the parent's half, shaped as an
 * `AnnotationHost` so `runAnnotationSession` drives the frame unchanged.
 */
import { z } from 'zod';

import type { AnnotationHost, PageCapture } from './annotationSession';
import type { BrowserRect } from './contract';

// The pages an agent shows in the chat carry the same listener in their
// bootstrap (chat/message/parts/htmlRender.ts), on this channel.
export const PREVIEW_BRIDGE_CHANNEL = 'openchamber-preview-bridge';

const bridgeResultSchema = z.object({
  channel: z.literal(PREVIEW_BRIDGE_CHANNEL),
  type: z.literal('result'),
  id: z.string(),
  ok: z.boolean(),
  value: z.unknown(),
});

// The page's value stays raw here: the caller (`runAnnotationSession`) parses it.
type BridgeResult = z.infer<typeof bridgeResultSchema>;
type Pending = { resolve: (value: BridgeResult['value']) => void; reject: (error: Error) => void };

export type PreviewFrameHost = AnnotationHost & {
  /** Resolves when the page answers within `timeoutMs`; a page without the bridge never does. */
  readonly probe: (timeoutMs: number) => Promise<boolean>;
  readonly dispose: () => void;
};

export const createPreviewFrameHost = ({
  frame,
  capturePage,
}: {
  frame: HTMLIFrameElement;
  capturePage: () => Promise<PageCapture | null>;
}): PreviewFrameHost => {
  const pending = new Map<string, Pending>();
  let counter = 0;

  const rejectAll = (reason: string) => {
    for (const entry of pending.values()) entry.reject(new Error(reason));
    pending.clear();
  };

  const onMessage = (event: MessageEvent) => {
    if (!frame.contentWindow || event.source !== frame.contentWindow) return;
    const parsed = bridgeResultSchema.safeParse(event.data);
    if (!parsed.success) return;
    const entry = pending.get(parsed.data.id);
    if (!entry) return;
    pending.delete(parsed.data.id);
    if (parsed.data.ok) entry.resolve(parsed.data.value);
    else entry.reject(new Error(String(parsed.data.value)));
  };

  // A navigation or reload replaces the document, and with it any session
  // that was waiting for an answer.
  const onLoad = () => rejectAll('Preview page was reloaded');

  window.addEventListener('message', onMessage);
  frame.addEventListener('load', onLoad);

  const executeJavaScript: AnnotationHost['executeJavaScript'] = (code) => new Promise((resolve, reject) => {
    const target = frame.contentWindow;
    if (!target) {
      reject(new Error('Preview page is not available'));
      return;
    }
    counter += 1;
    const id = `preview-eval-${counter}`;
    pending.set(id, { resolve, reject });
    // The page's origin is opaque, so no origin can be named here. The message
    // carries only our own overlay code, nothing the page must not see.
    target.postMessage({ channel: PREVIEW_BRIDGE_CHANNEL, type: 'eval', id, code }, '*');
  });

  const probe = async (timeoutMs: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([executeJavaScript('true').then(() => true, () => false), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    executeJavaScript,
    capturePage,
    probe,
    dispose: () => {
      window.removeEventListener('message', onMessage);
      frame.removeEventListener('load', onLoad);
      rejectAll('Preview page went away');
    },
  };
};

type Edges = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

/**
 * The part of a frame that is on screen: the frame's box cut by every box
 * that clips it (the window, the scrolling chat), as a rectangle in the
 * window to photograph and the same rectangle in the page's viewport. A page
 * in the chat is as tall as its content, so it is often only partly on
 * screen. Null when none of it is.
 */
export const visibleFrameArea = (frame: Edges, clips: ReadonlyArray<Edges>): { window: BrowserRect; viewport: BrowserRect } | null => {
  let { left, top, right, bottom } = frame;
  for (const clip of clips) {
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) return null;
  return {
    window: { x: left, y: top, width, height },
    viewport: { x: left - frame.left, y: top - frame.top, width, height },
  };
};

/**
 * The file a preview URL serves (`/api/fs/preview/<grant>/<path>`), or the URL
 * unchanged. The grant is a credential for the page's folder and has no place
 * in a prompt; the path is what the agent can act on.
 */
export const previewUrlToFilePath = (pageUrl: string): string => {
  try {
    const match = /^\/api\/fs\/preview\/[^/]+(\/.+)$/.exec(new URL(pageUrl).pathname);
    if (!match) return pageUrl;
    const filePath = match[1].split('/').map((segment) => decodeURIComponent(segment)).join('/');
    // A Windows path rides in the URL as `/C:/…`.
    return /^\/[A-Za-z]:\//.test(filePath) ? filePath.slice(1) : filePath;
  } catch {
    return pageUrl;
  }
};
