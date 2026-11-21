import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useClockBeat } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { isCapacitorApp } from '@/lib/platform';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';

import { HEARTBEAT_COLUMNS, HEARTBEAT_ROWS, buildHeartbeatTrace, type HeartbeatPing } from './connectionHeartbeatTrace';

const PING_INTERVAL_MS = 4_000;
const PING_TIMEOUT_MS = 5_000;
const KEPT_PINGS = 5;
const PITCH = 10;
const DOT_RADIUS = 3;
const MARGIN_ROWS = 3;
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const NUMBER_SLOT = '\u0000';

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
      // external: https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static iOS 15 lacks AbortSignal.timeout, so the ping uses an AbortController.
      const controller = new AbortController();
      request = controller;
      const timeout = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
      try {
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
      setPings([]);
    };
  }, [active]);

  return pings;
};

const RollingNumber: React.FC<{ value: number }> = ({ value }) => {
  const digits = String(value).split('');
  return (
    <span dir="ltr" className="inline-flex tabular-nums" aria-hidden>
      {digits.map((digit, index) => (
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
            <linearGradient id={`${svgId}-fade-x`}>
              <stop offset="0" stopColor="white" stopOpacity={0} />
              <stop offset="0.25" stopColor="white" stopOpacity={1} />
              <stop offset="0.85" stopColor="white" stopOpacity={1} />
              <stop offset="1" stopColor="white" stopOpacity={0} />
            </linearGradient>
            <mask id={`${svgId}-mask-x`}>
              <rect width={width} height={height} fill={`url(#${svgId}-fade-x)`} />
            </mask>
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
