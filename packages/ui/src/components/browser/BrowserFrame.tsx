import React from 'react';
import { useDurationTickerNow, useWaitingBlink } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const FRAME_WAIT_MS = 15_000;

export const BrowserFrame: React.FC<{ src: string; title: string; waitMs?: number }> = ({ src, title, waitMs = FRAME_WAIT_MS }) => {
  const { t } = useI18n();
  const [mountedAt] = React.useState(Date.now);
  const [loaded, setLoaded] = React.useState(false);
  const [waitOver, setWaitOver] = React.useState(waitMs <= 0);
  const now = useDurationTickerNow(!loaded && !waitOver);
  if (!waitOver && now - mountedAt >= waitMs) setWaitOver(true);
  const blink = useWaitingBlink(!loaded && !waitOver);

  return (
    <>
      <iframe
        src={src}
        title={title}
        className="h-full w-full border-none bg-white"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        onLoad={() => setLoaded(true)}
      />
      {loaded ? null : (
        <div
          role="progressbar"
          aria-label={t('common.loading')}
          data-state={waitOver ? 'waiting' : 'loading'}
          className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden"
        >
          <div className={cn('h-full w-1/3 bg-[var(--primary)]', waitOver ? 'opacity-40' : blink)} />
        </div>
      )}
    </>
  );
};
