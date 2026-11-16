import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';


export type AutosaveResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: string };

export const AUTOSAVE_UNCHANGED: AutosaveResult = { ok: true, changed: false };
export const AUTOSAVE_SAVED: AutosaveResult = { ok: true, changed: true };
export const autosaveFailed = (reason: string): AutosaveResult => ({ ok: false, reason });

export interface Autosave {
  requestSave: () => void;
  onBlurCapture: React.FocusEventHandler;
}

const isTextEntry = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches('input, textarea, [contenteditable="true"]');
};

export const useAutosave = (save: () => Promise<AutosaveResult>): Autosave => {
  const { t } = useI18n();
  const [requestCount, setRequestCount] = React.useState(0);

  const saveRef = React.useRef(save);
  saveRef.current = save;
  const tRef = React.useRef(t);
  tRef.current = t;
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
