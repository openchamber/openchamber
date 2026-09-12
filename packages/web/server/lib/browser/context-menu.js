import { randomUUID } from 'node:crypto';

const OBSERVE_CONTEXT_MENU = `function () {
  const owner = this.ownerDocument?.defaultView;
  if (!owner) return null;
  void owner.top.document;
  let event = null;
  const listener = (next) => {
    if (!event && next.isTrusted && next.button === 2) event = next;
  };
  const dispose = () => {
    owner.removeEventListener('contextmenu', listener, true);
    owner.clearTimeout(timer);
    event = null;
  };
  owner.addEventListener('contextmenu', listener, true);
  const timer = owner.setTimeout(dispose, 5000);
  return { dispose, read: () => event ? (event.defaultPrevented ? 'page-handled' : 'menu') : 'unavailable' };
}`;

export function createBrowserContextMenu({ browserSessionManager, runViewerOperation, sendJson, parseString }) {
  const identity = (value) => {
    const text = parseString(value);
    if (!text || text.length > 128) throw new Error('Invalid context menu identity');
    return text;
  };
  const jobs = new Map();
  const busyTargets = new Set();
  const reply = (viewer, request, status) => sendJson(viewer.socket, { type: 'contextMenuResult', ...request, status });
  const detach = (viewer) => {
    const job = jobs.get(viewer);
    if (!job) return;
    jobs.delete(viewer);
    clearTimeout(job.timer);
    job.cleanup();
  };
  const unsubscribeControl = browserSessionManager?.onControlChange(({ sessionId, lease }) => {
    for (const [viewer, job] of jobs) {
      if (viewer.surfaceSession?.sessionId === sessionId && (lease?.viewerId !== viewer.id
        || (job.leaseGeneration !== null && lease.generation !== job.leaseGeneration))) detach(viewer);
    }
  });

  const run = async (viewer, request, point) => {
    const generation = viewer.attachmentGeneration;
    const surfaceSession = viewer.surfaceSession;
    const job = { cleanup: () => {}, timer: null, leaseGeneration: null };
    jobs.set(viewer, job);
    busyTargets.add(request.tabId);
    let ownsControl = () => {
      const lease = browserSessionManager.getLease(surfaceSession.sessionId);
      return lease?.viewerId === viewer.id && lease.generation === job.leaseGeneration;
    };
    const current = () => jobs.get(viewer) === job && viewer.socket.readyState === 1 && viewer.attached
      && viewer.tabId === request.tabId && viewer.attachmentRequestId === request.attachmentRequestId
      && viewer.attachmentGeneration === generation && viewer.surfaceSession === surfaceSession
      && !surfaceSession.closed && ownsControl();
    job.timer = setTimeout(() => {
      if (current()) reply(viewer, request, 'unavailable');
      detach(viewer);
    }, 5_000);
    job.timer.unref?.();
    try {
      const pending = runViewerOperation(viewer, request.tabId.slice(3), async ({ cdp, isCurrent }) => {
        ownsControl = isCurrent;
        if (!current()) return 'unavailable';
        const sessionId = cdp.getSessionId(request.tabId.slice(3));
        const objectGroup = `openchamber-context-menu-${randomUUID()}`;
        let observerId;
        let preparationRevision = 0;
        let cleanedRevision = -1;
        const unsubscribe = cdp.onEvent((event) => {
          if (event.sessionId === sessionId && ['Page.frameNavigated', 'Page.navigatedWithinDocument',
            'Runtime.executionContextsCleared'].includes(event.method)) detach(viewer);
        });
        job.cleanup = () => {
          if (cleanedRevision === preparationRevision) return;
          if (cleanedRevision === -1) unsubscribe();
          cleanedRevision = preparationRevision;
          const remove = observerId ? cdp.sendSession(sessionId, 'Runtime.callFunctionOn', {
            objectId: observerId, functionDeclaration: 'function () { this.dispose(); }', returnByValue: true, silent: true,
          }).catch(() => {}) : Promise.resolve();
          void remove.finally(() => cdp.sendSession(sessionId, 'Runtime.releaseObjectGroup', { objectGroup }).catch(() => {}));
        };
        try {
          try {
            const metrics = await cdp.sendSession(sessionId, 'Page.getLayoutMetrics');
            if (!current()) return 'unavailable';
            const viewport = metrics.cssLayoutViewport;
            if (!viewport || !Number.isFinite(viewport.pageX) || !Number.isFinite(viewport.pageY)) {
              throw new Error('Context menu viewport unavailable');
            }
            if (point.x >= viewport.clientWidth || point.y >= viewport.clientHeight) return 'unavailable';
            const hit = await cdp.sendSession(sessionId, 'DOM.getNodeForLocation', {
              x: Math.floor(point.x + viewport.pageX), y: Math.floor(point.y + viewport.pageY), includeUserAgentShadowDOM: false,
            });
            if (!current()) return 'unavailable';
            const node = await cdp.sendSession(sessionId, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId, objectGroup });
            if (!current()) return 'unavailable';
            const observer = await cdp.sendSession(sessionId, 'Runtime.callFunctionOn', {
              objectId: node.object.objectId, functionDeclaration: OBSERVE_CONTEXT_MENU, objectGroup, silent: true,
            });
            observerId = observer.result?.objectId;
          } catch { /* Observation failure must preserve the page's own right click. */ }
          finally { preparationRevision += 1; }
          if (!current()) return 'unavailable';
          const input = { ...point, button: 'right', clickCount: 1 };
          try {
            await cdp.sendSession(sessionId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...input });
          } finally {
            if (current()) await cdp.sendSession(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...input });
          }
          if (!current() || !observerId) return 'unavailable';
          const observed = await cdp.sendSession(sessionId, 'Runtime.callFunctionOn', {
            objectId: observerId, functionDeclaration: 'function () { return this.read(); }', returnByValue: true, silent: true,
          });
          return !observed.exceptionDetails && ['menu', 'page-handled'].includes(observed.result?.value)
            ? observed.result.value : 'unavailable';
        } finally { job.cleanup(); }
      });
      job.leaseGeneration = browserSessionManager.getLease(surfaceSession.sessionId)?.generation ?? null;
      const status = await pending;
      if (current()) reply(viewer, request, status ?? 'unavailable');
    } catch {
      if (current()) reply(viewer, request, 'unavailable');
    } finally {
      busyTargets.delete(request.tabId);
      if (jobs.get(viewer) === job) detach(viewer);
    }
  };

  return {
    handle(viewer, message, type) {
      if (type !== 'contextMenu') return false;
      let request;
      try {
        request = { tabId: identity(message.tabId), attachmentRequestId: identity(message.attachmentRequestId),
          requestId: identity(message.requestId) };
      } catch { return true; }
      if (!viewer.attached || viewer.tabId !== request.tabId || viewer.attachmentRequestId !== request.attachmentRequestId
        || !viewer.surfaceSession || viewer.surfaceSession.closed || jobs.has(viewer) || busyTargets.has(request.tabId)
        || ![message.x, message.y].every((value) => Number.isFinite(value) && value >= 0)) {
        reply(viewer, request, 'unavailable');
        return true;
      }
      void run(viewer, request, { x: message.x, y: message.y });
      return true;
    },
    detach,
    dispose() {
      unsubscribeControl?.();
      for (const viewer of jobs.keys()) detach(viewer);
    },
  };
}
