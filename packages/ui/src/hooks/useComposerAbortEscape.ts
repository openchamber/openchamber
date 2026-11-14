import React from 'react';
import { isIMECompositionEvent } from '@/lib/ime';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Which session an Escape from a composer would stop, and whether it is running. */
type ComposerAbortTarget = { sessionId: string | null; working: boolean };

type Options = {
  /** An overlay or a dropdown has the Escape. */
  isBlocked: () => boolean;
  /** The session the composer holding `target` stops. */
  resolveTarget: (target: Element) => ComposerAbortTarget;
  abort: (sessionId: string) => void;
};

const PRIME_MS = 3000;

/**
 * Double Escape from a chat's own composer stops that chat's run (the
 * `abort_run` shortcut): the first press arms the prompt, the second within
 * three seconds stops. Escape anywhere else belongs to what has focus, and an
 * Escape the composer spent on itself (a picker, shell mode, the expanded
 * input, a selection) arrives already prevented. BTW's composer is not a
 * chat's composer: its Escape collapses BTW. Shared by the main window and
 * Mini Chat, so both stop a run the same way while a draft stays typed.
 */
export const useComposerAbortEscape = (options: Options) => {
  const armAbortPrompt = useSessionUIStore((s) => s.armAbortPrompt);
  const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
  const optionsRef = React.useRef(options);
  optionsRef.current = options;
  const primedUntilRef = React.useRef<number | null>(null);
  const primedSessionRef = React.useRef<string | null>(null);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = React.useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    primedUntilRef.current = null;
    primedSessionRef.current = null;
    clearAbortPrompt();
  }, [clearAbortPrompt]);

  const handleKeyDown = React.useCallback((event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    const target = event.target instanceof Element ? event.target : null;
    const fromComposer = Boolean(target?.closest('[data-chat-input="true"]'))
      && !target?.closest('[data-btw-composer="true"]');
    if (!target || event.defaultPrevented || !fromComposer || isIMECompositionEvent(event)) {
      reset();
      return;
    }
    const { sessionId, working } = optionsRef.current.resolveTarget(target);
    if (optionsRef.current.isBlocked() || !working || !sessionId) {
      reset();
      return;
    }
    const now = Date.now();
    if (primedUntilRef.current && now < primedUntilRef.current && primedSessionRef.current === sessionId) {
      reset();
      event.preventDefault();
      optionsRef.current.abort(sessionId);
      return;
    }
    event.preventDefault();
    const expiresAt = armAbortPrompt(PRIME_MS, sessionId) ?? now + PRIME_MS;
    primedUntilRef.current = expiresAt;
    primedSessionRef.current = sessionId;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (primedUntilRef.current && Date.now() >= primedUntilRef.current) reset();
    }, Math.max(expiresAt - now, 0));
  }, [armAbortPrompt, reset]);

  React.useEffect(() => () => reset(), [reset]);

  return { handleKeyDown, reset };
};
