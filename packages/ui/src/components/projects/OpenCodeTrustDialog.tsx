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
import {
  getOpenCodeTrustSnapshot,
  settleOpenCodeTrust,
  subscribeOpenCodeTrust,
  type OpenCodeTrustChoice,
  type OpenCodeTrustItem,
} from '@/lib/opencodeTrust';

const isPlugin = (item: OpenCodeTrustItem): boolean => item.kind === 'plugin' || item.kind === 'package' || item.kind === 'config';

/**
 * App-level dialog shown when OpenCode is about to open a folder whose
 * configuration runs code: plugins, MCP servers, language servers,
 * formatters, a custom shell. It lists exactly what would run. Closing it
 * without choosing keeps the folder closed this time.
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
  const commands = request?.items.filter((item) => !isPlugin(item)) ?? [];

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
          <DialogDescription>{t('projects.opencodeTrust.description', { path: request?.directory ?? '' })}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[40vh] space-y-3 overflow-y-auto">
          {plugins.length > 0 ? (
            <div className="space-y-1">
              <p className="typography-meta text-muted-foreground">{t('projects.opencodeTrust.plugins')}</p>
              <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 font-mono text-[0.8125rem] leading-relaxed break-all text-[var(--surface-foreground)]">
                {plugins.map((item) => (
                  <div key={`${item.kind}-${item.source}-${item.name}`}>{pluginLabel(item)}</div>
                ))}
              </div>
            </div>
          ) : null}
          {commands.length > 0 ? (
            <div className="space-y-1">
              <p className="typography-meta text-muted-foreground">{t('projects.opencodeTrust.commands')}</p>
              <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-[0.8125rem] leading-relaxed break-all text-[var(--surface-foreground)]">
                {commands.map((item) => (
                  <div key={`${item.kind}-${item.source}-${item.name}`}>
                    <span>{commandLabel(item)}</span>
                    <span className="text-muted-foreground">{' — '}</span>
                    <span className="font-mono">{item.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <p className="typography-meta text-muted-foreground">{t('projects.opencodeTrust.paused')}</p>
        </div>
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
