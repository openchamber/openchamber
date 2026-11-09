import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useClockBeat } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';

import { HEARTBEAT_COLUMNS, HEARTBEAT_ROWS, buildHeartbeatTrace, type HeartbeatPing } from './connectionHeartbeatTrace';
import { getActiveConnectionLabel } from './mobileConnections';

// A ping every 16 beats leaves three to four heartbeats across the trace.
const PING_INTERVAL_MS = 4_000;
const PING_TIMEOUT_MS = 5_000;
const KEPT_PINGS = 5;
const PITCH = 10;
const DOT_RADIUS = 3;
// Unlit grid rows above and below the trace, where the grid fades out.
const MARGIN_ROWS = 3;
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Asks `/health` every few seconds while the page is visible; the round trip is the latency. */
const useServerPings = (beat: number): readonly HeartbeatPing[] => {
  const beatRef = React.useRef(beat);
  React.useEffect(() => {
    beatRef.current = beat;
  }, [beat]);
  const [pings, setPings] = React.useState<readonly HeartbeatPing[]>([]);

  React.useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: number | undefined;

    const ping = async () => {
      timer = undefined;
      inFlight = true;
      const startedAt = performance.now();
      let latencyMs: number | null = null;
      // A controller, since the iOS 15 WebView has no AbortSignal.timeout.
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
      try {
        // The signal also keeps runtimeFetch from sharing an answer with another caller.
        const response = await runtimeFetch('/health', { cache: 'no-store', signal: controller.signal });
        if (response.ok) latencyMs = Math.round(performance.now() - startedAt);
        void response.body?.cancel().catch(() => undefined);
      } catch {
        // A timeout or a dropped connection is a ping nobody answered.
      }
      window.clearTimeout(timeout);
      inFlight = false;
      if (disposed) return;
      setPings((current) => [...current.slice(1 - KEPT_PINGS), { beat: beatRef.current, latencyMs }]);
      if (document.visibilityState === 'visible') timer = window.setTimeout(ping, PING_INTERVAL_MS);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !inFlight && timer === undefined) void ping();
    };

    void ping();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return pings;
};

/** Each digit rolls to its new value; columns are keyed from the right so the ones digit keeps its place. */
const RollingNumber: React.FC<{ value: number }> = ({ value }) => {
  const digits = String(value).split('');
  return (
    <span dir="ltr" className="inline-flex tabular-nums" aria-hidden>
      {digits.map((digit, index) => (
        <span key={digits.length - index} className="inline-block h-[1.25em] overflow-hidden leading-[1.25em]">
          <span
            className="flex flex-col transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            style={{ transform: `translateY(-${Number(digit) * 10}%)` }}
          >
            {DIGITS.map((option) => <span key={option}>{option}</span>)}
          </span>
        </span>
      ))}
    </span>
  );
};

export const MobileConnectionHeartbeat: React.FC = () => {
  const { t } = useI18n();
  const beat = useClockBeat(true);
  const pings = useServerPings(beat);
  const [label] = React.useState(getActiveConnectionLabel);
  const svgId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const latest = pings.at(-1) ?? null;
  const traceColor = latest === null
    ? 'var(--muted-foreground)'
    : latest.latencyMs === null ? 'var(--status-error)' : 'var(--status-success)';
  const trace = buildHeartbeatTrace(beat, pings);
  // Each column lights one unbroken run of rows, so the dots just above and below it are its halo.
  const lit = new Set(trace.map(({ column, row }) => `${column}:${row}`));
  const halo = trace.flatMap(({ column, row }) => [row - 1, row + 1]
    .filter((haloRow) => haloRow >= 0 && haloRow < HEARTBEAT_ROWS && !lit.has(`${column}:${haloRow}`))
    .map((haloRow) => ({ column, row: haloRow })));
  const toCircle = ({ column, row }: { column: number; row: number }) => (
    <circle key={`${column}:${row}`} cx={column * PITCH + PITCH / 2} cy={row * PITCH + PITCH / 2} r={DOT_RADIUS} />
  );
  const width = HEARTBEAT_COLUMNS * PITCH;
  const height = (HEARTBEAT_ROWS + MARGIN_ROWS * 2) * PITCH;

  return (
    <section className="oc-tile rounded-[18px] p-1.5">
      <div className="oc-tile-inset overflow-hidden rounded-[13px]">
        <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full" aria-hidden>
          <defs>
            <pattern id={`${svgId}-grid`} width={PITCH} height={PITCH} patternUnits="userSpaceOnUse">
              <circle cx={PITCH / 2} cy={PITCH / 2} r={DOT_RADIUS} fill="var(--foreground)" opacity={0.09} />
            </pattern>
            {/* Grid and beats fade at the side edges, so a beat fades in at the right and out at the left. */}
            <linearGradient id={`${svgId}-fade-x`}>
              <stop offset="0" stopColor="white" stopOpacity={0} />
              <stop offset="0.25" stopColor="white" stopOpacity={1} />
              <stop offset="0.85" stopColor="white" stopOpacity={1} />
              <stop offset="1" stopColor="white" stopOpacity={0} />
            </linearGradient>
            <mask id={`${svgId}-mask-x`}>
              <rect width={width} height={height} fill={`url(#${svgId}-fade-x)`} />
            </mask>
            {/* The grid also fades into the margin rows above and below the trace. */}
            <linearGradient id={`${svgId}-fade-y`} x2="0" y2="1">
              <stop offset="0" stopColor="white" stopOpacity={0} />
              <stop offset="0.3" stopColor="white" stopOpacity={1} />
              <stop offset="0.7" stopColor="white" stopOpacity={1} />
              <stop offset="1" stopColor="white" stopOpacity={0} />
            </linearGradient>
            <mask id={`${svgId}-mask-y`}>
              <rect width={width} height={height} fill={`url(#${svgId}-fade-y)`} />
            </mask>
          </defs>
          <g mask={`url(#${svgId}-mask-x)`}>
            <rect width={width} height={height} fill={`url(#${svgId}-grid)`} mask={`url(#${svgId}-mask-y)`} />
            <g transform={`translate(0 ${MARGIN_ROWS * PITCH})`} fill={traceColor} className="transition-[fill] duration-300">
              <g opacity={0.28}>{halo.map(toCircle)}</g>
              {trace.map(toCircle)}
            </g>
          </g>
        </svg>
      </div>
      <div className="flex items-center gap-3 px-3 pb-1.5 pt-2.5">
        <span className="min-w-0 flex-1 truncate typography-ui-label font-semibold text-foreground">{label}</span>
        <span className={cn('flex shrink-0 items-center gap-1.5 typography-ui-label', latest?.latencyMs === null ? 'text-[var(--status-error)]' : 'text-muted-foreground')}>
          <Icon name="pulse" className="size-4" />
          {latest === null ? null : latest.latencyMs === null ? t('settings.connectionHeartbeat.noAnswer') : (
            <>
              <span className="text-foreground"><RollingNumber value={latest.latencyMs} /></span>
              <span aria-hidden>ms</span>
              <span className="sr-only">{t('settings.connectionHeartbeat.latencyAria', { ms: latest.latencyMs })}</span>
            </>
          )}
        </span>
      </div>
    </section>
  );
};
