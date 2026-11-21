import React from 'react';
import { GUEST_BLOCK_HEIGHT_DEFAULT, GUEST_BLOCK_HEIGHT_MAX, type GuestBlockCall } from '@openchamber/sdk';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useI18n } from '@/lib/i18n';
import { pluginModeFromId } from '@/lib/surfaces/modes';

import type { ExtensionBlock } from './catalog';

const PluginPane = React.lazy(() => import('@/components/layout/PluginPane').then((module) => ({ default: module.PluginPane })));

const MIN_HEIGHT = 24;
const REMEMBERED_MAX = 500;

const rememberedHeights = new Map<string, number>();

const remember = (key: string, height: number) => {
  rememberedHeights.delete(key);
  rememberedHeights.set(key, height);
  if (rememberedHeights.size > REMEMBERED_MAX) rememberedHeights.delete(rememberedHeights.keys().next().value ?? '');
};

const clampHeight = (height: number) => Math.min(GUEST_BLOCK_HEIGHT_MAX, Math.max(MIN_HEIGHT, Math.round(height)));

function BlockUnavailable() {
  const { t } = useI18n();
  return <div className="px-3 py-2 typography-meta text-muted-foreground">{t('contextPanel.plugin.blockLoadFailed')}</div>;
}

export function ExtensionBlockFrame({ block, args, complete, answered, answer }: {
  block: ExtensionBlock;
  args: Record<string, string>;
  complete: boolean;
  answered: string | null;
  answer: (name: string, text: string) => Promise<void>;
}) {
  const call = React.useMemo<GuestBlockCall>(() => ({ name: block.name, args, answered }), [answered, args, block.name]);
  const heightKey = React.useMemo(() => JSON.stringify([block.guestId, block.name, args]), [args, block.guestId, block.name]);
  const [height, setHeight] = React.useState(() => rememberedHeights.get(heightKey) ?? clampHeight(block.height ?? GUEST_BLOCK_HEIGHT_DEFAULT));
  const [onScreen, setOnScreen] = React.useState(false);
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const box = boxRef.current;
    if (!box || onScreen) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setOnScreen(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setOnScreen(true);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [onScreen]);

  const handleResize = React.useCallback((next: number) => {
    const clamped = clampHeight(next);
    remember(heightKey, clamped);
    setHeight((current) => (current === clamped ? current : clamped));
  }, [heightKey]);

  const pane = React.useMemo(() => ({
    call,
    entry: block.entry,
    answer: (text: string) => answer(block.name, text),
  }), [answer, block.entry, block.name, call]);

  return (
    <div ref={boxRef} className="oc-box w-full overflow-hidden" style={{ height, padding: 0 }}>
      {complete && onScreen ? (
        <ErrorBoundary fallback={<BlockUnavailable />}>
          <React.Suspense fallback={null}>
            <PluginPane mode={pluginModeFromId(block.guestId)} surface="block" block={pane} onResize={handleResize} />
          </React.Suspense>
        </ErrorBoundary>
      ) : null}
    </div>
  );
}
