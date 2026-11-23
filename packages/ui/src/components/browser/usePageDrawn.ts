import * as React from 'react';
import { deepActiveElement } from './useWebviewFocusGuard';

const INPUT_TIMEOUT_MS = 12_000;

export function usePageDrawn(
  stageRef: React.RefObject<HTMLElement | null>,
  webviewRef: React.RefObject<HTMLElement | null>,
  revealStage: (stage: HTMLElement | null, purpose: 'input') => () => void,
  waitForTwoFrames: () => Promise<boolean>,
) {
  return React.useCallback(async <T,>(run: (expiresAt: number) => Promise<T>): Promise<T> => {
    const expiresAt = Date.now() + INPUT_TIMEOUT_MS;
    const restoreStage = revealStage(stageRef.current, 'input');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!await waitForTwoFrames()) {
        throw new Error('The OpenChamber window is not being drawn (minimized, on a workspace or tab that is not shown, or the screen is locked or off), so the page takes no input. browser.snapshot still reads the page.');
      }
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The page did not take the input in time. Take a snapshot to see its state.')), Math.max(0, expiresAt - Date.now()));
      });
      const userFocus = webviewRef.current && document.activeElement !== webviewRef.current ? deepActiveElement() : null;
      let userActed = false;
      const onUserInput = (event: Event) => { if (event.isTrusted) userActed = true; };
      document.addEventListener('pointerdown', onUserInput, true);
      document.addEventListener('keydown', onUserInput, true);
      try {
        return await Promise.race([run(expiresAt), late]);
      } finally {
        document.removeEventListener('pointerdown', onUserInput, true);
        document.removeEventListener('keydown', onUserInput, true);
        if (!userActed && userFocus?.isConnected && userFocus !== document.body && deepActiveElement() !== userFocus && document.activeElement !== webviewRef.current) {
          userFocus.focus({ preventScroll: true });
        }
      }
    } finally {
      clearTimeout(timer);
      restoreStage();
    }
  }, [stageRef, webviewRef, revealStage, waitForTwoFrames]);
}
