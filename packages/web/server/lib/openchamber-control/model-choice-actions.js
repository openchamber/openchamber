/**
 * `models.choices` for the `openchamber` control tool: the notes built from
 * the model and effort choices the user made by hand, the most recent choices,
 * and whether recording is on. Read only; clearing the history and turning
 * recording off stay with the user in Settings.
 *
 * Dependencies (`createModelChoiceActions(deps)`), from packages/web/server/index.js:
 * - `modelChoiceService` — `../model-choices/service.js`.
 */
import { OpenChamberControlError } from './error.js';

export const MODEL_CHOICE_ACTION_DEFINITIONS = Object.freeze([
  { action: 'models.choices', title: 'Read the user\'s model choice notes', description: 'Notes on which model and effort the user picks by hand for goal specs and chat messages (such as "picks low effort on claude-opus for goal specs (7 of 9 times)"), the most recent choices (limit, default 50), and whether recording is on. Read only' },
]);

const MODEL_CHOICE_ACTIONS = MODEL_CHOICE_ACTION_DEFINITIONS.map(({ action }) => action);

export const createModelChoiceActions = ({ modelChoiceService }) => {
  const choices = async (input) => {
    const summary = await modelChoiceService.summary({ limit: input.limit });
    return { enabled: summary.enabled, total: summary.total, notes: summary.notes, events: summary.events };
  };

  const execute = async (action, input = {}) => {
    if (action === 'models.choices') return choices(input);
    throw new OpenChamberControlError(`Unsupported model choice action: ${action || 'missing'}`, 400);
  };

  return { actions: MODEL_CHOICE_ACTIONS, execute };
};
