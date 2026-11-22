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

  return label ? <SettingsFieldRow label={label} alignEnd={false} controlClassName="min-h-8">{links}</SettingsFieldRow> : links;
};
