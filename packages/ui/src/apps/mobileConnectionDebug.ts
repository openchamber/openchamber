
import React from 'react';

import { isCapacitorApp } from '@/lib/platform';
import { setRuntimeRequestObserver } from '@/lib/runtime-fetch';

type MobileConnectDebugEntry = {
  at: number;
  step: string;
  detail: string;
};

const MAX_ENTRIES = 300;
const LEGACY_STORAGE_KEY = 'openchamber.mobile.connectLog.v1';

const entries: MobileConnectDebugEntry[] = [];

if (typeof window !== 'undefined') {
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage unavailable — the in-memory trail still works.
  }
}

export const recordMobileConnectDebug = (step: string, detail: string): void => {
  entries.push({ at: Date.now(), step, detail });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
};

if (typeof window !== 'undefined') {
  recordMobileConnectDebug('app:launch', JSON.stringify({ sinceNavigationMs: Math.round(performance.now()) }));
}

const LAUNCH_REQUEST_WINDOW_MS = 30_000;
const LAUNCH_REQUEST_LIMIT = 150;

if (typeof window !== 'undefined' && isCapacitorApp()) {
  let recorded = 0;
  setRuntimeRequestObserver(({ method, url, status, durationMs }) => {
    if (recorded >= LAUNCH_REQUEST_LIMIT) return;
    recorded += 1;
    let path = url;
    try {
      path = new URL(url, window.location.origin).pathname;
    } catch {
      path = url.split('?')[0] ?? url;
    }
    recordMobileConnectDebug('request', JSON.stringify({ method, path, status, ms: Math.round(durationMs) }));
  });
  window.setTimeout(() => setRuntimeRequestObserver(null), LAUNCH_REQUEST_WINDOW_MS);
}

export const getMobileConnectDebugEntries = (): MobileConnectDebugEntry[] => [...entries];

const formatTime = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

export const formatMobileConnectDebugEntry = (entry: MobileConnectDebugEntry): string =>
  `${formatTime(entry.at)} ${entry.step}${entry.detail && entry.detail !== '{}' ? ` ${entry.detail}` : ''}`;

export const getMobileConnectDebugText = (): string =>
  entries.map(formatMobileConnectDebugEntry).join('\n');

export const useDebugPanelLongPress = (onLongPress: () => void, delayMs = 700) => {
  const timerRef = React.useRef<number | null>(null);
  const originRef = React.useRef<{ x: number; y: number } | null>(null);
  const firedRef = React.useRef(false);

  const clear = React.useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    originRef.current = null;
  }, []);

  React.useEffect(() => clear, [clear]);

  const onPointerDown = React.useCallback((event: React.PointerEvent) => {
    firedRef.current = false;
    originRef.current = { x: event.clientX, y: event.clientY };
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      onLongPress();
    }, delayMs);
  }, [delayMs, onLongPress]);

  const onPointerMove = React.useCallback((event: React.PointerEvent) => {
    const origin = originRef.current;
    if (!origin) return;
    if (Math.abs(event.clientX - origin.x) > 10 || Math.abs(event.clientY - origin.y) > 10) clear();
  }, [clear]);

  const onClickCapture = React.useCallback((event: React.MouseEvent) => {
    if (!firedRef.current) return;
    firedRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
    onClickCapture,
  };
};
