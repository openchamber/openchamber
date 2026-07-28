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

export async function copyMarkdownToClipboard(markdown: string, html: string): Promise<ClipboardCopyResult> {
  if (
    typeof navigator !== 'undefined'
    && navigator.clipboard?.write
    && typeof ClipboardItem !== 'undefined'
  ) {
    try {
      const payload: Record<string, Blob> = {
        'text/plain': new Blob([markdown], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      };
      if (typeof ClipboardItem.supports === 'function' && ClipboardItem.supports('text/markdown')) {
        payload['text/markdown'] = new Blob([markdown], { type: 'text/markdown' });
      }
      await navigator.clipboard.write([new ClipboardItem(payload)]);
      return { ok: true, method: 'clipboard' };
    } catch {
      // Fall back to plain Markdown when rich clipboard writes are unavailable.
    }
  }

  return copyTextToClipboard(markdown);
}
