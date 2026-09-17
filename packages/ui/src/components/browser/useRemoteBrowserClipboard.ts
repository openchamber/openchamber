import React from 'react';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { I18nKey } from '@/lib/i18n';
import type { RemoteSurfaceClient } from '@/lib/browser/remoteSurface';
import { RemoteSurfaceClipboardError } from '@/lib/browser/remoteSurfaceClipboard';

type ClipboardFallback = { readonly kind: 'copy'; readonly text: string } | { readonly kind: 'paste' };

export function useRemoteBrowserClipboard(client: RemoteSurfaceClient, activeTabId: string | null, enabled: boolean) {
  const generation = React.useRef(0);
  const fallbackScope = React.useRef<() => boolean>(() => false);
  const [fallback, setFallback] = React.useState<ClipboardFallback | null>(null);
  const [feedback, setFeedback] = React.useState<I18nKey | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useLayoutEffect(() => {
    generation.current += 1;
    setFallback(null);
    setFeedback(null);
    setBusy(false);
    let scopeIsCurrent = client.captureInputScope();
    const unsubscribe = client.subscribe(() => {
      const state = client.getState();
      if (scopeIsCurrent() && state.phase === 'attached' && state.activeTabId === activeTabId) return;
      scopeIsCurrent = client.captureInputScope();
      generation.current += 1;
      setFallback(null);
      setFeedback(null);
      setBusy(false);
    });
    return () => { generation.current += 1; unsubscribe(); };
  }, [client, activeTabId, enabled]);

  const begin = () => {
    const operation = ++generation.current;
    const scopeIsCurrent = client.captureInputScope();
    setFeedback(null);
    setFallback(null);
    setBusy(false);
    return () => enabled && operation === generation.current && scopeIsCurrent();
  };

  const copy = async () => {
    if (!enabled) return;
    const isCurrent = begin();
    const operation = generation.current;
    if (!isCurrent()) return;
    setBusy(true);
    const selection = client.copySelection();
    let writeResult: Promise<boolean> | null = null;
    if (navigator.clipboard?.write && globalThis.ClipboardItem) {
      const blob = selection.then((text) => {
        if (!isCurrent()) throw new RemoteSurfaceClipboardError('COPY_CANCELLED');
        return new Blob([text], { type: 'text/plain' });
      });
      // Safari requires the write call during the gesture, before the remote selection arrives.
      try {
        writeResult = navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(() => true, () => false);
      } catch {
        writeResult = Promise.resolve(false);
      }
      void blob.catch(() => undefined);
    }
    try {
      const text = await selection;
      if (!isCurrent()) return;
      const copied = writeResult ? await writeResult : await copyTextToClipboard(text, isCurrent).then((result) => result.ok, () => false);
      if (!isCurrent()) return;
      if (copied) setFeedback('contextPanel.browser.remote.clipboard.copied');
      else { fallbackScope.current = isCurrent; setFallback({ kind: 'copy', text }); }
    } catch (error) {
      if (!isCurrent() || error instanceof RemoteSurfaceClipboardError && error.code === 'COPY_CANCELLED') return;
      const key = error instanceof RemoteSurfaceClipboardError && error.code === 'NO_SELECTION'
        ? 'contextPanel.browser.remote.clipboard.noSelection'
        : error instanceof RemoteSurfaceClipboardError && error.code === 'COPY_TOO_LARGE'
          ? 'contextPanel.browser.remote.clipboard.tooLarge' : 'contextPanel.browser.remote.clipboard.copyFailed';
      setFeedback(key);
    } finally {
      if (operation === generation.current) setBusy(false);
    }
  };

  const sendText = (text: string) => {
    if (!text) { setFeedback('contextPanel.browser.remote.clipboard.emptyClipboard'); return false; }
    const sent = client.sendText(text);
    setFeedback(sent ? 'contextPanel.browser.remote.clipboard.pasted' : 'contextPanel.browser.remote.clipboard.pasteFailed');
    return sent;
  };

  const pasteText = (text: string) => {
    if (!enabled) return;
    if (fallback && !fallbackScope.current()) { closeFallback(); return; }
    if (!client.captureInputScope()()) return;
    if (!fallback) generation.current += 1;
    setBusy(false);
    if (sendText(text)) setFallback(null);
  };

  const paste = async () => {
    if (!enabled) return;
    const isCurrent = begin();
    const operation = generation.current;
    if (!isCurrent()) return;
    if (window.isSecureContext === false || !navigator.clipboard?.readText) {
      fallbackScope.current = isCurrent;
      setFallback({ kind: 'paste' });
      return;
    }
    setBusy(true);
    try {
      const text = await navigator.clipboard.readText();
      if (isCurrent()) sendText(text);
    } catch {
      if (isCurrent()) { fallbackScope.current = isCurrent; setFallback({ kind: 'paste' }); }
    } finally {
      if (operation === generation.current) setBusy(false);
    }
  };

  const retryCopy = async () => {
    if (!enabled || fallback?.kind !== 'copy') return;
    if (!fallbackScope.current()) { closeFallback(); return; }
    const scopeIsCurrent = client.captureInputScope();
    const operation = generation.current;
    try {
      const result = await copyTextToClipboard(fallback.text, () => scopeIsCurrent() && operation === generation.current);
      if (!scopeIsCurrent() || operation !== generation.current) return;
      if (result.ok) {
        setFallback(null);
        setFeedback('contextPanel.browser.remote.clipboard.copied');
      } else setFeedback('contextPanel.browser.remote.clipboard.copyFailed');
    } catch {
      if (scopeIsCurrent() && operation === generation.current) setFeedback('contextPanel.browser.remote.clipboard.copyFailed');
    }
  };

  const closeFallback = () => { generation.current += 1; setFallback(null); setFeedback(null); setBusy(false); };
  return { fallback, feedback, busy, copy, paste, pasteText, retryCopy, closeFallback };
}
