import { OpenChamberControlError } from './error.js';
import { buildQuotaFallbackCard } from './tier-chooser-card.js';
import { assembleTierOptions } from './tier-chooser-action.js';

const asNonEmptyString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

const providerOf = (option) => option.model.slice(0, option.model.indexOf('/'));

const totalCost = (option) => {
  if (option.inputPerM === undefined && option.outputPerM === undefined) return null;
  return (option.inputPerM ?? 0) + (option.outputPerM ?? 0);
};

/**
 * Fallback options for the quota card, assembled from the agent's tier
 * candidates and the catalog (issue #14, slice 3). The card contract
 * requires one action per kind, and each kind's target is derived, not
 * invented:
 *
 * - switch-provider: the first catalog provider other than the current
 *   one, at the current tier — configuration order is the preference
 *   order the directory already declares.
 * - downgrade-tier: the priciest candidate still cheaper than the
 *   current tier's model (the nearest downgrade), priced from the
 *   catalog by the same assembly the tier chooser uses.
 * - wait-for-reset: the current provider and tier, with the reset time
 *   the error path reported when it knows one.
 *
 * A fallback that cannot be assembled (no other provider configured,
 * no cheaper tier priced) is a caller error named in the result, not
 * a card with a dead tile.
 */
export const assembleFallbackActions = ({ tiers, catalog, currentTier, currentProvider, resetAt } = {}) => {
  const options = assembleTierOptions({ tiers, catalog });
  const currentName = asNonEmptyString(currentTier);
  if (!currentName) {
    throw new OpenChamberControlError('currentTier is required: the tier whose quota ran out', 400);
  }
  const current = options.find((option) => option.tier === currentName);
  if (!current) {
    throw new OpenChamberControlError(`currentTier '${currentName}' is not one of the tier candidates`, 400);
  }
  const currentProviderId = providerOf(current);
  const namedProvider = asNonEmptyString(currentProvider);
  if (namedProvider && namedProvider !== currentProviderId) {
    throw new OpenChamberControlError(
      `currentProvider '${namedProvider}' does not match the current tier's model provider '${currentProviderId}'`,
      400,
    );
  }

  const providers = [...new Set((Array.isArray(catalog) ? catalog : []).map((model) => model.providerID))];
  const switchProvider = providers.find((provider) => provider && provider !== currentProviderId);
  if (!switchProvider) {
    throw new OpenChamberControlError('no other provider is configured for this directory to switch to', 400);
  }

  const currentCost = totalCost(current);
  if (currentCost === null) {
    throw new OpenChamberControlError(`the current tier's model '${current.model}' has no catalog pricing; cannot choose a downgrade`, 400);
  }
  const downgrade = options
    .filter((option) => option.tier !== currentName)
    .map((option) => ({ option, cost: totalCost(option) }))
    .filter(({ cost }) => cost !== null && cost < currentCost)
    .sort((a, b) => b.cost - a.cost)[0]?.option;
  if (!downgrade) {
    throw new OpenChamberControlError('no cheaper tier candidate is priced in the catalog to downgrade to', 400);
  }

  const reset = asNonEmptyString(resetAt);
  return {
    current: { provider: currentProviderId, tier: currentName },
    actions: [
      {
        kind: 'switch-provider',
        provider: switchProvider,
        tier: currentName,
        detail: `Continue on ${switchProvider} at the ${currentName} tier`,
      },
      {
        kind: 'downgrade-tier',
        provider: providerOf(downgrade),
        tier: downgrade.tier,
        detail: `Continue on ${downgrade.model}`,
      },
      {
        kind: 'wait-for-reset',
        provider: currentProviderId,
        tier: currentName,
        detail: reset ? `Quota resets at ${reset}` : 'Wait for the quota window to reset',
      },
    ],
  };
};

/**
 * `render.quotaFallback`: the production caller for the quota-fallback
 * card (issue #14, slice 3), mirroring `render.tierChooser`. The agent
 * calls it from the quota/429 error path with its tier candidates and
 * the current tier; the action assembles the fallback options and
 * builds the standardized card, then hands the agent the page to
 * show: the agent calls render.page with the returned html and
 * awaitAnswer, and the choice comes back as that call's answer
 * { action: 'fallback', provider, tier } — switch provider, downgrade
 * tier, or wait for reset — for the agent to apply before resuming
 * the turn. An unanswered page leaves the turn's failure exactly as
 * it was. Like the tier chooser, the wait cannot live in this call:
 * the chat draws a page from the render.page call's own input html.
 */
export const createQuotaFallbackAction = ({ listModels }) => async (input, context = {}) => {
  const catalog = await listModels(context.directory);
  const { current, actions } = assembleFallbackActions({
    tiers: input?.tiers,
    catalog,
    currentTier: input?.currentTier,
    currentProvider: input?.currentProvider,
    resetAt: input?.resetAt,
  });
  const title = asNonEmptyString(input?.title) ?? undefined;
  const message = asNonEmptyString(input?.message) ?? undefined;
  const html = buildQuotaFallbackCard({
    title,
    message,
    currentProvider: current.provider,
    currentTier: current.tier,
    actions,
  });
  return {
    title: title ?? 'Quota Limit Reached',
    html,
    actions,
    note: "Show this page with render.page (html above, awaitAnswer: true). The answer data is { action: 'fallback', provider, tier }: switch the session to that provider/tier (or wait for the reset, when provider/tier are the current ones) and resume the turn. If the page goes unanswered, leave the failure as it stands.",
  };
};
