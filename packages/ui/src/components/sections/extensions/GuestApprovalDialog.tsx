import React from 'react';
import type { GuestCapability } from '@openchamber/sdk';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { InstalledGuest } from '@/lib/guests/types';

const CAPABILITY_ROWS = {
  prompt: { icon: 'chat-1', titleKey: 'settings.extensions.capability.prompt', detailKey: 'settings.extensions.capability.prompt.detail' },
  sessions: { icon: 'git-branch', titleKey: 'settings.extensions.capability.sessions', detailKey: 'settings.extensions.capability.sessions.detail' },
  files: { icon: 'file-text', titleKey: 'settings.extensions.capability.files', detailKey: 'settings.extensions.capability.files.detail' },
  conversation: { icon: 'chat-history', titleKey: 'settings.extensions.capability.conversation', detailKey: 'settings.extensions.capability.conversation.detail' },
  filesystem: { icon: 'hard-drive-2', titleKey: 'settings.extensions.capability.filesystem', detailKey: 'settings.extensions.capability.filesystem.detail' },
  service: { icon: 'terminal', titleKey: 'settings.extensions.capability.service', detailKey: 'settings.extensions.capability.service.detail' },
  network: { icon: 'plug', titleKey: 'settings.extensions.capability.network', detailKey: 'settings.extensions.capability.network.detail' },
} satisfies Record<GuestCapability, { icon: IconName; titleKey: I18nKey; detailKey: I18nKey }>;

type GuestApprovalDialogProps = {
  guest: InstalledGuest | null;
  busy: boolean;
  onApprove: (guest: InstalledGuest) => void;
  onDecline: (guest: InstalledGuest) => void;
  onDismiss: () => void;
};

/**
 * One-time approval of everything a package asks for. Shown right after an
 * install that requests any capability, and again from the card whenever a
 * newer package asks for more than the user approved.
 */
export const GuestApprovalDialog: React.FC<GuestApprovalDialogProps> = ({ guest, busy, onApprove, onDecline, onDismiss }) => {
  const { t } = useI18n();
  const requested = guest?.capabilities.requested ?? [];
  const filesystemPatterns = guest?.filesystem ?? [];
  const serviceExec = guest?.service?.permissions?.exec ?? [];
  const serviceSockets = guest?.service?.permissions?.sockets ?? [];

  return (
    <Dialog
      open={guest !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onDismiss();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.extensions.dialog.approveTitle', { name: guest?.name ?? '' })}</DialogTitle>
          <DialogDescription>
            {t('settings.extensions.dialog.approveDescription', {
              name: guest?.name ?? '',
              version: guest?.version ? `v${guest.version}` : '',
            })}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-3">
          {requested.map((capability) => {
            const row = CAPABILITY_ROWS[capability];
            return (
              <li key={capability} className="flex items-start gap-3">
                <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-muted)]">
                  <Icon name={row.icon} className="size-4 text-foreground" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{t(row.titleKey)}</div>
                  <p className="typography-meta text-muted-foreground">{t(row.detailKey)}</p>
                  {capability === 'filesystem' && filesystemPatterns.length > 0 ? (
                    <ul className="mt-1 space-y-0.5">
                      {filesystemPatterns.map((pattern) => (
                        <li key={pattern} className="typography-meta break-all font-mono text-foreground">{pattern}</li>
                      ))}
                    </ul>
                  ) : null}
                  {capability === 'service' && serviceExec.length > 0 ? (
                    <p className="typography-meta mt-1 text-foreground">
                      {t('settings.extensions.capability.service.runs')}{' '}
                      <span className="break-all font-mono">{serviceExec.join(', ')}</span>
                    </p>
                  ) : null}
                  {capability === 'service' && serviceSockets.length > 0 ? (
                    <p className="typography-meta mt-0.5 text-foreground">
                      {t('settings.extensions.capability.service.sockets')}{' '}
                      <span className="break-all font-mono">{serviceSockets.join(', ')}</span>
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => guest && onDecline(guest)}
          >
            {t('settings.extensions.dialog.decline')}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => guest && onApprove(guest)}
          >
            {t('settings.extensions.dialog.approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
