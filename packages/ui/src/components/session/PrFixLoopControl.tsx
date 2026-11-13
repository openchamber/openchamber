import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { useRepositoryReadContext } from '@/components/references/referenceSources';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isFixLoopActive, isFixLoopForPull, type FixLoopPull } from '@/lib/prFixLoop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { supportsGitHubAutomation } from '@/lib/source-control/githubAutomation';
import { prFixLoopStore, usePrFixLoopProjection, usePrFixLoopStore } from '@/stores/usePrFixLoopStore';
import { PrFixLoopDialog } from './PrFixLoopDialog';

type Props = {
  pull: FixLoopPull;
  sessionId: string | null;
  context: SourceControlReadContext | null;
  compact?: boolean;
};

/** Board previews and linked PR rows share the same session + PR activation. */
export function PrFixLoopControl({ pull, sessionId, context, compact = false }: Props) {
  const { runtime } = useRuntimeAPIs();
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const loop = usePrFixLoopStore((state) => state.runtimeKey === getRuntimeKey()
    ? state.loops.find((loop) => isFixLoopForPull(loop, pull, sessionId) && isFixLoopActive(loop)) : undefined);
  const loadState = usePrFixLoopStore((state) => state.loadState);
  usePrFixLoopProjection(!runtime.isVSCode);
  if (runtime.isVSCode) return null;

  const reason = !sessionId ? t('prFixLoop.disabled.session')
    : !supportsGitHubAutomation(context) ? t('prFixLoop.disabled.context')
      : loadState === 'error' ? t('prFixLoop.error.load')
        : loadState !== 'ready' ? t('prFixLoop.loading') : null;
  const label = t(loop ? 'prFixLoop.action.stop' : 'prFixLoop.action.start');
  const stop = async () => {
    if (!loop || busy) return;
    setBusy(true);
    try { await prFixLoopStore.getState().stop(loop.id); }
    catch (error) { toast.error(t('prFixLoop.error.action'), { description: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };
  const action = () => { if (loop) void stop(); else setOpen(true); };
  return <>
    {compact ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={t('prFixLoop.action.menu')}>
            <Icon name="more-2" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={busy || (!loop && Boolean(reason))} onSelect={action}>
            <span className="flex flex-col gap-1">
              <span>{label}</span>
              {!loop && reason ? <span className="typography-micro text-muted-foreground">{reason}</span> : null}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={action} disabled={busy || (!loop && Boolean(reason))} title={!loop ? reason ?? undefined : undefined}>
          <Icon name={loop ? 'stop' : 'play'} className="size-3.5" />{label}
        </Button>
        {!loop && reason ? <span className="typography-micro text-muted-foreground">{reason}</span> : null}
      </span>
    )}
    {open && context && sessionId ? <PrFixLoopDialog target={{ kind: 'create', context, sessionId, pull }} onClose={() => setOpen(false)} /> : null}
  </>;
}

/** Linked rows read the session directory's existing bound account context. */
export function LinkedPrFixLoopControl({ directory, ...props }: Omit<Props, 'context'> & { directory: string | null }) {
  const { runtime } = useRuntimeAPIs();
  const context = useRepositoryReadContext(runtime.isVSCode ? null : directory);
  if (runtime.isVSCode) return null;
  return <PrFixLoopControl {...props} context={context && context !== 'missing' ? context : null} compact />;
}
