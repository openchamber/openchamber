import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isDesktopShell, isTauriShell } from '@/lib/desktop';
import { desktopHostsGet, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';

const APP_TITLE = 'OpenChamber';

const formatProjectLabel = (label: string): string => {
  return label.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
};

const getProjectNameFromPath = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
};

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
      return formatProjectLabel(label);
    }

    const pathName = getProjectNameFromPath(activeProject.path);
    if (pathName) {
      return formatProjectLabel(pathName);
    }

    return null;
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
        const currentHref = window.location.href;
        const localOrigin = window.__OPENCHAMBER_LOCAL_ORIGIN__ || window.location.origin;

        if (locationMatchesHost(currentHref, localOrigin)) {
          if (!cancelled) {
            setInstanceLabel(null);
          }
          return;
        }

        const cfg = await desktopHostsGet();
        const match = cfg.hosts.find((host) => locationMatchesHost(currentHref, host.url));
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

    if (!isTauriShell()) {
      return;
    }

    let cancelled = false;

    const applyTitle = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (cancelled) {
          return;
        }
        const currentWindow = getCurrentWindow();
        await currentWindow.setTitle(title);
      } catch {
        return;
      }
    };

    void applyTitle();

    return () => {
      cancelled = true;
    };
  }, [title]);
};
