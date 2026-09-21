import React from 'react';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { openExternalUrl } from '@/lib/url';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';

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
 * when a tunnel is active) as labeled buttons that open the URL in the
 * browser. The data comes from `/api/system/info`, which the server derives
 * from its own runtime state — this is what makes each Git-worktree instance
 * distinguishable in the UI without reading terminal output.
 *
 * The section stays hidden when the endpoint is unavailable or reports no
 * port/tunnel (e.g. VS Code runtime), so a failed fetch never renders stale
 * or wrong URLs.
 */
export const InstanceServiceUrls: React.FC = () => {
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      {services.map((service) => (
        <Button
          key={service.key}
          type="button"
          variant="outline"
          size="sm"
          title={service.label}
          className="max-w-full gap-1.5 px-2.5"
          onClick={() => {
            void openExternalUrl(service.url);
          }}
        >
          <Icon name="external-link" className="size-3.5 shrink-0" />
          <span className="max-w-64 truncate font-mono typography-micro">{service.url}</span>
        </Button>
      ))}
    </div>
  );
};
