import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { desktopHostsGet, getDesktopHostApiUrl, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { setDesktopWindowTitle } from '@/lib/desktopNative';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { deriveProjectLabelFromPath } from '@/lib/projectResolution';

const APP_TITLE = 'OpenChamber';

const buildWindowTitle = (projectLabel: string | null, instanceLabel: string | null): string => {
  const parts = [projectLabel, instanceLabel, APP_TITLE].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return parts.join(' | ');
};

export const useWindowTitle = () => {
  const activeProject = useProjectsStore((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
  });

  const projectLabel = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }

    const label = activeProject.label?.trim();
    if (label) {
      return label;
    }

    return deriveProjectLabelFromPath(activeProject.path) || null;
  }, [activeProject]);

  const [instanceLabel, setInstanceLabel] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !isDesktopShell()) {
      setInstanceLabel(null);
      return;
    }

    let cancelled = false;

    const refreshInstanceLabel = async () => {
      try {
        if (isDesktopLocalOriginActive()) {
          if (!cancelled) {
            setInstanceLabel(null);
          }
          return;
        }

        const localOrigin = window.__OPENCHAMBER_LOCAL_ORIGIN__ || window.location.origin;
        const runtimeApiBaseUrl = getRuntimeApiBaseUrl();

        if (runtimeApiBaseUrl && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) {
          if (!cancelled) {
            setInstanceLabel(null);
          }
          return;
        }

        const cfg = await desktopHostsGet();
        const match = cfg.hosts.find((host) => runtimeApiBaseUrl ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(host)) : false);
        const nextLabel = match?.label?.trim() ? redactSensitiveUrl(match.label.trim()) : 'Instance';
        if (!cancelled) {
          setInstanceLabel(nextLabel);
        }
      } catch {
        if (!cancelled) {
          setInstanceLabel('Instance');
        }
      }
    };

    void refreshInstanceLabel();

    const handleFocus = () => {
      void refreshInstanceLabel();
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  const title = React.useMemo(() => buildWindowTitle(projectLabel, instanceLabel), [projectLabel, instanceLabel]);

  React.useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = title;
    }

    if (!isDesktopShell()) {
      return;
    }

    const applyTitle = async () => {
      try {
        const isMac = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent || '');
        if (isMac) {
          return;
        }

        await setDesktopWindowTitle(title);
      } catch {
        return;
      }
    };

    void applyTitle();
  }, [title]);
};
