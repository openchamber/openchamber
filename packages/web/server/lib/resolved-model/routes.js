/**
 * UI-facing snapshot of the resolved backing model per session.
 *
 * Sessions tracked by the managed resolved-model plugin are reported live over
 * the `openchamber:resolved-model` SSE event; this route seeds a late-joining
 * client (page load, reconnect) with the authoritative current state.
 */
export function registerResolvedModelRoutes(app, { resolvedModelRuntime }) {
  app.get('/api/resolved-model', (_req, res) => {
    if (!resolvedModelRuntime) {
      return res.status(503).json({ error: 'Resolved model runtime is unavailable' });
    }
    return res.json({
      sessions: resolvedModelRuntime.getSnapshot(),
      serverTime: Date.now(),
    });
  });
}
