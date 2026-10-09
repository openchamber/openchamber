import React from 'react';

type FirstLaunchSettings = { addProjectDialogDismissed?: boolean };

/**
 * The "Add project directory" dialog's open state. It opens by itself on the
 * first launch only: once the user closes it, it never opens by itself again,
 * on this or any client of the server. The settings document is read before
 * deciding, so a later launch does not flash it open, and a document that
 * cannot be read opens nothing.
 */
export const useFirstLaunchProjectDialog = ({
  ready,
  hasProjects,
  loadSettings,
  saveDismissed,
}: {
  /** The working directory is known and the app is shown. */
  ready: boolean;
  hasProjects: boolean;
  /** `null` is a failed read. */
  loadSettings: () => Promise<FirstLaunchSettings | null>;
  saveDismissed: () => void;
}) => {
  const [open, setOpen] = React.useState(false);
  const decidedRef = React.useRef(false);

  React.useEffect(() => {
    if (decidedRef.current || !ready || hasProjects) return;
    let cancelled = false;
    void loadSettings().then((settings) => {
      if (cancelled || !settings) return;
      decidedRef.current = true;
      if (settings.addProjectDialogDismissed !== true) setOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hasProjects, loadSettings, ready]);

  const onOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) saveDismissed();
  }, [saveDismissed]);

  return { open, setOpen, onOpenChange };
};
