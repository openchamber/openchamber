export const createCostTracker = (deps) => {
  const {
    broadcastEvent,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl = fetch,
  } = deps;

  const sessionBudgets = new Map();
  const budgetLocked = new Set();

  const abortSessionOnServer = async (sessionId) => {
    try {
      const url = buildOpenCodeUrl(`/session/${sessionId}/abort`, '');
      const headers = getOpenCodeAuthHeaders();
      await fetchImpl(url, { method: 'POST', headers });
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

      budget.cumulativeCostUsd += cost;

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
  };
};
