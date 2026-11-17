import { z } from 'zod';

import type { AnnotationHost, PageCapture } from './annotationSession';
import type { BrowserRect } from './contract';

export const PREVIEW_BRIDGE_CHANNEL = 'openchamber-preview-bridge';

const bridgeResultSchema = z.object({
  channel: z.literal(PREVIEW_BRIDGE_CHANNEL),
  type: z.literal('result'),
  id: z.string(),
  ok: z.boolean(),
  value: z.unknown(),
});

type BridgeResult = z.infer<typeof bridgeResultSchema>;
type Pending = { resolve: (value: BridgeResult['value']) => void; reject: (error: Error) => void };

export type PreviewFrameHost = AnnotationHost & {
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

export const previewUrlToFilePath = (pageUrl: string): string => {
  try {
    const match = /^\/api\/fs\/preview\/[^/]+(\/.+)$/.exec(new URL(pageUrl).pathname);
    if (!match) return pageUrl;
    const filePath = match[1].split('/').map((segment) => decodeURIComponent(segment)).join('/');
    return /^\/[A-Za-z]:\//.test(filePath) ? filePath.slice(1) : filePath;
  } catch {
    return pageUrl;
  }
};
