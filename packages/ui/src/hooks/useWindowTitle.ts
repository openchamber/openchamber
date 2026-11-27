import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isDesktopShell } from '@/lib/desktop';
import { desktopHostsGet, redactSensitiveUrl } from '@/lib/desktopHosts';
import { LOCAL_HOST_ID, resolveCurrentDesktopHost, runtimeKeyForDesktopHost, withLocalDesktopHost } from '@/lib/desktopCurrentHost';
import { setDesktopWindowTitle } from '@/lib/desktopNative';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { isContextWindow } from '@/lib/contextWindow/role';

const APP_TITLE = 'OpenChamber';

const formatProjectLabel = (label: string): string => label.trim();

const getProjectNameFromPath = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
};

const buildWindowTitle = (projectLabel: string | null, windowLabel: string | null, instanceLabel: string | null): string => {
  const parts = [projectLabel, windowLabel, instanceLabel, APP_TITLE].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return parts.join(' | ');
};

export const useWindowTitle = () => {
  const { t } = useI18n();
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const windowLabel = isContextWindow() ? t('contextPanel.window.title') : null;
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

  const [instance, setInstance] = React.useState<{ runtimeKey: string; label: string } | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !isDesktopShell()) {
      return;
    }

    let cancelled = false;

    const refreshInstanceLabel = async () => {
      try {
        const cfg = await desktopHostsGet();
        if (cancelled || getRuntimeKey() !== runtimeKey) return;
        const host = cfg.hosts.find((entry) => runtimeKeyForDesktopHost(entry) === runtimeKey)
          ?? resolveCurrentDesktopHost(withLocalDesktopHost(cfg.hosts, cfg.localOrigin));
        const label = host.id === LOCAL_HOST_ID
          ? t('desktopHostSwitcher.instance.local')
          : host.id === 'custom' && !host.url
            ? t('desktopHostSwitcher.instance.fallback')
            : redactSensitiveUrl(host.label.trim()) || t('desktopHostSwitcher.instance.fallback');
        setInstance({ runtimeKey, label });
      } catch {
        return;
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
  }, [runtimeKey, t]);

  const instanceLabel = instance?.runtimeKey === runtimeKey
    ? instance.label
    : t(runtimeKey === LOCAL_HOST_ID ? 'desktopHostSwitcher.instance.local' : 'desktopHostSwitcher.instance.fallback');
  const title = isDesktopShell()
    ? [APP_TITLE, instanceLabel, windowLabel].filter(Boolean).join(' - ')
    : buildWindowTitle(projectLabel, windowLabel, null);

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
