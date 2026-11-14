import React from 'react';
import { serviceProvides, type GuestCapability } from '@openchamber/sdk';

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
import { SESSION_EVENT_LABEL_KEYS } from '@/lib/guests/session-event-labels';
import type { InstalledGuest } from '@/lib/guests/types';
import { guestPanelOpensHere } from '@/lib/guests/phone';

const CAPABILITY_ROWS = {
  prompt: { icon: 'chat-1', titleKey: 'settings.extensions.capability.prompt', detailKey: 'settings.extensions.capability.prompt.detail' },
  sessions: { icon: 'git-branch', titleKey: 'settings.extensions.capability.sessions', detailKey: 'settings.extensions.capability.sessions.detail' },
  files: { icon: 'file-text', titleKey: 'settings.extensions.capability.files', detailKey: 'settings.extensions.capability.files.detail' },
  model: { icon: 'sparkling', titleKey: 'settings.extensions.capability.model', detailKey: 'settings.extensions.capability.model.detail' },
  shells: { icon: 'terminal-box', titleKey: 'settings.extensions.capability.shells', detailKey: 'settings.extensions.capability.shells.detail' },
  conversation: { icon: 'chat-history', titleKey: 'settings.extensions.capability.conversation', detailKey: 'settings.extensions.capability.conversation.detail' },
  filesystem: { icon: 'hard-drive-2', titleKey: 'settings.extensions.capability.filesystem', detailKey: 'settings.extensions.capability.filesystem.detail' },
  opencode: { icon: 'plug', titleKey: 'settings.extensions.capability.opencode', detailKey: 'settings.extensions.capability.opencode.detail' },
  service: { icon: 'terminal', titleKey: 'settings.extensions.capability.service', detailKey: 'settings.extensions.capability.service.detail' },
  network: { icon: 'plug', titleKey: 'settings.extensions.capability.network', detailKey: 'settings.extensions.capability.network.detail' },
  origins: { icon: 'global', titleKey: 'settings.extensions.capability.origins', detailKey: 'settings.extensions.capability.origins.detail' },
  transcript: { icon: 'history', titleKey: 'settings.extensions.capability.transcript', detailKey: 'settings.extensions.capability.transcript.detail' },
  sessionControl: { icon: 'robot-2', titleKey: 'settings.extensions.capability.sessionControl', detailKey: 'settings.extensions.capability.sessionControl.detail' },
  sessionAnswers: { icon: 'shield-check', titleKey: 'settings.extensions.capability.sessionAnswers', detailKey: 'settings.extensions.capability.sessionAnswers.detail' },
  instructions: { icon: 'book-open', titleKey: 'settings.extensions.capability.instructions', detailKey: 'settings.extensions.capability.instructions.detail' },
  skills: { icon: 'sparkling', titleKey: 'settings.extensions.capability.skills', detailKey: 'settings.extensions.capability.skills.detail' },
  opencodePlugin: { icon: 'puzzle', titleKey: 'settings.extensions.capability.opencodePlugin', detailKey: 'settings.extensions.capability.opencodePlugin.detail' },
  links: { icon: 'link', titleKey: 'settings.extensions.capability.links', detailKey: 'settings.extensions.capability.links.detail' },
  wake: { icon: 'timer', titleKey: 'settings.extensions.capability.wake', detailKey: 'settings.extensions.capability.wake.detail' },
  marks: { icon: 'flag', titleKey: 'settings.extensions.capability.marks', detailKey: 'settings.extensions.capability.marks.detail' },
} satisfies Record<GuestCapability, { icon: IconName; titleKey: I18nKey; detailKey: I18nKey }>;

type GuestApprovalDialogProps = {
  guest: InstalledGuest | null;
  busy: boolean;
  onApprove: (guest: InstalledGuest) => void;
  onDecline: (guest: InstalledGuest) => void;
  /** Leaves an installed package waiting; a package just added has only Remove. */
  onLater?: () => void;
  onDismiss: () => void;
};

/**
 * One-time approval of everything a package asks for. Shown right after an
 * install that requests any capability, and again from the card whenever a
 * newer package asks for more than the user approved.
 */
export const GuestApprovalDialog: React.FC<GuestApprovalDialogProps> = ({ guest, busy, onApprove, onDecline, onLater, onDismiss }) => {
  const { t } = useI18n();
  const requested = guest?.capabilities.requested ?? [];
  const filesystemPatterns = guest?.filesystem ?? [];
  const origins = guest?.origins ?? [];
  const serviceExec = guest?.service?.permissions?.exec ?? [];
  const serviceSockets = guest?.service?.permissions?.sockets ?? [];
  const providesBrowser = serviceProvides(guest?.service, 'browser');
  const providesSourceControl = serviceProvides(guest?.service, 'source-control');
  const providesNotifications = serviceProvides(guest?.service, 'notifications');
  const providesTracker = serviceProvides(guest?.service, 'tracker');
  const providesQuota = serviceProvides(guest?.service, 'quota');
  const quotaProviders = guest?.quota?.providers ?? [];
  const sessionEvents = guest?.sessionEvents?.events ?? [];
  const waits = guest?.waits ?? [];
  const apiOrigin = guest?.integration?.apiOrigin ?? null;

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
                  {capability === 'origins' && origins.length > 0 ? (
                    <ul className="mt-1 space-y-0.5">
                      {origins.map((origin) => (
                        <li key={origin} className="typography-meta break-all font-mono text-foreground">{origin}</li>
                      ))}
                    </ul>
                  ) : null}
                  {capability === 'network' && apiOrigin ? (
                    <p className="typography-meta mt-1 text-foreground">
                      {t('settings.extensions.capability.service.sockets')}{' '}
                      <span className="break-all font-mono">{apiOrigin}</span>
                    </p>
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
                  {capability === 'service' && providesBrowser ? (
                    <p className="typography-meta mt-0.5 text-foreground">
                      {t('settings.extensions.capability.service.providesBrowser')}
                    </p>
                  ) : null}
                  {capability === 'service' && providesSourceControl ? (
                    <p className="typography-meta mt-0.5 text-foreground">
                      {t('settings.extensions.capability.service.providesSourceControl', {
                        label: guest?.sourceControl?.label ?? guest?.name ?? '',
                      })}
                    </p>
                  ) : null}
                  {capability === 'service' && providesNotifications ? (
                    <p className="typography-meta mt-0.5 text-foreground">
                      {t('settings.extensions.capability.service.providesNotifications', {
                        label: guest?.notifications?.label ?? guest?.name ?? '',
                      })}
                    </p>
                  ) : null}
                  {capability === 'service' && providesTracker ? (
                    <div className="typography-meta mt-0.5 text-foreground">
                      <p>
                        {t('settings.extensions.capability.service.providesTracker', {
                          label: guest?.tracker?.label ?? guest?.name ?? '',
                        })}
                      </p>
                      <ul className="mt-0.5 list-disc space-y-0.5 ps-4">
                        <li>{t('settings.extensions.capability.service.providesTracker.reads')}</li>
                        <li>{t('settings.extensions.capability.service.providesTracker.writes')}</li>
                      </ul>
                      <p className="mt-0.5 text-muted-foreground">{t('settings.extensions.capability.service.providesTracker.tokens')}</p>
                    </div>
                  ) : null}
                  {capability === 'service' && providesQuota ? (
                    // The hand-over the user approves: the listed providers' credentials, or none. A changed list opens this dialog again.
                    <div className="typography-meta mt-0.5 text-foreground">
                      {quotaProviders.length > 0 ? (
                        <>
                          <p>{t('settings.extensions.capability.service.providesQuota')}</p>
                          <ul className="mt-0.5 list-disc space-y-0.5 ps-4">
                            {quotaProviders.map((providerId) => (
                              <li key={providerId} className="break-all font-mono">{providerId}</li>
                            ))}
                          </ul>
                          <p className="mt-0.5 text-muted-foreground">{t('settings.extensions.capability.service.providesQuota.credentials')}</p>
                        </>
                      ) : (
                        <p>{t('settings.extensions.capability.service.providesQuota.none')}</p>
                      )}
                    </div>
                  ) : null}
                  {capability === 'service' && guest?.service?.keepRunning ? (
                    <p className="typography-meta mt-0.5 text-foreground">{t('settings.extensions.capability.service.keepRunning')}</p>
                  ) : null}
                  {capability === 'service' && guest?.service?.schedule ? (
                    <div className="typography-meta mt-0.5 text-foreground">
                      <p>{t('settings.extensions.capability.service.schedule')}</p>
                      <ul className="mt-0.5 list-disc space-y-0.5 ps-4">
                        {guest.service.schedule.map((entry) => (
                          <li key={entry.id} className="break-all font-mono">{entry.timezone ? `${entry.cron} (${entry.timezone})` : entry.cron}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {capability === 'service' && guest?.mentions ? (
                    <p className="typography-meta mt-0.5 text-foreground">{t('settings.extensions.capability.service.mentions')}</p>
                  ) : null}
                  {capability === 'links' && guest?.links ? (
                    // Exactly what the grant covers: these keys and this site; a change opens this dialog again.
                    <div className="typography-meta mt-0.5 text-foreground">
                      <ul className="list-disc space-y-0.5 ps-4">
                        {guest.links.keys.map((key) => (
                          <li key={key} className="break-all font-mono">{`${key}-123`}</li>
                        ))}
                        {guest.links.urls ? <li className="break-all font-mono">{`${guest.links.urls.origin}/…`}</li> : null}
                      </ul>
                      <p className="mt-0.5 text-muted-foreground">
                        {/* The phone opens the panel only of an extension that opted into it; for any other a clicked link keeps its usual meaning there (`runGuestLink`). */}
                        {t(guest.links.action === 'attach' ? 'settings.extensions.capability.links.attach'
                          : guestPanelOpensHere(guest) ? 'settings.extensions.capability.links.open' : 'settings.extensions.capability.links.open.phone')}
                      </p>
                    </div>
                  ) : null}
                  {capability === 'marks' ? (
                    // What a click on a mark does: the panel when the package has one, else the mark's own link.
                    <p className="typography-meta mt-0.5 text-foreground">
                      {t(guest?.entry ? 'settings.extensions.capability.marks.panel' : 'settings.extensions.capability.marks.link')}
                    </p>
                  ) : null}
                  {capability === 'service' && sessionEvents.length > 0 ? (
                    <div className="typography-meta mt-0.5 text-foreground">
                      <p>{t('settings.extensions.capability.service.sessionEvents')}</p>
                      <ul className="mt-0.5 list-disc space-y-0.5 ps-4">
                        {sessionEvents.map((type) => (
                          <li key={type}>{t(SESSION_EVENT_LABEL_KEYS[type])}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {capability === 'wake' && waits.length > 0 ? (
                    <ul className="typography-meta mt-1 list-disc space-y-0.5 ps-4 text-foreground">
                      {waits.map((wait) => (
                        <li key={wait.id}>{wait.title}</li>
                      ))}
                    </ul>
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
          {onLater ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={onLater}>
              {t('settings.extensions.dialog.later')}
            </Button>
          ) : null}
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
