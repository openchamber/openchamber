import type { GuestRequest, GuestStatusActionEvent, GuestStatusView } from '@openchamber/sdk';
import { guestStatusViewSchema } from '@openchamber/sdk/schemas';
import { z } from 'zod';

import { proxyGuestServiceRequest } from './service';

/**
 * Why a source section shows no fresh view: the service did not answer with a
 * success (`unreachable`), or answered with something that is not a view the
 * host can draw (`invalid`).
 */
export type GuestStatusViewFailure = 'unreachable' | 'invalid';

export type GuestStatusViewRead =
  | { ok: true; view: GuestStatusView }
  | { ok: false; failure: GuestStatusViewFailure };

type GuestStatusActionResult =
  | { ok: true }
  /** `message` is the service's own explanation when it gave one. */
  | { ok: false; message: string | null };

const actionFailureSchema = z.object({ message: z.string().trim().min(1).max(300) });

/** What the service is told about where the section shows. */
type GuestStatusContext = {
  /** The project the Work Status panel shows; absent without one. */
  directory: string | null;
  /** The app's language, so the service can format numbers and words for it. */
  locale: string;
};

const sourceRequest = (path: string, { directory, locale }: GuestStatusContext, extra: Pick<GuestRequest, 'method' | 'body'>): GuestRequest => ({
  ...extra,
  path,
  query: directory ? { directory, locale } : { locale },
});

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

const parseView = (body: string): GuestStatusView | null => {
  try {
    const parsed = guestStatusViewSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Tells the service a control was activated. */
export const postGuestStatusAction = async (
  guestId: string,
  path: string,
  context: GuestStatusContext,
  event: GuestStatusActionEvent,
): Promise<GuestStatusActionResult> => {
  const answer = await proxyGuestServiceRequest(guestId, sourceRequest(path, context, {
    method: 'POST',
    body: JSON.stringify(event),
  }));
  if (!answer.ok) return { ok: false, message: null };
  if (isSuccess(answer.result.status)) return { ok: true };
  try {
    const parsed = actionFailureSchema.safeParse(JSON.parse(answer.result.body));
    return { ok: false, message: parsed.success ? parsed.data.message : null };
  } catch {
    return { ok: false, message: null };
  }
};

/**
 * Reads a source section, keeping what did not change. An answer identical to
 * the last one returns the last view itself, unparsed; otherwise each row and
 * the header controls keep their previous objects while unchanged. Rows are
 * memoized by identity, so a sample that moves one number redraws one row and
 * leaves the header alone.
 */
export const createGuestStatusViewReader = (
  guestId: string,
  path: string,
  context: GuestStatusContext,
  read: typeof proxyGuestServiceRequest = proxyGuestServiceRequest,
): (() => Promise<GuestStatusViewRead>) => {
  let lastBody: string | null = null;
  let lastView: GuestStatusView | null = null;
  let lastRows = new Map<string, { json: string; row: GuestStatusView['rows'][number] }>();
  let lastControlsJson = 'null';
  return async () => {
    const answer = await read(guestId, sourceRequest(path, context, { method: 'GET' }));
    if (!answer.ok || !isSuccess(answer.result.status)) return { ok: false, failure: 'unreachable' };
    if (lastView && answer.result.body === lastBody) return { ok: true, view: lastView };
    const parsed = parseView(answer.result.body);
    if (!parsed) return { ok: false, failure: 'invalid' };
    const rows = new Map<string, { json: string; row: GuestStatusView['rows'][number] }>();
    const controlsJson = JSON.stringify(parsed.controls ?? null);
    const controls = lastView && controlsJson === lastControlsJson ? lastView.controls : parsed.controls;
    const view: GuestStatusView = {
      rows: parsed.rows.map((row) => {
        const json = JSON.stringify(row);
        const previous = lastRows.get(row.id);
        const kept = previous && previous.json === json ? previous.row : row;
        rows.set(row.id, { json, row: kept });
        return kept;
      }),
      controls,
    };
    lastBody = answer.result.body;
    lastControlsJson = controlsJson;
    lastView = view;
    lastRows = rows;
    return { ok: true, view };
  };
};

/** Whether anyone can see the app, and a way to hear when they can again. */
export type StatusViewVisibility = {
  isHidden: () => boolean;
  onVisible: (listener: () => void) => () => void;
};

const documentVisibility = (): StatusViewVisibility => ({
  isHidden: () => document.visibilityState === 'hidden',
  onVisible: (listener) => {
    const handle = () => {
      if (document.visibilityState !== 'hidden') listener();
    };
    document.addEventListener('visibilitychange', handle);
    return () => document.removeEventListener('visibilitychange', handle);
  },
});

export type StatusViewPoller = {
  /**
   * Read now, as after an action; a read in flight is followed by one more.
   * Resolves once a read that started after the call has been delivered, so
   * the caller knows the view it shows reflects what happened before.
   */
  refresh: () => Promise<void>;
  stop: () => void;
};

type StatusViewPolling = {
  read: () => Promise<GuestStatusViewRead>;
  interval: number;
  onRead: (result: GuestStatusViewRead) => void;
  visibility?: StatusViewVisibility;
  schedule?: (callback: () => void, delay: number) => number;
  cancel?: (id: number) => void;
};

/**
 * Reads a source section now and then every `interval` after the previous
 * read finished, so a slow service is never asked twice at once. Nothing is
 * read while the document is hidden; the next read happens when it shows.
 * Results that arrive after `stop` are dropped.
 */
export const startStatusViewPolling = ({
  read,
  interval,
  onRead,
  visibility = documentVisibility(),
  schedule = (callback, delay) => window.setTimeout(callback, delay),
  cancel = (id) => window.clearTimeout(id),
}: StatusViewPolling): StatusViewPoller => {
  let stopped = false;
  let running = false;
  let again = false;
  let timer: number | null = null;
  // Reads are numbered as they start; a waiter wants one numbered at least `from`.
  let started = 0;
  let waiters: Array<{ from: number; resolve: () => void }> = [];

  const release = (delivered: number): void => {
    const ready = waiters.filter((waiter) => waiter.from <= delivered);
    waiters = waiters.filter((waiter) => waiter.from > delivered);
    for (const waiter of ready) waiter.resolve();
  };

  const tick = async (): Promise<void> => {
    timer = null;
    if (stopped || visibility.isHidden()) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    started += 1;
    const number = started;
    const result = await read();
    running = false;
    if (stopped) return;
    onRead(result);
    release(number);
    if (again) {
      again = false;
      void tick();
      return;
    }
    timer = schedule(() => { void tick(); }, interval);
  };

  const unsubscribe = visibility.onVisible(() => {
    if (!running && timer === null) void tick();
  });
  void tick();

  return {
    refresh: () => {
      if (stopped) return Promise.resolve();
      const fresh = new Promise<void>((resolve) => { waiters.push({ from: started + 1, resolve }); });
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      void tick();
      return fresh;
    },
    stop: () => {
      stopped = true;
      if (timer !== null) cancel(timer);
      unsubscribe();
      release(Number.POSITIVE_INFINITY);
    },
  };
};
