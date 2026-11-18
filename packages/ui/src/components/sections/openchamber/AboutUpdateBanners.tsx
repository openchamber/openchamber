import React from 'react';
import type { UpdateInfo } from '@/lib/desktop';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';

type OfferedUpdate = { info: UpdateInfo | null; onUpdate: () => void };

type AboutUpdateBannersProps = {
  /** The update the page's own update flow installs; `owner` names what it updates. */
  main: (OfferedUpdate & { owner: 'openchamber' | 'app' | 'server' }) | null;
  /** The remote host's server update while the desktop app is connected to one. */
  remoteHost: OfferedUpdate | null;
  /** A native app build the user downloads by hand. */
  appDownload: { version: string; url: string } | null;
  describeVersion: (version: string, beside?: string | null) => string;
};

const TITLE_KEYS = {
  openchamber: 'settings.openchamber.about.updateBanner.available',
  app: 'settings.openchamber.about.updateBanner.appAvailable',
  server: 'settings.openchamber.about.updateBanner.serverAvailable',
} as const;

const Banner: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex items-center gap-3 rounded-lg bg-[var(--status-info-background)] px-3 py-2">
    <Icon name="download" className="size-4 shrink-0 text-[var(--status-info)]" />
    <span className="min-w-0 flex-1 typography-ui-label text-foreground">{title}</span>
    {children}
  </div>
);

// An offered update is news, so it gets a tinted strip above the About rows; the rows stay plain facts.
export const AboutUpdateBanners: React.FC<AboutUpdateBannersProps> = ({ main, remoteHost, appDownload, describeVersion }) => {
  const { t } = useI18n();
  const versionOf = (info: UpdateInfo | null) => describeVersion(info?.version || '', info?.currentVersion);
  const updateButton = ({ info, onUpdate }: OfferedUpdate) => (
    <Button size="sm" variant="default" onClick={onUpdate} disabled={info?.installBlocked === 'opencode-version'}>
      {t('settings.openchamber.about.actions.update')}
    </Button>
  );
  if (!main && !remoteHost && !appDownload) return null;
  return (
    <div className="space-y-2">
      {main && <Banner title={t(TITLE_KEYS[main.owner], { version: versionOf(main.info) })}>{updateButton(main)}</Banner>}
      {remoteHost && (
        <Banner title={t(TITLE_KEYS.server, { version: versionOf(remoteHost.info) })}>{updateButton(remoteHost)}</Banner>
      )}
      {appDownload && (
        <Banner title={t(TITLE_KEYS.app, { version: appDownload.version })}>
          <Button size="sm" variant="default" onClick={() => void openExternalUrl(appDownload.url)}>
            {t('settings.openchamber.about.actions.download')}
          </Button>
        </Banner>
      )}
    </div>
  );
};
