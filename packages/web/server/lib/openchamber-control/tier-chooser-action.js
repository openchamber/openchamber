import { OpenChamberControlError } from './error.js';
import { buildTierChooserCard } from './tier-chooser-card.js';

const asNonEmptyString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

const modelKey = (model) => `${model.providerID}/${model.id}`;

/**
 * Tier options for the chooser card, assembled from the agent's
 * candidate models and the catalog (issue #14, slice 2). The agent
 * proposes one model per tier — it knows the routing context — and
 * pricing is filled from the catalog's models.dev values, which is
 * where the card contract puts pricing lookup: with the caller,
 * never in the card builder. A model the catalog does not know is a
 * caller error, named in the result, not a silently unpriced tile.
 */
export const assembleTierOptions = ({ tiers, catalog } = {}) => {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new OpenChamberControlError('tiers is required: a non-empty list of { tier, model } candidates', 400);
  }
  const byKey = new Map((Array.isArray(catalog) ? catalog : []).map((model) => [modelKey(model), model]));
  const byId = new Map((Array.isArray(catalog) ? catalog : []).map((model) => [model.id, model]));
  return tiers.map((entry) => {
    const tier = asNonEmptyString(entry?.tier);
    const modelRef = asNonEmptyString(entry?.model);
    if (!tier || !modelRef) {
      throw new OpenChamberControlError('every tier needs { tier, model }', 400);
    }
    const model = byKey.get(modelRef) ?? byId.get(modelRef);
    if (!model) {
      throw new OpenChamberControlError(`model '${modelRef}' is not in the catalog for this directory`, 400);
    }
    const cost = model.cost ?? {};
    return {
      tier,
      model: modelKey(model),
      label: asNonEmptyString(entry?.label) ?? model.name ?? undefined,
      description: asNonEmptyString(entry?.description) ?? undefined,
      latency: asNonEmptyString(entry?.latency) ?? undefined,
      inputPerM: typeof cost.input === 'number' ? cost.input : undefined,
      outputPerM: typeof cost.output === 'number' ? cost.output : undefined,
    };
  });
};

/**
 * `render.tierChooser`: the production caller for the tier-chooser
 * card (issue #14, slice 2). Renders the standardized card through
 * the same render.page machinery (awaitAnswer) and returns the
 * user's pick as { tier, model } so the agent can apply it to the
 * session. The action itself changes no session state: a page the
 * user never answers settles exactly like render.page's — the
 * session is untouched either way.
 */
export const createTierChooserAction = ({ listModels, renderPage }) => async (input, context = {}) => {
  const catalog = await listModels(context.directory);
  const tiers = assembleTierOptions({ tiers: input?.tiers, catalog });
  const title = asNonEmptyString(input?.title) ?? undefined;
  const html = buildTierChooserCard({ title, tiers });
  const result = await renderPage(
    { html, title: title ?? 'Select Execution Tier', awaitAnswer: true },
    context,
  );
  const data = result?.answer?.data ?? {};
  return {
    title: result?.title,
    tier: asNonEmptyString(data.tier) ?? null,
    model: asNonEmptyString(data.model) ?? null,
    summary: result?.answer?.summary ?? null,
    note: result?.note,
  };
};
