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

const CAPABILITY_ROWS = {
  prompt: { icon: 'chat-1', titleKey: 'settings.extensions.capability.prompt', detailKey: 'settings.extensions.capability.prompt.detail' },
  sessions: { icon: 'git-branch', titleKey: 'settings.extensions.capability.sessions', detailKey: 'settings.extensions.capability.sessions.detail' },
  files: { icon: 'file-text', titleKey: 'settings.extensions.capability.files', detailKey: 'settings.extensions.capability.files.detail' },
  model: { icon: 'sparkling', titleKey: 'settings.extensions.capability.model', detailKey: 'settings.extensions.capability.model.detail' },
  shells: { icon: 'terminal-box', titleKey: 'settings.extensions.capability.shells', detailKey: 'settings.extensions.capability.shells.detail' },
  conversation: { icon: 'chat-history', titleKey: 'settings.extensions.capability.conversation', detailKey: 'settings.extensions.capability.conversation.detail' },
  filesystem: { icon: 'hard-drive-2', titleKey: 'settings.extensions.capability.filesystem', detailKey: 'settings.extensions.capability.filesystem.detail' },
  service: { icon: 'terminal', titleKey: 'settings.extensions.capability.service', detailKey: 'settings.extensions.capability.service.detail' },
  network: { icon: 'plug', titleKey: 'settings.extensions.capability.network', detailKey: 'settings.extensions.capability.network.detail' },
  origins: { icon: 'global', titleKey: 'settings.extensions.capability.origins', detailKey: 'settings.extensions.capability.origins.detail' },
  loopback: { icon: 'plug', titleKey: 'settings.extensions.capability.loopback', detailKey: 'settings.extensions.capability.loopback.detail' },
  plans: { icon: 'file-list-2', titleKey: 'settings.extensions.capability.plans', detailKey: 'settings.extensions.capability.plans.detail' },
  transcript: { icon: 'history', titleKey: 'settings.extensions.capability.transcript', detailKey: 'settings.extensions.capability.transcript.detail' },
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
  const origins = guest?.origins ?? [];
  const serviceExec = guest?.service?.permissions?.exec ?? [];
  const serviceSockets = guest?.service?.permissions?.sockets ?? [];
  const providesBrowser = serviceProvides(guest?.service, 'browser');
  const providesSourceControl = serviceProvides(guest?.service, 'source-control');
  const providesNotifications = serviceProvides(guest?.service, 'notifications');
  const providesTracker = serviceProvides(guest?.service, 'tracker');
  const sessionEvents = guest?.sessionEvents?.events ?? [];
  const apiOrigin = guest?.integration?.apiOrigin ?? null;
  const loopback = guest?.loopback;
  const planProviders = guest?.plans ?? [];
  let loopbackTarget: React.ReactNode = null;
  if (loopback) {
    switch (loopback.status) {
      case 'ready':
        loopbackTarget = (
          <p className="typography-meta mt-1 break-all font-mono text-foreground">
            {t('settings.extensions.capability.loopback.target', { target: `127.0.0.1:${loopback.resolvedPort}` })}
          </p>
        );
        break;
      case 'config-invalid':
        loopbackTarget = (
          <p role="alert" className="typography-meta mt-1 text-[var(--status-error-text)]">
            {t('settings.extensions.capability.loopback.invalid')}
          </p>
        );
        break;
      default: {
        const exhaustive: never = loopback;
        throw new TypeError(`Unexpected loopback state: ${exhaustive}`);
      }
    }
  }

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
                  {capability === 'loopback' && loopback ? (
                    <>
                      {loopbackTarget}
                      <p className="typography-meta mt-1 break-all text-muted-foreground">
                        {loopback.env
                          ? t('settings.extensions.capability.loopback.environment', { env: loopback.env, port: loopback.port })
                          : t('settings.extensions.capability.loopback.defaultPort', { port: loopback.port })}
                      </p>
                      <ul className="mt-1 space-y-0.5" aria-label={t('settings.extensions.capability.loopback.routes')}>
                        {loopback.routes.flatMap((route) => route.methods.map((method) => `${method} ${route.path}`)).sort().map((route) => (
                          <li key={route} className="typography-meta break-all font-mono text-foreground">{route}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
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
                  {capability === 'plans' && planProviders.length > 0 ? (
                    <ul className="mt-1 space-y-1">
                      {planProviders.map((provider) => (
                        <li key={provider.id}>
                          <p className="typography-meta break-all font-mono text-foreground">
                            {t('settings.extensions.capability.plans.provider', { label: provider.label, root: provider.root })}
                          </p>
                          <ul className="ms-3 space-y-0.5">
                            {(provider.actions ?? []).map((action) => (
                              <li key={action.id} className="typography-meta break-all font-mono text-muted-foreground">
                                {action.run.type === 'command'
                                  ? t('settings.extensions.capability.plans.command', { label: action.label, name: action.run.name, arguments: action.run.arguments ?? '' })
                                  : action.run.type === 'skill'
                                    ? t('settings.extensions.capability.plans.skill', { label: action.label, name: action.run.name, text: action.run.text })
                                    : t('settings.extensions.capability.plans.prompt', { label: action.label, text: action.run.text })}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
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
            disabled={busy || loopback?.status === 'config-invalid'}
            onClick={() => guest && onApprove(guest)}
          >
            {t('settings.extensions.dialog.approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
