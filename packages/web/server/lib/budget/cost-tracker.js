export const createCostTracker = (deps) => {
  const {
    broadcastEvent,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl = fetch,
  } = deps;

  const sessionBudgets = new Map();
  const budgetLocked = new Set();
  const lastSeenCost = new Map();

  const abortSessionOnServer = async (sessionId) => {
    try {
      const url = buildOpenCodeUrl(`/session/${sessionId}/abort`, '');
      const headers = getOpenCodeAuthHeaders();
      await fetchImpl(url, { method: 'POST', headers });
    } catch {
    }
  };

  const resumeSessionOnServer = async (sessionId) => {
    try {
      const url = buildOpenCodeUrl(`/session/${sessionId}/prompt_async`, '');
      const headers = getOpenCodeAuthHeaders();
      await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{
            type: 'text',
            text: 'The previous response was interrupted by a budget cap. Continue from where you left off.',
            synthetic: true,
          }],
        }),
      });
    } catch {
    }
  };

  return {
    setBudget: (sessionId, maxBudgetUsd) => {
      if (!sessionId || typeof sessionId !== 'string') return false;
      if (maxBudgetUsd != null && (typeof maxBudgetUsd !== 'number' || maxBudgetUsd < 0)) return false;

      const existing = sessionBudgets.get(sessionId) || {
        cumulativeCostUsd: 0,
        softCapEmitted: false,
        hardCapHit: false,
      };
      sessionBudgets.set(sessionId, {
        ...existing,
        maxBudgetUsd: maxBudgetUsd ?? null,
      });
      if (maxBudgetUsd == null) {
        budgetLocked.delete(sessionId);
      }
      return true;
    },

    getBudget: (sessionId) => {
      if (!sessionId) return null;
      return sessionBudgets.get(sessionId) ?? null;
    },

    isBudgetLocked: (sessionId) => {
      return budgetLocked.has(sessionId);
    },

    increaseBudget: (sessionId, additionalUsd) => {
      if (!sessionId || typeof additionalUsd !== 'number' || additionalUsd <= 0) return false;
      const budget = sessionBudgets.get(sessionId);
      if (!budget) return false;
      budget.maxBudgetUsd = (budget.maxBudgetUsd ?? 0) + additionalUsd;
      budget.hardCapHit = false;
      budget.softCapEmitted = false;
      budgetLocked.delete(sessionId);
      return true;
    },

    removeCap: (sessionId) => {
      if (!sessionId) return false;
      const budget = sessionBudgets.get(sessionId);
      if (!budget) return false;
      budget.maxBudgetUsd = null;
      budget.hardCapHit = false;
      budget.softCapEmitted = false;
      budgetLocked.delete(sessionId);
      return true;
    },

    resumeSession: (sessionId) => {
      void resumeSessionOnServer(sessionId);
    },

    processMessageCost: (payload) => {
      if (!payload || payload.type !== 'message.updated') return;

      const properties = payload.properties;
      if (!properties || typeof properties !== 'object') return;

      const info = properties.info;
      if (!info || typeof info !== 'object') return;

      const sessionId = typeof info.sessionID === 'string' ? info.sessionID : null;
      const cost = info.cost;

      if (!sessionId || typeof cost !== 'number' || cost <= 0) return;

      const budget = sessionBudgets.get(sessionId);
      if (!budget || budget.maxBudgetUsd == null) return;
      if (budgetLocked.has(sessionId)) return;

      let sessionCosts = lastSeenCost.get(sessionId);
      if (!sessionCosts) {
        sessionCosts = new Map();
        lastSeenCost.set(sessionId, sessionCosts);
      }
      const lastCost = sessionCosts.get(info.id) ?? 0;
      const delta = cost - lastCost;
      if (delta <= 0) return;
      sessionCosts.set(info.id, cost);

      budget.cumulativeCostUsd += delta;

      const pct = budget.maxBudgetUsd > 0
        ? (budget.cumulativeCostUsd / budget.maxBudgetUsd) * 100
        : 0;

      if (pct >= 100) {
        budget.hardCapHit = true;
        budgetLocked.add(sessionId);

        if (typeof broadcastEvent === 'function') {
          broadcastEvent({
            type: 'openchamber:budget-exceeded',
            properties: {
              sessionID: sessionId,
              cumulativeCost: budget.cumulativeCostUsd,
              maxBudget: budget.maxBudgetUsd,
            },
          });
        }

        void abortSessionOnServer(sessionId);
        return;
      }

      if (pct >= 80 && !budget.softCapEmitted) {
        budget.softCapEmitted = true;

        if (typeof broadcastEvent === 'function') {
          broadcastEvent({
            type: 'openchamber:budget-warning',
            properties: {
              sessionID: sessionId,
              cumulativeCost: budget.cumulativeCostUsd,
              maxBudget: budget.maxBudgetUsd,
              percentUsed: Math.round(pct),
            },
          });
        }
      }
    },

    cleanupSession: (sessionId) => {
      sessionBudgets.delete(sessionId);
      budgetLocked.delete(sessionId);
      lastSeenCost.delete(sessionId);
    },
  };
};
