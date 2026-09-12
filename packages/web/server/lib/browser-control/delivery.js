/**
 * Delivery of browser-control requests to connected OpenChamber clients.
 *
 * Every targeted request is delivered only by inventory match: each window
 * posts what it can serve (the directory it can open tabs in, the controllers
 * it has registered, the tab it is showing) and a request lands only on
 * connections whose inventory covers the request's target. Which clients those
 * are decides whether the agent gets an honest "not here" instead of an
 * action executed against the wrong project — or a twenty-second timeout.
 */

/**
 * Picks the connections a request may be delivered to.
 *
 * An untargeted request keeps the pre-scope broadcast behavior. A targeted
 * request is matched on top of the version gate (a connection without a
 * per-window identity predates the scoped envelope and would silently drop
 * it):
 *
 * - `browser.open` without a tabId only needs a panel to open the tab in, so
 *   it matches `openableDirectory` regardless of browser capability (a web
 *   client opens a display-only iframe tab today).
 * - `browser.open` with a tabId navigates an existing tab, so it matches like
 *   any rich action: capability plus an exact controller entry.
 * - `browser.tabs` is a read-only listing and matches on the controller
 *   directory alone.
 * - Every other rich action needs a controller entry and, when the request
 *   names no tab, also the connection's visible tab living in the target
 *   directory — a focused window whose browser panes are hidden behind a
 *   non-browser tab must not be picked.
 *
 * An explicitly named tab prefers the window where that tab is the visible
 * active target; only when it is visible nowhere do background registrations
 * serve. A multi-match prefers the single focused window; a tie (or no focus
 * anywhere) delivers to all matches and lets the claim race decide.
 */
export const selectEligibleConnections = (clients, request) => {
  const target = request.target ?? null;
  const matches = [];

  if (!target) {
    const needsBrowserView = request.action !== 'browser.open';
    for (const client of clients) {
      if (needsBrowserView && client.openchamberBrowserCapable !== true) continue;
      matches.push(client);
    }
    return matches;
  }

  const directory = typeof target.directory === 'string' && target.directory ? target.directory : null;
  const tabId = typeof target.tabId === 'string' && target.tabId ? target.tabId : null;
  const isOpen = request.action === 'browser.open';
  const isTabList = request.action === 'browser.tabs';

  for (const client of clients) {
    // Version gate: see the untargeted branch for what legacy connections get.
    if (client.openchamberClientId == null) continue;
    if (!directory) continue;
    const inventory = client.browserControlInventory;
    if (!inventory) continue;

    if (isOpen && !tabId) {
      if (inventory.openableDirectory === directory) matches.push(client);
      continue;
    }

    if (client.openchamberBrowserCapable !== true) continue;
    const controllers = Array.isArray(inventory.controllers) ? inventory.controllers : [];
    const hasController = controllers.some((entry) => (
      entry
      && entry.directory === directory
      && (!tabId || isTabList || entry.tabId === tabId)
    ));
    if (!hasController) continue;

    if (isTabList) {
      matches.push(client);
      continue;
    }
    if (!tabId && inventory.activeTarget?.directory !== directory) continue;
    matches.push(client);
  }

  let eligible = matches;
  if (tabId && !isTabList) {
    const visible = eligible.filter(
      (client) => client.browserControlInventory?.activeTarget?.tabId === tabId,
    );
    if (visible.length > 0) eligible = visible;
  }

  if (eligible.length > 1) {
    const focused = eligible.filter(
      (client) => client.browserControlInventory?.hasFocus === true,
    );
    if (focused.length === 1) return focused;
  }
  return eligible;
};

/**
 * Writes a request to every eligible connection and reports how many were
 * reached plus their client ids, which the broker records as the request's
 * eligible set.
 */
export const deliverBrowserControlRequest = ({ request, clients, writeSseEvent }) => {
  const eligibleClientIds = [];
  let delivered = 0;
  for (const client of selectEligibleConnections(clients, request)) {
    try {
      writeSseEvent(client, {
        type: 'openchamber:browser-control-request',
        properties: {
          requestId: request.requestId,
          action: request.action,
          parameters: request.parameters,
          target: request.target,
        },
      });
      delivered += 1;
      if (typeof client.openchamberClientId === 'string' && client.openchamberClientId) {
        eligibleClientIds.push(client.openchamberClientId);
      }
    } catch {
      clients.delete(client);
    }
  }
  return { delivered, eligibleClientIds };
};

/**
 * Records the inventory each window posts about itself, on the connection
 * object itself, and notifies waiters when one actually changed. A per-client
 * monotonic revision kills out-of-order overwrites: a delayed earlier post
 * can never replace a newer one.
 */
export const createInventoryRecorder = () => {
  const listeners = new Set();
  return {
    onInventoryUpdated(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record(clients, clientId, inventory) {
      let recorded = false;
      for (const client of clients) {
        if (client.openchamberClientId !== clientId) continue;
        const current = client.browserControlInventory;
        if (current && current.revision >= inventory.revision) continue;
        client.browserControlInventory = inventory;
        recorded = true;
      }
      if (recorded) {
        for (const listener of [...listeners]) listener();
      }
      return recorded;
    },
  };
};

/**
 * Whether any identified connection has not posted an inventory yet — the one
 * case where a zero-match delivery waits instead of failing, because the
 * matching window may still be connecting.
 */
export const hasConnectionAwaitingInventory = (clients) => {
  for (const client of clients) {
    if (client.openchamberClientId != null && !client.browserControlInventory) return true;
  }
  return false;
};


/**
 * Writes the one-off cancel for a request that settled early to the
 * connections it was delivered to. The payload is exactly the request id —
 * the claim token never travels over the broadcast.
 */
export const deliverBrowserControlCancel = ({ requestId, eligibleClientIds, clients, writeSseEvent }) => {
  const eligible = new Set(Array.isArray(eligibleClientIds) ? eligibleClientIds : []);
  for (const client of clients) {
    if (!eligible.has(client.openchamberClientId)) continue;
    try {
      writeSseEvent(client, {
        type: 'openchamber:browser-control-cancel',
        properties: { requestId },
      });
    } catch {
      clients.delete(client);
    }
  }
};