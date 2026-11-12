import React from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { addGuestPluginToGlobalConfig, type OpenCodePluginNotice } from '@/lib/guests/opencode-plugin';
import type { InstalledGuest } from '@/lib/guests/types';

type OpenCodePluginBannerProps = {
  guest: InstalledGuest;
  notice: OpenCodePluginNotice;
  busy: boolean;
  /** The file the button wrote, shown until the user leaves the screen. */
  onAdded: (path: string) => void;
};

/**
 * The extension's OpenCode plugin on its detail screen, in the update banner's
 * shape: a sentence and, where the managed config does not reach OpenCode, the
 * "Add to global config" button. The server decides every case
 * (`openCodePluginNotice`); this draws it.
 */
export const OpenCodePluginBanner: React.FC<OpenCodePluginBannerProps> = ({ guest, notice, busy, onAdded }) => {
  const { t } = useI18n();
  const [adding, setAdding] = React.useState(false);

  if (notice.kind === 'added') {
    return <p className="rounded-lg bg-[var(--status-info)]/10 p-3 typography-meta text-[var(--status-info)]">{t('settings.extensions.opencodePlugin.added', { path: notice.path })}</p>;
  }
  if (notice.kind === 'inGlobalConfig') {
    return <p className="rounded-lg bg-[var(--status-info)]/10 p-3 typography-meta text-[var(--status-info)]">{t('settings.extensions.opencodePlugin.inGlobal', { path: notice.path })}</p>;
  }
  if (notice.kind === 'remote') {
    return <p className="rounded-lg bg-[var(--status-info)]/10 p-3 typography-meta text-[var(--status-info)]">{t('settings.extensions.opencodePlugin.remote')}</p>;
  }

  const add = async () => {
    setAdding(true);
    const result = await addGuestPluginToGlobalConfig(guest);
    setAdding(false);
    if (!result.ok) {
      toast.error(result.reason
        ? t('settings.extensions.opencodePlugin.toast.failedReason', { reason: result.reason })
        : t('settings.extensions.opencodePlugin.toast.failed'));
      return;
    }
    onAdded(result.path);
    // Every other window reads the listing again too; this one shows the written path meanwhile.
    void loadGuestCatalog();
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--status-info)]/10 p-3">
      <span className="typography-meta min-w-0 flex-1 basis-64 text-[var(--status-info)]">
        {notice.delivery === 'none'
          ? t('settings.extensions.opencodePlugin.external')
          : t('settings.extensions.opencodePlugin.ownConfig')}
      </span>
      <Button
        type="button"
        size="sm"
        className="ms-auto"
        disabled={busy || adding}
        aria-label={t('settings.extensions.opencodePlugin.addToGlobal.aria', { name: guest.name })}
        onClick={() => void add()}
      >
        {t('settings.extensions.opencodePlugin.addToGlobal')}
      </Button>
    </div>
  );
};
