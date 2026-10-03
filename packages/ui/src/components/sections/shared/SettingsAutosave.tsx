import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

/**
 * Autosave for the OpenCode configuration pages (agents, commands, skills,
 * MCP, plugins, behavior).
 *
 * OpenCode v2 watches its own config files and applies changes within a second
 * or two, so these pages have no Save or Apply button. Toggles, selects and
 * pickers call `requestSave()` right after the state update; text fields are
 * committed by `onBlurCapture` on the page container (and by Cmd/Ctrl+Enter
 * where an editor supports it). Success is silent; a failed write is reported
 * with an error toast. There is no inline indicator: the write is not
 * something the user waits for.
 */

export type AutosaveResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: string };

/** Nothing to write — the form matches the last successful save. */
export const AUTOSAVE_UNCHANGED: AutosaveResult = { ok: true, changed: false };
/** Written. */
export const AUTOSAVE_SAVED: AutosaveResult = { ok: true, changed: true };
/** Refused or failed; the reason is shown to the user verbatim. */
export const autosaveFailed = (reason: string): AutosaveResult => ({ ok: false, reason });

export interface Autosave {
  /**
   * Save after the current render commits, so the routine reads the state the
   * control just set. Repeated calls in one tick collapse into one save, and
   * requests made while a save is in flight collapse into one follow-up save
   * that runs after it and reads the latest form state.
   */
  requestSave: () => void;
  /**
   * Attach to the element wrapping the page's fields: leaving a text input,
   * textarea or editor commits it.
   */
  onBlurCapture: React.FocusEventHandler;
}

const isTextEntry = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches('input, textarea, [contenteditable="true"]');
};

export const useAutosave = (save: () => Promise<AutosaveResult>): Autosave => {
  const { t } = useI18n();
  const [requestCount, setRequestCount] = React.useState(0);

  // The routine closes over the page's current form state, so it is read at
  // save time rather than captured when the request was queued.
  const saveRef = React.useRef(save);
  saveRef.current = save;
  const tRef = React.useRef(t);
  tRef.current = t;
  // Writes are serialized: a page's save routine compares the draft with the
  // last written value and moves that baseline after the write, so two
  // routines running at once could let the older write land last and leave
  // both the persisted value and the baseline on the older draft. While a save
  // is in flight, new requests only mark a follow-up; it runs once the current
  // save settles and reads whatever the form holds by then.
  const inFlightRef = React.useRef(false);
  const followUpRef = React.useRef(false);
  const mountedRef = React.useRef(false);

  const requestSave = React.useCallback(() => {
    setRequestCount((count) => count + 1);
  }, []);

  const onBlurCapture = React.useCallback<React.FocusEventHandler>((event) => {
    if (!isTextEntry(event.target)) return;
    requestSave();
  }, [requestSave]);

  const drain = React.useCallback(async () => {
    inFlightRef.current = true;
    try {
      while (true) {
        followUpRef.current = false;
        let result: AutosaveResult;
        try {
          result = await saveRef.current();
        } catch (error) {
          result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        if (!mountedRef.current) return;
        // A newer request supersedes this outcome: the follow-up save reports.
        if (followUpRef.current) continue;
        if (!result.ok) {
          toast.error(tRef.current('settings.common.status.saveFailedReason', { reason: result.reason }));
        }
        return;
      }
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (requestCount === 0) return;
    if (inFlightRef.current) {
      followUpRef.current = true;
      return;
    }
    void drain();
  }, [requestCount, drain]);

  return { requestSave, onBlurCapture };
};
