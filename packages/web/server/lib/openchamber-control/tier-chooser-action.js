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
  const models = Array.isArray(catalog) ? catalog : [];
  const byKey = new Map(models.map((model) => [modelKey(model), model]));
  const byId = new Map();
  for (const model of models) {
    const matches = byId.get(model.id) ?? [];
    matches.push(model);
    byId.set(model.id, matches);
  }
  return tiers.map((entry) => {
    const tier = asNonEmptyString(entry?.tier);
    const modelRef = asNonEmptyString(entry?.model);
    if (!tier || !modelRef) {
      throw new OpenChamberControlError('every tier needs { tier, model }', 400);
    }
    let model = byKey.get(modelRef);
    if (!model) {
      const matches = byId.get(modelRef) ?? [];
      // A bare model id several providers expose names no model: picking
      // one by catalog order would silently price and select another
      // provider's model. Ask for the qualified provider/model form.
      if (matches.length > 1) {
        throw new OpenChamberControlError(
          `model '${modelRef}' is offered by more than one provider (${matches.map(modelKey).join(', ')}); name it as provider/model`,
          400,
        );
      }
      model = matches[0];
    }
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
 * card (issue #14, slice 2). It assembles the priced options and
 * builds the standardized card, then hands the agent the page to
 * show: the agent calls render.page with the returned html and
 * awaitAnswer, and the pick comes back as that call's answer
 * { tier, model } for the agent to apply to the session.
 *
 * The two calls are not ceremony. The chat draws a page from the
 * render.page call's own input — the html travels in the call the
 * user sees (see renderedPage in the UI's tool helpers) — so a
 * waiting call whose input carries tiers instead of html could
 * never be drawn or answered. Building here and waiting there is
 * the only shape in which the card reaches the chat. This action
 * changes no session state either way.
 */
export const createTierChooserAction = ({ listModels }) => async (input, context = {}) => {
  const catalog = await listModels(context.directory);
  const tiers = assembleTierOptions({ tiers: input?.tiers, catalog });
  const title = asNonEmptyString(input?.title) ?? 'Select Execution Tier';
  const html = buildTierChooserCard({ title, tiers });
  return {
    title,
    html,
    tiers,
    note: 'Show this page with render.page (html above, awaitAnswer: true). The answer data is { tier, model }: the tier the user picked. Apply it as the session model/tier; if the page goes unanswered, leave the session unchanged.',
  };
};
