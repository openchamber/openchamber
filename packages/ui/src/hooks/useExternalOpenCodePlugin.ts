import * as React from 'react';
import { z } from 'zod';

import { toast } from '@/components/ui';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

const statusSchema = z.object({
  delivery: z.enum(['file', 'restart', 'none', 'remote']),
  pluginPath: z.string().nullable(),
  globalConfigPath: z.string().nullable(),
  inGlobalConfig: z.boolean(),
  bridgeActive: z.boolean(),
  loadedInDirectory: z.boolean().nullable().optional(),
});

const mutateSuccessSchema = z.object({
  path: z.string().min(1),
});

const removeSuccessSchema = z.object({
  path: z.string().min(1),
  removed: z.boolean(),
});

const failureSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  path: z.string().optional(),
});

type Failure = z.infer<typeof failureSchema>;

const readOnlyPath = (failure: Failure) => (failure.error === 'config-read-only' ? failure.path : undefined);

type ExternalPluginStatus = z.infer<typeof statusSchema>;

const fetchStatus = async (directory?: string): Promise<ExternalPluginStatus | null> => {
  try {
    const response = await runtimeFetch('/api/config/external-opencode-plugin', {
      headers: { Accept: 'application/json' },
      query: directory ? { directory } : undefined,
    });
    if (!response.ok) return null;
    const parsed = statusSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const useExternalOpenCodePlugin = (refreshKey = 0) => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<ExternalPluginStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [justAddedPath, setJustAddedPath] = React.useState<string | null>(null);

  const latestRequest = React.useRef(0);

  const loadStatus = React.useCallback(async () => {
    const request = latestRequest.current + 1;
    latestRequest.current = request;
    const registration = await fetchStatus();
    if (!registration || request !== latestRequest.current) return;
    const directory = resolveEffectiveDirectory();
    const checksFolder = Boolean(directory) && registration.delivery === 'none' && registration.bridgeActive;
    if (!checksFolder || registration.inGlobalConfig) setStatus(registration);
    if (!checksFolder) return;
    const inDirectory = await fetchStatus(directory);
    if (request === latestRequest.current) setStatus(inDirectory ?? registration);
  }, []);

  React.useEffect(() => {
    void loadStatus();
  }, [loadStatus, refreshKey]);

  React.useEffect(() => {
    const reload = () => { void loadStatus(); };
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [loadStatus]);

  const copyPath = React.useCallback(async () => {
    if (!status?.pluginPath) return;
    try {
      await navigator.clipboard.writeText(status.pluginPath);
      toast.success(t('settings.openchamber.externalPlugin.copied'));
    } catch {
      return;
    }
  }, [status?.pluginPath, t]);

  const addToGlobalConfig = React.useCallback(async () => {
    setBusy(true);
    try {
      const response = await runtimeFetch('/api/config/external-opencode-plugin/global-config', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const parsed = mutateSuccessSchema.safeParse(body);
        if (parsed.success) setJustAddedPath(parsed.data.path);
        await loadStatus();
        return;
      }
      const failure = failureSchema.safeParse(body);
      const readOnly = failure.success ? readOnlyPath(failure.data) : undefined;
      toast.error(
        readOnly
          ? t('settings.openchamber.externalPlugin.toast.configReadOnly', { path: readOnly })
          : failure.success && failure.data.message
            ? t('settings.openchamber.externalPlugin.toast.addFailedReason', { reason: failure.data.message })
            : t('settings.openchamber.externalPlugin.toast.addFailed'),
      );
    } catch {
      toast.error(t('settings.openchamber.externalPlugin.toast.addFailed'));
    } finally {
      setBusy(false);
    }
  }, [loadStatus, t]);

  const removeFromGlobalConfig = React.useCallback(async () => {
    setBusy(true);
    try {
      const response = await runtimeFetch('/api/config/external-opencode-plugin/global-config', {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const parsed = removeSuccessSchema.safeParse(body);
        if (parsed.success && parsed.data.removed) {
          setJustAddedPath(null);
          toast.success(t('settings.openchamber.externalPlugin.toast.removed', { path: parsed.data.path }));
        } else {
          toast.error(t('settings.openchamber.externalPlugin.toast.removeFailed'));
        }
        await loadStatus();
        return;
      }
      const failure = failureSchema.safeParse(body);
      const readOnly = failure.success ? readOnlyPath(failure.data) : undefined;
      toast.error(
        readOnly
          ? t('settings.openchamber.externalPlugin.toast.configReadOnly', { path: readOnly })
          : failure.success && failure.data.message
            ? t('settings.openchamber.externalPlugin.toast.removeFailedReason', { reason: failure.data.message })
            : t('settings.openchamber.externalPlugin.toast.removeFailed'),
      );
    } catch {
      toast.error(t('settings.openchamber.externalPlugin.toast.removeFailed'));
    } finally {
      setBusy(false);
    }
  }, [loadStatus, t]);

  return {
    status,
    busy,
    justAddedPath,
    copyPath,
    addToGlobalConfig,
    removeFromGlobalConfig,
  };
};
