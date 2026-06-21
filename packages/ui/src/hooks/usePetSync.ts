import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { getSyncChildStores, getAllSyncSessions, getSyncMessages, getSyncParts } from '@/sync/sync-refs';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useNotificationStore } from '@/sync/notification-store';
import { respondToPermission } from '@/sync/session-actions';
import {
  useGlobalSessionsStore,
  ensureGlobalSessionsLoaded,
  resolveGlobalSessionDirectory,
} from '@/stores/useGlobalSessionsStore';
import { useDesktopPetStore } from '@/stores/useDesktopPetStore';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { toast } from '@/components/ui';
import {
  PET_ACTION_CHANNEL,
  PET_STATE_CHANNEL,
  resolvePetState,
  type PetActionMessage,
  type PetApproval,
  type PetStateMessage,
  type PetThread,
} from '@/lib/pet/petContract';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';

// Producer for the floating desktop pet. This is the counterpart to the pet
// window (a "dumb" renderer in ElectronPetApp.tsx): the MAIN renderer owns the
// live sync connection, derives the aggregate pet state, and broadcasts it over
// BroadcastChannel. It also relays pet-originated actions (answering a
// permission, focusing a session) back into the app.
//
// It deliberately mirrors useTraySync's aggregation rather than refactoring it:
// the tray is a shipped, subtle feature and the two outputs differ (the tray
// shows a full session list + usage; the pet shows ONE dominant thread + a
// caption). Both read the SAME authoritative stores, so the source of truth is
// shared even though the presentation glue is not.
//
// Like useTraySync, this runs OUTSIDE SyncProvider (mounted next to it in the
// App body), so it must use the imperative sync accessors, never React hooks.

type LiveStatus = 'idle' | 'busy' | 'retry';

// We don't stream the caption token-by-token; broadcasts are throttled so the
// bubble text settles ~1/sec while state transitions still feel prompt.
const BROADCAST_THROTTLE_MS = 700;
// Safety net for anything the store subscriptions miss (e.g. a store created
// before the registry subscription attached). Cheap: one rebuild per tick.
const SAFETY_POLL_MS = 5000;
const CAPTION_MAX_LEN = 140;

type DesktopBridgeGlobal = {
  listen?: (
    event: string,
    handler: (evt: { payload?: unknown }) => void,
  ) => Promise<() => void>;
};

const updatedAt = (session: Session): number =>
  session.time?.updated ?? session.time?.created ?? 0;

// Label helpers mirror useTraySync's so the pet's approval text matches the
// tray's exactly. Kept local (3 lines each) rather than exporting from the tray.
const permissionLabel = (request: PermissionRequest): string => {
  const head = typeof request.permission === 'string' ? request.permission : 'Permission';
  const pattern = Array.isArray(request.patterns)
    ? request.patterns.find((p) => typeof p === 'string' && p.trim())
    : '';
  return pattern ? `${head}: ${pattern}` : head;
};

const questionLabel = (request: QuestionRequest): string => {
  const first = Array.isArray(request.questions) ? request.questions[0] : undefined;
  return first?.header || first?.question || 'Question';
};

const truncateCaption = (text: string): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= CAPTION_MAX_LEN) return collapsed;
  return `${collapsed.slice(0, CAPTION_MAX_LEN).trimEnd()}…`;
};

// Latest assistant text for the running thread — a SNAPSHOT of what's already
// been produced, not a token stream. Empty when the current turn hasn't emitted
// text yet (tool-only), or when the session's directory isn't synced (its
// messages aren't loaded). The contract allows an empty caption.
const latestAssistantCaption = (sessionId: string, directory: string): string => {
  const messages = getSyncMessages(sessionId, directory || undefined);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    return truncateCaption(flattenAssistantTextParts(getSyncParts(message.id, directory || undefined)));
  }
  return '';
};

const safeChildStores = () => {
  try {
    return getSyncChildStores();
  } catch {
    // SyncProvider not mounted yet — global stores still drive a coarse state.
    return null;
  }
};

type RootRow = {
  session: Session;
  directory: string;
  status: LiveStatus;
  unseen: number;
  hasError: boolean;
};

// Aggregate live signals into the single broadcast message. Reads the same
// stores as the tray: child stores (live status + approvals), the cross-project
// status fallback, the global session list, and the notification index.
const buildPetMessage = (): PetStateMessage => {
  const liveStatusById = new Map<string, LiveStatus>();
  const approvals: PetApproval[] = [];

  const childStores = safeChildStores();
  if (childStores) {
    for (const [, store] of childStores.children) {
      const state = store.getState();

      // Status comes from the status map, not the session list: a just-created
      // session can have a status entry before it appears in any list, and the
      // same session may be listed by several stores. Never let an idle/missing
      // entry clobber a busy/retry one. (Same rule as useTraySync.)
      for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
        const type = status?.type;
        const mapped: LiveStatus = type === 'busy' ? 'busy' : type === 'retry' ? 'retry' : 'idle';
        const existing = liveStatusById.get(sessionId);
        if (!existing || existing === 'idle') liveStatusById.set(sessionId, mapped);
      }

      for (const [sessionId, requests] of Object.entries(state.permission ?? {})) {
        for (const request of requests ?? []) {
          if (!request?.id) continue;
          approvals.push({
            kind: 'permission',
            id: request.id,
            sessionId: request.sessionID || sessionId,
            sessionTitle: '',
            label: permissionLabel(request),
          });
        }
      }
      for (const [sessionId, requests] of Object.entries(state.question ?? {})) {
        for (const request of requests ?? []) {
          if (!request?.id) continue;
          approvals.push({
            kind: 'question',
            id: request.id,
            sessionId: request.sessionID || sessionId,
            sessionTitle: '',
            label: questionLabel(request),
          });
        }
      }
    }
  }

  // Surface answerable permissions before questions: the bubble renders only the
  // first approval, and a permission can be answered inline (Allow/Deny) while a
  // question only deep-links into the app. Stable sort preserves same-kind order.
  approvals.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'permission' ? -1 : 1));

  // Cross-project fallback: fed live on all platforms by the sync dispatcher, so
  // sessions in directories without a child store still report busy/retry.
  const globalStatusById = useGlobalSessionStatusStore.getState().statusById;
  const resolveStatus = (id: string): LiveStatus => {
    const fromStores = liveStatusById.get(id);
    if (fromStores && fromStores !== 'idle') return fromStores;
    return globalStatusById.get(id)?.status ?? fromStores ?? 'idle';
  };

  const allSessions = useGlobalSessionsStore.getState().activeSessions;
  const titleById = new Map<string, string>();
  const childrenByParent = new Map<string, string[]>();
  for (const session of allSessions) {
    if (!session?.id) continue;
    if (session.title) titleById.set(session.id, session.title);
    if (session.parentID) {
      const siblings = childrenByParent.get(session.parentID) ?? [];
      siblings.push(session.id);
      childrenByParent.set(session.parentID, siblings);
    }
  }

  const collectDescendants = (rootId: string): string[] => {
    const out: string[] = [];
    const stack = [...(childrenByParent.get(rootId) ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      stack.push(...(childrenByParent.get(id) ?? []));
    }
    return out;
  };

  const rollupStatus = (family: string[]): LiveStatus => {
    const statuses = family.map((id) => resolveStatus(id));
    if (statuses.includes('busy')) return 'busy';
    if (statuses.includes('retry')) return 'retry';
    return 'idle';
  };

  const notif = useNotificationStore.getState().index.session;

  // Root rows only (sub-session work rolls up into its parent), most recently
  // updated first — so "the running thread" is the one the user touched last.
  const rows: RootRow[] = allSessions
    .filter((session) => session?.id && !session.parentID)
    .slice()
    .sort((a, b) => updatedAt(b) - updatedAt(a))
    .map((session) => {
      const family = [session.id, ...collectDescendants(session.id)];
      return {
        session,
        directory: resolveGlobalSessionDirectory(session) ?? '',
        status: rollupStatus(family),
        unseen: family.reduce((sum, id) => sum + (notif.unseenCount[id] ?? 0), 0),
        hasError: family.some((id) => notif.unseenHasError[id] ?? false),
      };
    });

  const runningCount = rows.filter((row) => row.status !== 'idle').length;
  const reviewCount = rows.filter((row) => row.status === 'idle' && row.unseen > 0).length;
  const failedCount = rows.filter((row) => row.hasError).length;
  const state = resolvePetState({
    hasFailed: failedCount > 0,
    approvalCount: approvals.length,
    hasReview: reviewCount > 0,
    runningCount,
  });

  // Count for the dominant state, surfaced on the minimized badge. Derived from
  // the same signals resolvePetState used, so the badge can never show a number
  // that contradicts the resolved state.
  const count =
    state === 'failed'
      ? failedCount
      : state === 'waiting'
        ? approvals.length
        : state === 'review'
          ? reviewCount
          : state === 'running'
            ? runningCount
            : 0;

  const titleFor = (sessionId: string): string => titleById.get(sessionId) || '';

  // The dominant thread depends on the resolved state, so the bubble names the
  // session that actually warrants attention. Only `running` carries a caption.
  let thread: PetThread | null = null;
  if (state === 'failed') {
    const row = rows.find((candidate) => candidate.hasError);
    if (row) thread = { sessionId: row.session.id, title: row.session.title || '', caption: '' };
  } else if (state === 'waiting') {
    const sessionId = approvals[0]?.sessionId ?? '';
    if (sessionId) thread = { sessionId, title: titleFor(sessionId), caption: '' };
  } else if (state === 'review') {
    const row = rows.find((candidate) => candidate.status === 'idle' && candidate.unseen > 0);
    if (row) thread = { sessionId: row.session.id, title: row.session.title || '', caption: '' };
  } else if (state === 'running') {
    const row = rows.find((candidate) => candidate.status !== 'idle');
    if (row) {
      thread = {
        sessionId: row.session.id,
        title: row.session.title || '',
        caption: latestAssistantCaption(row.session.id, row.directory),
      };
    }
  }

  // The bubble renders only the first approval, so surface just that one to keep
  // the payload minimal. `count` (above) still reflects the true pending total.
  const approvalsOut = approvals
    .slice(0, 1)
    .map((approval) => ({ ...approval, sessionTitle: titleFor(approval.sessionId) }));

  return { type: 'pet-state', state, thread, approvals: approvalsOut, count };
};

export const usePetSync = (): void => {
  const enabled = useDesktopPetStore((store) => store.enabled);

  // Always-on: learn the persisted pet state and keep it in sync with the main
  // process (native menu toggle, restore-on-launch). This runs even when the pet
  // is off so enabling it from anywhere activates the producer below.
  React.useEffect(() => {
    if (!canUseElectronDesktopIPC() || typeof window === 'undefined') return;
    void useDesktopPetStore.getState().hydrate();

    const bridge = (window as unknown as { __OPENCHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__OPENCHAMBER_DESKTOP__;
    const listen = bridge?.listen;
    if (typeof listen !== 'function') return;

    let unlisten: null | (() => void | Promise<void>) = null;
    listen('openchamber:pet-window-state', (evt) => {
      const payload = evt?.payload;
      if (payload && typeof payload === 'object') {
        useDesktopPetStore.getState().apply(payload as { enabled?: boolean; selectedSlug?: string });
      }
    })
      .then((fn) => { unlisten = fn; })
      .catch(() => { /* ignore */ });

    return () => {
      try {
        const result = unlisten?.();
        if (result instanceof Promise) void result.catch(() => {});
      } catch {
        // ignore
      }
    };
  }, []);

  // The producer. Gated on `enabled`: when off, nothing subscribes and no
  // broadcast channel is opened (perf rule: don't subscribe to live session
  // state unless the feature is actually on).
  React.useEffect(() => {
    if (!enabled || !canUseElectronDesktopIPC() || typeof BroadcastChannel === 'undefined') return;

    let disposed = false;
    let lastSerialized = '';
    let lastBroadcast = 0;
    let trailingTimer: number | null = null;

    const stateChannel = new BroadcastChannel(PET_STATE_CHANNEL);
    const actionChannel = new BroadcastChannel(PET_ACTION_CHANNEL);

    const flushNow = () => {
      if (disposed) return;
      const message = buildPetMessage();
      const serialized = JSON.stringify(message);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      stateChannel.postMessage(message);
    };

    // Leading + trailing throttle: the first change broadcasts immediately
    // (prompt state transitions), then at most one broadcast per window so
    // streaming captions don't spam the channel.
    const scheduleBroadcast = () => {
      if (disposed) return;
      const now = Date.now();
      const elapsed = now - lastBroadcast;
      if (elapsed >= BROADCAST_THROTTLE_MS) {
        lastBroadcast = now;
        flushNow();
      } else if (trailingTimer === null) {
        trailingTimer = window.setTimeout(() => {
          trailingTimer = null;
          lastBroadcast = Date.now();
          flushNow();
        }, BROADCAST_THROTTLE_MS - elapsed);
      }
    };

    // Subscribe to each directory store (status/permission/question/message
    // changes) plus the registry so newly-opened directories get wired up.
    const storeUnsubs = new Map<string, () => void>();
    const rebindStores = () => {
      if (disposed) return;
      const stores = safeChildStores();
      if (!stores) return;
      const live = new Set<string>();
      for (const [directory, store] of stores.children.entries()) {
        live.add(directory);
        if (!storeUnsubs.has(directory)) {
          storeUnsubs.set(directory, store.subscribe(() => scheduleBroadcast()));
        }
      }
      for (const [directory, unsub] of storeUnsubs) {
        if (!live.has(directory)) {
          unsub();
          storeUnsubs.delete(directory);
        }
      }
    };

    let unsubscribeRegistry: (() => void) | null = null;
    const stores = safeChildStores();
    if (stores) {
      unsubscribeRegistry = stores.subscribeRegistry(() => {
        rebindStores();
        scheduleBroadcast();
      });
    }
    rebindStores();

    const unsubscribeNotif = useNotificationStore.subscribe(() => scheduleBroadcast());
    const unsubscribeGlobal = useGlobalSessionsStore.subscribe(() => scheduleBroadcast());
    const unsubscribeGlobalStatus = useGlobalSessionStatusStore.subscribe(() => scheduleBroadcast());

    // Self-sufficient like the tray: load the cross-project list so sessions in
    // directories this window never opened still count.
    void ensureGlobalSessionsLoaded(getAllSyncSessions());

    const safetyInterval = window.setInterval(() => {
      rebindStores();
      flushNow();
    }, SAFETY_POLL_MS);

    actionChannel.onmessage = (event) => {
      const action = event.data as PetActionMessage | undefined;
      if (!action || typeof action !== 'object') return;
      switch (action.type) {
        case 'request-state':
          // A pet window just mounted (or re-requested): re-broadcast now rather
          // than wait for the next change.
          lastSerialized = '';
          flushNow();
          break;
        case 'respond-permission':
          void respondToPermission(action.sessionId, action.id, action.response).catch(() => {
            toast.error('Failed to respond to permission request');
          });
          break;
        case 'focus-session':
          // Reveal + focus the main window AND navigate to the session — the
          // same native path the tray uses, so clicking a bubble surfaces the
          // chat even when the main window is hidden behind the floating pet.
          void invokeDesktop('desktop_focus_main_window', { sessionId: action.sessionId }).catch(() => {});
          break;
      }
    };

    // Broadcast current state on activation so a pet that opened before this
    // effect attached doesn't sit on idle.
    flushNow();

    return () => {
      disposed = true;
      if (trailingTimer !== null) window.clearTimeout(trailingTimer);
      window.clearInterval(safetyInterval);
      unsubscribeNotif();
      unsubscribeGlobal();
      unsubscribeGlobalStatus();
      unsubscribeRegistry?.();
      for (const unsub of storeUnsubs.values()) unsub();
      storeUnsubs.clear();
      actionChannel.close();
      stateChannel.close();
    };
  }, [enabled]);
};
