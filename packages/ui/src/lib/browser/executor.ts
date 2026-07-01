import type { BrowserCommandExecutor, BrowserExecResult } from '../api/types';

export interface BrowserScreenshotResult {
  base64?: string;
  mime?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
}

/**
 * Pane-provided capability callbacks. The pane (iframe on web, webview on desktop)
 * implements these; the executor maps server-issued primitives onto them. Keeping
 * the surface-specific logic in the pane lets one mapper serve both runtimes.
 */
export interface BrowserExecutorCallbacks {
  /** Run JS in the page and return its (JSON-serializable) value. */
  runScript: (js: string) => Promise<unknown>;
  navigate?: (url: string) => Promise<void> | void;
  goBack?: () => Promise<void> | void;
  goForward?: () => Promise<void> | void;
  reload?: () => Promise<void> | void;
  screenshot?: (opts: { mode?: string; rect?: { x: number; y: number; w: number; h: number } }) => Promise<BrowserScreenshotResult | null>;
  setViewport?: (opts: { width: number; height: number; dpr?: number }) => Promise<void> | void;
  emulateDevice?: (opts: { device: string }) => Promise<void> | void;
  /** Desktop-only: set files on a file input via CDP. Returns { found: boolean }. */
  setInputFiles?: (opts: { ref?: string; selector?: string; paths: string[] }) => Promise<{ found?: boolean } | null>;
}

const isCrossOriginError = (err: unknown): boolean => {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : '';
  const message = err instanceof Error ? err.message : String(err);
  return name === 'SecurityError' || /cross[- ]origin|Blocked a frame|Permission denied/i.test(message);
};

/**
 * Build a BrowserCommandExecutor that maps the server's low-level primitives onto
 * the pane callbacks. Same-origin violations surface as CROSS_ORIGIN_BLOCKED.
 */
export const createBrowserExecutor = (cb: BrowserExecutorCallbacks): BrowserCommandExecutor => {
  return async (primitive: string, rawArgs: unknown): Promise<BrowserExecResult> => {
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
    try {
      switch (primitive) {
        case 'eval': {
          const value = await cb.runScript(String(args.js ?? ''));
          return { ok: true, value };
        }
        case 'navigate': {
          await cb.navigate?.(String(args.url ?? ''));
          return { ok: true, value: { navigated: true } };
        }
        case 'back': {
          await cb.goBack?.();
          return { ok: true, value: { back: true } };
        }
        case 'forward': {
          await cb.goForward?.();
          return { ok: true, value: { forward: true } };
        }
        case 'reload': {
          await cb.reload?.();
          return { ok: true, value: { reload: true } };
        }
        case 'screenshot': {
          if (!cb.screenshot) return { ok: false, code: 'UNSUPPORTED_ON_SURFACE', message: 'Screenshot not available on this surface' };
          const shot = await cb.screenshot({ mode: args.mode as string | undefined, rect: args.rect as { x: number; y: number; w: number; h: number } | undefined });
          if (!shot) return { ok: false, code: 'EXEC_ERROR', message: 'Screenshot failed' };
          return { ok: true, value: shot };
        }
        case 'setViewport': {
          // Don't fabricate success when the surface can't override the viewport —
          // report it honestly so the agent doesn't believe a no-op worked.
          if (!cb.setViewport) return { ok: false, code: 'UNSUPPORTED_ON_SURFACE', message: 'Viewport override is not available on this browser surface.' };
          await cb.setViewport({ width: Number(args.width), height: Number(args.height), dpr: args.dpr as number | undefined });
          return { ok: true, value: { ok: true } };
        }
        case 'emulateDevice': {
          if (!cb.emulateDevice) return { ok: false, code: 'UNSUPPORTED_ON_SURFACE', message: 'Device emulation is not available on this browser surface.' };
          await cb.emulateDevice({ device: String(args.device ?? '') });
          return { ok: true, value: { ok: true } };
        }
        case 'setInputFiles': {
          if (!cb.setInputFiles) return { ok: false, code: 'UNSUPPORTED_ON_SURFACE', message: 'file_upload is only available on the desktop app' };
          const result = await cb.setInputFiles({ ref: args.ref as string | undefined, selector: args.selector as string | undefined, paths: Array.isArray(args.paths) ? (args.paths as string[]) : [] });
          if (result && result.found === false) return { ok: false, code: 'SELECTOR_NOT_FOUND', message: 'No file input matched' };
          return { ok: true, value: result ?? { uploaded: true } };
        }
        default:
          return { ok: false, code: 'EXEC_ERROR', message: `Unknown primitive: ${primitive}` };
      }
    } catch (err) {
      if (isCrossOriginError(err)) {
        return { ok: false, code: 'CROSS_ORIGIN_BLOCKED', message: err instanceof Error ? err.message : String(err) };
      }
      return { ok: false, code: 'EXEC_ERROR', message: err instanceof Error ? err.message : String(err) };
    }
  };
};
