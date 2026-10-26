export type ClipboardCopyResult =
  | { ok: true; method: 'clipboard' | 'execCommand' }
  | { ok: false; error: string };

export async function copyTextToClipboard(text: string): Promise<ClipboardCopyResult> {
  let clipboardError: string | null = null;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard' };
    } catch (error) {
      clipboardError = error instanceof Error ? error.message : String(error);
    }
  }

  if (typeof document !== 'undefined' && document.body) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.left = '-1000px';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);

    if (copied) {
      return { ok: true, method: 'execCommand' };
    }
  }

  return {
    ok: false,
    error: clipboardError ?? 'Clipboard access denied in current context',
  };
}

type ClipboardTextPlugin = {
  read: () => Promise<{ text: string }>;
};

type CapacitorGlobal = {
  getPlatform?: () => string;
  registerPlugin?: (name: string) => ClipboardTextPlugin;
};

let androidClipboardPlugin: ClipboardTextPlugin | null = null;

// Android WebView refuses `navigator.clipboard.readText()` outright ("Read
// permission denied") and has no prompt a page could trigger, so the Android
// app reads text through its own `ClipboardText` plugin
// (packages/mobile/android/.../ClipboardTextPlugin.java). iOS WKWebView and
// browsers keep the web API; iOS shows its own Paste button before it answers.
const getAndroidClipboardPlugin = (): ClipboardTextPlugin | null => {
  // SAFETY: `window.Capacitor` is injected by the native shell with this shape and
  // is absent in every other runtime, which the optional members account for.
  const capacitor = (window as typeof window & { Capacitor?: CapacitorGlobal }).Capacitor;
  if (capacitor?.getPlatform?.() !== 'android' || !capacitor.registerPlugin) return null;
  // registerPlugin warns and returns the old proxy when called twice.
  androidClipboardPlugin ??= capacitor.registerPlugin('ClipboardText');
  return androidClipboardPlugin;
};

/** Reads clipboard text. Call it from the click itself: browsers only allow reads during a user gesture. */
export async function readClipboardText(): Promise<string> {
  const plugin = getAndroidClipboardPlugin();
  if (plugin) return (await plugin.read()).text;
  return navigator.clipboard.readText();
}

// `plainText` replaces the Markdown source in `text/plain` for users who copy
// messages as plain text; the Markdown flavor is then left out entirely.
export async function copyMarkdownToClipboard(
  markdown: string,
  html: string,
  options: { plainText?: string } = {},
): Promise<ClipboardCopyResult> {
  const text = options.plainText ?? markdown;
  if (
    typeof navigator !== 'undefined'
    && navigator.clipboard?.write
    && typeof ClipboardItem !== 'undefined'
  ) {
    try {
      const payload: Record<string, Blob> = {
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      };
      if (options.plainText === undefined && typeof ClipboardItem.supports === 'function' && ClipboardItem.supports('text/markdown')) {
        payload['text/markdown'] = new Blob([markdown], { type: 'text/markdown' });
      }
      await navigator.clipboard.write([new ClipboardItem(payload)]);
      return { ok: true, method: 'clipboard' };
    } catch {
      // Fall back to text only when rich clipboard writes are unavailable.
    }
  }

  return copyTextToClipboard(text);
}
