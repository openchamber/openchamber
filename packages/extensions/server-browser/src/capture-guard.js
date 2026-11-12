import { createOriginRefusal } from './origin-refusal.js';

// Chrome runs with --auto-accept-this-tab-capture so the service can capture
// the sound of a tab from its own isolated world (tab-audio.js). The same flag
// would let any page record its own tab, frames from other sites included,
// without asking anyone. This takes that away from pages: every page and frame
// target is attached while paused at start, gets a getDisplayMedia that
// refuses before any of its scripts run, and only then resumes. Isolated
// worlds have their own MediaDevices.prototype, so the service's capture is
// untouched. A page Chrome refuses the guard for is closed.
const CAPTURE_GUARD_SOURCE = `(() => {
  if (typeof MediaDevices === 'undefined') return;
  const getDisplayMedia = function getDisplayMedia() {
    return Promise.reject(new DOMException('Screen capture is not available in this browser', 'NotAllowedError'));
  };
  try {
    Object.defineProperty(MediaDevices.prototype, 'getDisplayMedia', {
      value: getDisplayMedia,
      configurable: false,
      writable: false,
      enumerable: true,
    });
  } catch {}
})();`;

const GUARDED_TYPES = new Set(['page', 'iframe']);

// Sent in one go, without waiting for answers, with the resume last: a
// session runs its commands in order, so the script is in place before the
// target runs anything (Playwright starts popups the same way). A new tab's
// commands are only answered once its first page arrives, however long its
// server takes, so waiting on them before resuming would deadlock, and an
// answer that is late is not a refusal. Page.enable comes first: without it
// the script is not run for documents the target loads later.
// Out-of-process frames are targets of their own, attached here the same way.
// Resolves true when Chrome refused any of it.
const guardTarget = async (cdp, sessionId, waiting) => {
  const outcomes = await Promise.allSettled([
    cdp.sendSession(sessionId, 'Page.enable'),
    cdp.sendSession(sessionId, 'Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_GUARD_SOURCE, runImmediately: true }),
    cdp.sendSession(sessionId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
    ...(waiting ? [cdp.sendSession(sessionId, 'Runtime.runIfWaitingForDebugger')] : []),
  ]);
  return outcomes.some((outcome) => outcome.status === 'rejected' && outcome.reason?.code === 'protocol');
};

/**
 * Installs the guard for every target of the Chrome behind `cdp`, existing and
 * future. Call it before the first page loads anything. Resolves once Chrome
 * auto-attaches; returns the listener's cleanup.
 */
export const installCaptureGuard = async (cdp, { openchamberOrigins = [] } = {}) => {
  const refuses = createOriginRefusal(openchamberOrigins);
  // Targets that exist when the guard is installed are attached running;
  // every later one is attached paused. A running attach after that is
  // someone's own Target.attachToTarget (the runtime's), not ours to guard.
  let installing = true;
  const unsubscribe = cdp.onEvent((event) => {
    if (event.method === 'Fetch.requestPaused') {
      const { requestId, request } = event.params;
      const method = refuses(request.url) ? 'Fetch.failRequest' : 'Fetch.continueRequest';
      const params = method === 'Fetch.failRequest' ? { requestId, errorReason: 'BlockedByClient' } : { requestId };
      // A failed decision leaves the request paused, never continued unguarded.
      void cdp.sendSession(event.sessionId, method, params).catch(() => {});
      return;
    }
    if (event.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo, waitingForDebugger } = event.params ?? {};
    if (typeof sessionId !== 'string' || (!waitingForDebugger && !installing)) return;
    if (!GUARDED_TYPES.has(targetInfo?.type) && openchamberOrigins.length === 0) {
      if (waitingForDebugger) void cdp.sendSession(sessionId, 'Runtime.runIfWaitingForDebugger').catch(() => {});
      return;
    }
    const protect = async () => {
      if (openchamberOrigins.length > 0) {
        // Await admission before queuing resume. A refused Fetch.enable must
        // never release a page, popup, worker or cross-process frame.
        await cdp.sendSession(sessionId, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      }
      if (GUARDED_TYPES.has(targetInfo?.type)) return guardTarget(cdp, sessionId, waitingForDebugger);
      if (waitingForDebugger) await cdp.sendSession(sessionId, 'Runtime.runIfWaitingForDebugger');
      return false;
    };
    void protect().catch(() => true).then((refused) => {
      // A page Chrome refused the guard for does not stay open (closing one
      // already gone does nothing). A late answer, a slow first page, is no
      // refusal: Chrome still runs the commands, in order.
      if (!refused || targetInfo.type !== 'page') return undefined;
      return cdp.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
    });
  });
  try {
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  } catch (error) {
    unsubscribe();
    throw error;
  } finally {
    installing = false;
  }
  return unsubscribe;
};
