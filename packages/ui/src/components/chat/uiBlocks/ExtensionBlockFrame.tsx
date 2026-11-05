import React from 'react';
import { GUEST_BLOCK_HEIGHT_DEFAULT, GUEST_BLOCK_HEIGHT_MAX, type GuestBlockCall } from '@openchamber/sdk';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { pluginModeFromId } from '@/lib/surfaces/modes';

import type { ExtensionBlock } from './catalog';

// Loaded with the first extension block; most chats never need it.
const PluginPane = React.lazy(() => import('@/components/layout/PluginPane').then((module) => ({ default: module.PluginPane })));

const MIN_HEIGHT = 24;
const REMEMBERED_MAX = 500;

/**
 * What each call last measured, for this app session. A virtualized row drops
 * its frame when it scrolls away; coming back at the height it had keeps the
 * chat from jumping while the frame loads again.
 */
const rememberedHeights = new Map<string, number>();

const remember = (key: string, height: number) => {
  rememberedHeights.delete(key);
  rememberedHeights.set(key, height);
  if (rememberedHeights.size > REMEMBERED_MAX) rememberedHeights.delete(rememberedHeights.keys().next().value ?? '');
};

const clampHeight = (height: number) => Math.min(GUEST_BLOCK_HEIGHT_MAX, Math.max(MIN_HEIGHT, Math.round(height)));

/**
 * One call to an extension's block: the extension's own sandboxed page, with
 * the grants of its panel. It mounts once the block is finished and on screen.
 */
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
    // Inline: the kit's `.oc-box` padding lands after the utilities, and would take the height the frame asked for.
    <div ref={boxRef} className="oc-box w-full overflow-hidden" style={{ height, padding: 0 }}>
      {complete && onScreen ? (
        <ErrorBoundary fallback={null}>
          <React.Suspense fallback={null}>
            <PluginPane mode={pluginModeFromId(block.guestId)} surface="block" block={pane} onResize={handleResize} />
          </React.Suspense>
        </ErrorBoundary>
      ) : null}
    </div>
  );
}
