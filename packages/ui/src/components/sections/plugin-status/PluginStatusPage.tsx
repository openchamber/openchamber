import { useEffect, useMemo, useState } from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useInputStore } from '@/sync/input-store';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';

type PluginStatus = 'ok' | 'warning' | 'error';

interface PluginStatusItem {
  id: string;
  name: string;
  shortName: string;
  status: PluginStatus;
  error?: string;
  command: string;
}

const STATUS_BG_CLASS: Record<PluginStatus, string> = {
  ok: 'bg-[var(--status-success-background)]',
  warning: 'bg-[var(--status-warning-background)]',
  error: 'bg-[var(--status-error-background)]',
};
function StatusIcon({ status }: { status: PluginStatus }) {
  switch (status) {
    case 'ok':
      return <Icon name="checkbox-circle" className="h-4 w-4 text-[var(--status-success)]" />;
    case 'warning':
      return <Icon name="alert" className="h-4 w-4 text-[var(--status-warning)]" />;
    case 'error':
      return <Icon name="close-circle" className="h-4 w-4 text-[var(--status-error)]" />;
    default:
      return null;
  }
}

export function PluginStatusPage() {
  const { t } = useI18n();
  const directory = useDirectoryStore((state) => state.currentDirectory ?? null);
  const [items, setItems] = useState<PluginStatusItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PluginStatusItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const url = directory
          ? `/api/config/plugins/status?directory=${encodeURIComponent(directory)}`
          : '/api/config/plugins/status';
        const response = await runtimeFetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!cancelled) {
          setItems(Array.isArray(data?.status) ? data.status : []);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setItems([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [directory]);
  const handleCopyCommand = async (command: string) => {
    const ok = await copyTextToClipboard(command);
    if (ok) {
      toast.success(t('settings.pluginStatus.toast.copied'));
    } else {
      toast.error('Copy failed');
    }
  };

  const handleSendToChat = (command: string) => {
    useInputStore.getState().setPendingInputText(command, 'append');
    setSelected(null);
  };

  const statusCounts = useMemo(() => {
    return items.reduce(
      (acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      },
      { ok: 0, warning: 0, error: 0 } as Record<PluginStatus, number>,
    );
  }, [items]);

  const title = t('settings.pluginStatus.title');

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-[var(--border)] px-5 py-4">
          <h1 className="text-lg font-semibold">{title}</h1>
        </header>
        <div className="flex flex-1 items-center justify-center">
          <Icon name="loader-4" className="h-6 w-6 animate-spin text-[var(--muted-foreground)]" />
          <span className="ml-2 text-[var(--muted-foreground)]">{t('settings.pluginStatus.loading')}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-[var(--border)] px-5 py-4">
          <h1 className="text-lg font-semibold">{title}</h1>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center px-5 text-center">
          <Icon name="error-warning" className="h-8 w-8 text-[var(--status-error)]" />
          <p className="mt-2 text-[var(--muted-foreground)]">{t('settings.pluginStatus.error')}</p>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">{error}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <h1 className="text-lg font-semibold">{title}</h1>
        {items.length > 0 && (
          <div className="flex items-center gap-3 text-sm">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-[var(--status-success)]" />
              {statusCounts.ok}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-[var(--status-warning)]" />
              {statusCounts.warning}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-[var(--status-error)]" />
              {statusCounts.error}
            </span>
          </div>
        )}
      </header>

      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-5 text-center">
          <Icon name="plug" className="h-10 w-10 text-[var(--muted-foreground)]" />
          <p className="mt-3 font-medium">{t('settings.pluginStatus.empty.title')}</p>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">{t('settings.pluginStatus.empty.description')}</p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-auto">
          {items.map((item) => (
            <li key={item.id}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setSelected(item)}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-[var(--accent)]"
                  >
                    <StatusIcon status={item.status} />
                    <span className="flex-1 truncate">{item.shortName}</span>
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${STATUS_BG_CLASS[item.status]} text-[var(--foreground)]`}
                    >
                      {t(`settings.pluginStatus.status.${item.status}`)}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" align="start">
                  <p className="max-w-xs break-words">{item.name}</p>
                  {item.error && <p className="mt-1 text-[var(--status-error)]">{item.error}</p>}
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('settings.pluginStatus.dialog.title')}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <StatusIcon status={selected.status} />
                <span className="font-medium">{selected.name}</span>
                <span
                  className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${STATUS_BG_CLASS[selected.status]}`}
                >
                  {t(`settings.pluginStatus.status.${selected.status}`)}
                </span>
              </div>

              {selected.error && (
                <div className="rounded-md bg-[var(--status-error-background)] p-3 text-sm text-[var(--status-error)]">
                  <strong>{t('settings.pluginStatus.dialog.errorLabel')}: </strong>
                  {selected.error}
                </div>
              )}

              <div className="space-y-1">
                <label className="text-sm font-medium">{t('settings.pluginStatus.dialog.commandLabel')}</label>
                <Textarea value={selected.command} readOnly rows={4} className="resize-none font-mono text-sm" />
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => handleCopyCommand(selected.command)}>
                  <Icon name="file-copy" className="mr-1 h-4 w-4" />
                  {t('settings.pluginStatus.dialog.copy')}
                </Button>
                <Button onClick={() => handleSendToChat(selected.command)}>
                  <Icon name="chat-thread" className="mr-1 h-4 w-4" />
                  {t('settings.pluginStatus.dialog.sendToChat')}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
