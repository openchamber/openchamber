export const registerBudgetRoutes = (app, deps) => {
  const {
    express,
    uiAuthController,
    costTracker,
  } = deps;

  const requireAuth = (req, res, next) => {
    if (uiAuthController && uiAuthController.enabled) {
      if (!uiAuthController.isAuthenticated(req)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }
    next();
  };

  app.post('/api/sessions/:sessionId/budget', requireAuth, express.json(), (req, res) => {
    const { sessionId } = req.params;
    const { maxBudgetUsd } = req.body;

    if (maxBudgetUsd != null && (typeof maxBudgetUsd !== 'number' || maxBudgetUsd < 0)) {
      res.status(400).json({ error: 'maxBudgetUsd must be a non-negative number or null' });
      return;
    }

    costTracker.setBudget(sessionId, maxBudgetUsd ?? null);
    res.json({ ok: true, budget: costTracker.getBudget(sessionId) });
  });

  app.get('/api/sessions/:sessionId/budget', requireAuth, (req, res) => {
    const { sessionId } = req.params;
    const budget = costTracker.getBudget(sessionId);
    res.json({ ok: true, budget });
  });

  app.post('/api/sessions/:sessionId/budget/increase', requireAuth, express.json(), (req, res) => {
    const { sessionId } = req.params;
    const { additionalUsd } = req.body;

    if (typeof additionalUsd !== 'number' || additionalUsd <= 0) {
      res.status(400).json({ error: 'additionalUsd must be a positive number' });
      return;
    }

    const ok = costTracker.increaseBudget(sessionId, additionalUsd);
    if (!ok) {
      res.status(404).json({ error: 'No budget configured for this session' });
      return;
    }

    res.json({ ok: true, budget: costTracker.getBudget(sessionId) });
  });

  app.post('/api/sessions/:sessionId/budget/remove-cap', requireAuth, (req, res) => {
    const { sessionId } = req.params;
    const ok = costTracker.removeCap(sessionId);
    if (!ok) {
      res.status(404).json({ error: 'No budget configured for this session' });
      return;
    }
    res.json({ ok: true });
  });
};
