import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useClockBeat } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { isCapacitorApp } from '@/lib/platform';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';

import { HEARTBEAT_COLUMNS, HEARTBEAT_ROWS, buildHeartbeatTrace, type HeartbeatPing } from './connectionHeartbeatTrace';

// A ping every 16 beats leaves three to four heartbeats across the trace.
const PING_INTERVAL_MS = 4_000;
const PING_TIMEOUT_MS = 5_000;
const KEPT_PINGS = 5;
const PITCH = 10;
const DOT_RADIUS = 3;
// Unlit grid rows above and below the trace, where the grid fades out.
const MARGIN_ROWS = 3;
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
// Stands in for the number while the latency message is split around it.
const NUMBER_SLOT = '\u0000';

/**
 * Whether the app is in the foreground. On Capacitor the native app state decides:
 * the WebView's page visibility can stay "visible" while the app sits in the background.
 */
const useAppActive = (): boolean => {
  const [active, setActive] = React.useState(() => document.visibilityState === 'visible');

  React.useEffect(() => {
    if (isCapacitorApp()) {
      let disposed = false;
      let removeListener: (() => void) | null = null;
      void import('@capacitor/app')
        .then(async ({ App }) => {
          const handles = await Promise.all([
            App.addListener('appStateChange', ({ isActive }) => setActive(isActive === true)),
            // appStateChange can be missed after a long iOS suspend; resume still fires (see useNativeMobileLifecycle).
            App.addListener('resume', () => setActive(true)),
          ]);
          if (disposed) {
            handles.forEach((handle) => void handle.remove());
            return;
          }
          removeListener = () => handles.forEach((handle) => void handle.remove());
          const state = await App.getState().catch(() => null);
          if (!disposed && state) setActive(state.isActive === true);
        })
        .catch(() => undefined);
      return () => {
        disposed = true;
        removeListener?.();
      };
    }
    const onVisibilityChange = () => setActive(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  return active;
};

/** Asks `/health` every few seconds while the app is active; the round trip is the latency. */
const useServerPings = (beat: number, active: boolean): readonly HeartbeatPing[] => {
  const beatRef = React.useRef(beat);
  React.useEffect(() => {
    beatRef.current = beat;
  }, [beat]);
  const [pings, setPings] = React.useState<readonly HeartbeatPing[]>([]);

  React.useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: number | undefined;
    let request: AbortController | null = null;

    const ping = async () => {
      const startedAt = performance.now();
      let latencyMs: number | null = null;
      // A controller, since the iOS 15 WebView has no AbortSignal.timeout.
      const controller = new AbortController();
      request = controller;
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
      request = null;
      if (disposed) return;
      setPings((current) => [...current.slice(1 - KEPT_PINGS), { beat: beatRef.current, latencyMs }]);
      timer = window.setTimeout(ping, PING_INTERVAL_MS);
    };

    void ping();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      request?.abort();
      // The shared clock restarts its count once nothing listens, so stamps kept
      // from before would come back later as beats that never happened.
      setPings([]);
    };
  }, [active]);

  return pings;
};

/** Each digit rolls to its new value; columns are keyed from the right so the ones digit keeps its place. */
const RollingNumber: React.FC<{ value: number }> = ({ value }) => {
  const digits = String(value).split('');
  return (
    <span dir="ltr" className="inline-flex tabular-nums" aria-hidden>
      {digits.map((digit, index) => (
        // Paint containment clips the other nine digits out of paint and scroll height. Not overflow-hidden:
        // mobile.css turns that into a scroller with a scrollbar on touch devices. Not overflow-clip: missing before iOS 16.
        <span key={digits.length - index} className="inline-block h-[1.25em] leading-[1.25em] [contain:paint]">
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

/**
 * The live connection's heartbeat on Instances: a dot trace with a beat per answer
 * from the server, then `status` with the latency beside it. It pings only while
 * mounted and the app is in the foreground.
 */
export const MobileConnectionHeartbeat: React.FC<{ status: React.ReactNode }> = ({ status }) => {
  const { t } = useI18n();
  const active = useAppActive();
  const beat = useClockBeat(active);
  const pings = useServerPings(beat, active);
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
  const latencyMs = latest?.latencyMs ?? null;
  const [beforeNumber, afterNumber] = latencyMs === null
    ? ['', '']
    : t('mobile.instances.heartbeat.latency', { ms: NUMBER_SLOT }).split(NUMBER_SLOT);

  return (
    <>
      <div className="oc-tile-inset mt-3 overflow-clip rounded-lg">
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
      <div className="flex h-9 items-center gap-3 pt-3">
        <span className="min-w-0 flex-1">{status}</span>
        <span className={cn('flex shrink-0 items-center gap-1.5 typography-meta', latest !== null && latencyMs === null ? 'text-[var(--status-error-text)]' : 'text-muted-foreground')}>
          <Icon name="pulse" className="size-4" />
          {latest === null ? null : latencyMs === null ? t('mobile.instances.heartbeat.noAnswer') : (
            <>
              <span aria-hidden className="whitespace-pre">
                {beforeNumber}<span className="text-foreground"><RollingNumber value={latencyMs} /></span>{afterNumber}
              </span>
              <span className="sr-only">{t('mobile.instances.heartbeat.latencyAria', { ms: latencyMs })}</span>
            </>
          )}
        </span>
      </div>
    </>
  );
};
