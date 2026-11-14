import * as React from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  getOpenCodeTrustSnapshot,
  settleOpenCodeTrust,
  subscribeOpenCodeTrust,
  type OpenCodeTrustChoice,
  type OpenCodeTrustItem,
} from '@/lib/opencodeTrust';

const isPlugin = (item: OpenCodeTrustItem): boolean => item.kind === 'plugin' || item.kind === 'package' || item.kind === 'config';
const isValue = (item: OpenCodeTrustItem): boolean => item.kind === 'env' || item.kind === 'file';
const isCommand = (item: OpenCodeTrustItem): boolean => (
  item.kind === 'mcp' || item.kind === 'lsp' || item.kind === 'formatter' || item.kind === 'shell'
);

const listClassName = 'rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-[0.8125rem] leading-relaxed break-all text-[var(--surface-foreground)]';
const itemKey = (item: OpenCodeTrustItem): string => `${item.kind}-${item.source}-${item.name}-${item.detail}`;

/**
 * App-level dialog shown when OpenCode is about to open a folder whose
 * configuration the user has to trust: what it runs (plugins, MCP servers,
 * language servers, formatters, a custom shell), the values it reads from
 * the machine and the permissions it allows. It lists exactly that. Closing
 * it without choosing keeps the folder closed this time.
 */
export const OpenCodeTrustDialog = () => {
  const { t } = useI18n();
  const request = React.useSyncExternalStore(subscribeOpenCodeTrust, getOpenCodeTrustSnapshot, getOpenCodeTrustSnapshot);
  const [saving, setSaving] = React.useState(false);

  const settle = React.useCallback(async (choice: OpenCodeTrustChoice) => {
    setSaving(true);
    try {
      if (await settleOpenCodeTrust(choice) === 'failed') {
        toast.error(t('projects.opencodeTrust.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  }, [t]);

  const plugins = request?.items.filter(isPlugin) ?? [];
  const commands = request?.items.filter(isCommand) ?? [];
  const values = request?.items.filter(isValue) ?? [];
  const permissions = request?.items.filter((item) => item.kind === 'permission') ?? [];

  const pluginLabel = (item: OpenCodeTrustItem): string => {
    if (item.kind === 'package') return t('projects.opencodeTrust.kind.package', { name: item.name });
    if (item.kind === 'config') return t('projects.opencodeTrust.kind.config', { path: item.source });
    return item.name || item.source;
  };

  const commandLabel = (item: OpenCodeTrustItem): string => {
    if (item.kind === 'mcp') return t('projects.opencodeTrust.kind.mcp', { name: item.name });
    if (item.kind === 'lsp') return t('projects.opencodeTrust.kind.lsp', { name: item.name });
    if (item.kind === 'formatter') return t('projects.opencodeTrust.kind.formatter', { name: item.name });
    return t('projects.opencodeTrust.kind.shell');
  };

  const valueLabel = (item: OpenCodeTrustItem): string => (
    item.kind === 'env'
      ? t('projects.opencodeTrust.kind.env', { name: item.name })
      : t('projects.opencodeTrust.kind.file', { path: item.name })
  );

  const permissionLabel = (item: OpenCodeTrustItem): string => (
    item.name
      ? t('projects.opencodeTrust.permission.agent', { name: item.name })
      : t('projects.opencodeTrust.permission.everyAgent')
  );

  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open: boolean) => {
        if (!open && !saving) void settle('skip');
      }}
    >
      <DialogContent layerClassName="z-[70]" backdropProps={{ className: 'z-[70]' }}>
        <DialogHeader>
          <DialogTitle>{t('projects.opencodeTrust.title')}</DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">{t('projects.opencodeTrust.description', { path: request?.directory ?? '' })}</DialogDescription>
        </DialogHeader>
        <ScrollableOverlay outerClassName="max-h-[40vh]" className="space-y-3" disableHorizontal>
          {plugins.length > 0 ? (
            <div className="space-y-1">
              <p className="typography-meta text-muted-foreground">{t('projects.opencodeTrust.plugins')}</p>
              <div className={`${listClassName} font-mono`}>
                {plugins.map((item) => (
                  <div key={itemKey(item)}>{pluginLabel(item)}</div>
                ))}
              </div>
            </div>
          ) : null}
          {commands.length > 0 ? (
            <div className="space-y-1">
              <p className="typography-meta text-muted-foreground">{t('projects.opencodeTrust.commands')}</p>
              <div className={listClassName}>
                {commands.map((item) => (
                  <div key={itemKey(item)}>
                    <span>{commandLabel(item)}</span>
                    <span className="text-muted-foreground">{' — '}</span>
                    <span className="font-mono">{item.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {values.length > 0 ? (
            <div className="space-y-1">
              <p className="typography-meta text-muted-foreground">{t('projects.opencodeTrust.values')}</p>
              <div className={listClassName}>
                {values.map((item) => (
                  <div key={itemKey(item)}>{valueLabel(item)}</div>
                ))}
              </div>
            </div>
          ) : null}
          {permissions.length > 0 ? (
            <div className="space-y-1">
              <p className="typography-meta text-muted-foreground">{t('projects.opencodeTrust.permissions')}</p>
              <div className={listClassName}>
                {permissions.map((item) => (
                  <div key={itemKey(item)}>
                    <span>{permissionLabel(item)}</span>
                    <span className="text-muted-foreground">{' — '}</span>
                    <span className="font-mono">{item.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <p className="typography-meta text-muted-foreground">{t('projects.opencodeTrust.paused')}</p>
        </ScrollableOverlay>
        <DialogFooter>
          <Button variant="ghost" autoFocus disabled={saving} onClick={() => void settle('skip')}>
            {t('projects.opencodeTrust.skip')}
          </Button>
          <Button variant="default" disabled={saving} onClick={() => void settle('trust')}>
            {t('projects.opencodeTrust.trust')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
