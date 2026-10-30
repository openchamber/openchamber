import React from 'react';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { openExternalUrl } from '@/lib/url';
import { Icon } from '@/components/icon/Icon';
import { SettingsFieldRow } from '@/components/sections/shared/SettingsSection';

type InstanceServiceInfo = {
  port: number | null;
  tunnelUrl: string | null;
};

type InstanceService = {
  key: string;
  label: string;
  url: string;
};

/**
 * Shows the active instance's service URLs (local server port + tunnel URL,
 * when a tunnel is active) as links that open the URL in the browser. The
 * data comes from `/api/system/info`, which the server derives from its own
 * runtime state — this is what makes each Git-worktree instance
 * distinguishable in the UI without reading terminal output.
 *
 * Nothing renders, `label` included, when the endpoint is unavailable or
 * reports no port/tunnel (e.g. VS Code runtime), so a failed fetch never
 * renders stale or wrong URLs and no label is left without a value.
 */
export const InstanceServiceUrls: React.FC<{ label?: string }> = ({ label }) => {
  const { t } = useI18n();
  const [info, setInfo] = React.useState<InstanceServiceInfo | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;

    const load = async () => {
      try {
        const response = await runtimeFetch('/api/system/info', {
          signal: controller?.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => null) as { port?: unknown; tunnelUrl?: unknown } | null;
        if (!data || cancelled) return;
        const port = typeof data.port === 'number' && Number.isFinite(data.port) && data.port > 0 ? data.port : null;
        const tunnelUrl = typeof data.tunnelUrl === 'string' && data.tunnelUrl.trim().length > 0
          ? data.tunnelUrl.trim()
          : null;
        setInfo({ port, tunnelUrl });
      } catch {
        // Best-effort: a failed fetch keeps the section hidden instead of
        // showing data we cannot verify.
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, []);

  const services: InstanceService[] = [];
  if (info?.port !== null && info?.port !== undefined) {
    services.push({
      key: 'application',
      label: t('settings.openchamber.about.field.applicationUrl'),
      url: `http://localhost:${info.port}/`,
    });
  }
  if (info?.tunnelUrl) {
    services.push({
      key: 'tunnel',
      label: t('settings.openchamber.about.field.tunnelUrl'),
      url: info.tunnelUrl,
    });
  }

  if (services.length === 0) {
    return null;
  }

  const links = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      {services.map((service) => (
        <button
          key={service.key}
          type="button"
          title={service.label}
          className="inline-flex max-w-full items-center gap-1.5 typography-meta text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            void openExternalUrl(service.url);
          }}
        >
          <span className="max-w-64 truncate font-mono">{service.url}</span>
          <Icon name="external-link" className="size-3.5 shrink-0" />
        </button>
      ))}
    </div>
  );

  return label ? <SettingsFieldRow label={label}>{links}</SettingsFieldRow> : links;
};
