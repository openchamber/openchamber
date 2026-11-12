import * as React from 'react';

import {
  getDesktopQuakeMode,
  setDesktopQuakeModeEnabled,
  setDesktopQuakeModeHeight,
  setDesktopQuakeModeShortcut,
  type QuakeModeStatus,
} from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { UNASSIGNED_SHORTCUT } from '@/lib/shortcuts';

// Quake Mode state for the desktop settings section. The section owns the
// Mini Chat global shortcut, which shares the conflict space with Quake, so
// it reads `combo` as a conflict source and calls `release` when its own
// recorder takes the Quake combo.
export const useDesktopQuakeMode = (isLocalDesktop: boolean, setError: (message: string | null) => void) => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<QuakeModeStatus | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setStatus(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      const next = await getDesktopQuakeMode();
      if (!cancelled) {
        setStatus(next);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  const supported = status?.supported === true;

  // Runs one settings write; resolves the new status, or null after showing
  // the failure.
  const save = React.useCallback(async (
    write: () => Promise<QuakeModeStatus | null>,
  ): Promise<QuakeModeStatus | null> => {
    if (!supported || isSaving) {
      return null;
    }

    setIsSaving(true);
    setError(null);

    try {
      const next = await write();
      if (!next?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.quakeModeSaveFailed'));
      }
      setStatus(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.quakeModeSaveFailed'));
      return null;
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, setError, supported, t]);

  const setEnabled = React.useCallback((enabled: boolean) => {
    void save(() => setDesktopQuakeModeEnabled(enabled));
  }, [save]);

  // Resolves true only when the combo was stored, so callers can tie other
  // changes to a successful save.
  const saveShortcut = React.useCallback(async (combo: string | null): Promise<boolean> => {
    const next = await save(() => setDesktopQuakeModeShortcut(combo));
    if (!next) return false;
    if (next.error === 'unsupported-combo') {
      setError(t('settings.openchamber.desktopNetwork.error.quakeModeShortcutUnsupported'));
      return false;
    }
    return true;
  }, [save, setError, t]);

  const setHeight = React.useCallback((heightFraction: number) => {
    void save(() => setDesktopQuakeModeHeight(heightFraction));
  }, [save]);

  // Gives the Quake combo away. Stored as unassigned, because clearing it
  // would bring back the default and collide with whatever took the combo.
  const release = React.useCallback(() => {
    void setDesktopQuakeModeShortcut(UNASSIGNED_SHORTCUT).then((next) => {
      if (next) setStatus(next);
    });
  }, []);

  return {
    supported,
    enabled: status?.enabled === true,
    combo: status?.combo ?? null,
    storedCombo: status?.storedCombo ?? null,
    active: status?.active === true,
    heightFraction: status?.heightFraction ?? 1,
    isSaving,
    setEnabled,
    saveShortcut,
    setHeight,
    release,
  };
};

export type DesktopQuakeMode = ReturnType<typeof useDesktopQuakeMode>;
