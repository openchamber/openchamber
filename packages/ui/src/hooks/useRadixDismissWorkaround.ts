import { useEffect } from 'react';
import { isTauriShell } from '@/lib/desktop';

/**
 * Workaround for Radix UI dropdown/select dismiss failing in Tauri on macOS.
 *
 * Root cause: Radix's DismissableLayer sets `body.style.pointerEvents = "none"`
 * for modal menus/selects. In Tauri with `transparent: true` on macOS, this
 * causes WKWebView to stop delivering `pointerdown` events to the document,
 * so the DismissableLayer's dismiss handler never fires.
 *
 * Fix: Listen for `mousedown` on the window (which still fires reliably) and
 * when a click lands outside any open Radix floating content, synthesize an
 * Escape keydown event to trigger Radix's built-in escape-key dismiss path.
 */
export function useRadixDismissWorkaround() {
  useEffect(() => {
    if (!isTauriShell()) return;

    const FLOATING_SELECTOR = [
      '[data-radix-menu-content][data-state="open"]',
      '[data-radix-select-content]',
      '[data-slot="dropdown-menu-content"][data-state="open"]',
      '[data-slot="select-content"][data-state="open"]',
    ].join(', ');

    const handleMouseDown = (event: MouseEvent) => {
      const openContent = document.querySelectorAll(FLOATING_SELECTOR);
      if (openContent.length === 0) return;

      const target = event.target as Node | null;
      if (!target) return;

      // Check if the click is inside any open floating content
      for (const el of openContent) {
        if (el.contains(target)) return;
      }

      // Click was outside all open floating content — dismiss via Escape
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          bubbles: true,
          cancelable: true,
        })
      );
    };

    // Use capture phase to fire before anything else can stopPropagation
    window.addEventListener('mousedown', handleMouseDown, { capture: true });
    return () => {
      window.removeEventListener('mousedown', handleMouseDown, { capture: true });
    };
  }, []);
}
