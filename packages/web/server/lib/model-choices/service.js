/**
 * The model choice history as the routes and the agent tool use it: record a
 * choice while recording is on, read the notes and suggestions, answer a
 * suggestion, clear everything.
 *
 * Recording follows `modelChoiceRecordingEnabled` (on unless set to false),
 * read here for every choice: the UI also stops sending while it is off, but
 * the server is where the switch holds.
 */
import { buildModelChoiceNotes, buildModelChoiceSuggestions } from './notes.js';
import { ModelChoiceStoreError } from './store.js';

const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 500;

const isModelChoiceRecordingEnabled = (settings) => settings?.modelChoiceRecordingEnabled !== false;

export const createModelChoiceService = ({ store, readSettings, persistSettings }) => {
  const recordingEnabled = async () => isModelChoiceRecordingEnabled(await readSettings());

  /** `{ recorded: false }` while recording is off; nothing is written then. */
  const record = async (input) => {
    if (!(await recordingEnabled())) return { recorded: false };
    await store.record(input);
    return { recorded: true };
  };

  const currentSuggestions = async (events, decisions, settings) => (
    isModelChoiceRecordingEnabled(settings) ? buildModelChoiceSuggestions({ events, decisions, settings }) : []
  );

  /**
   * Notes from every retained event, the newest `limit` events (newest first),
   * and the suggestions on offer. Suggestions are empty while recording is
   * off: the history stays until cleared, but nothing is proposed from it.
   */
  const summary = async ({ limit = DEFAULT_EVENT_LIMIT } = {}) => {
    const settings = await readSettings();
    const { events, decisions } = await store.snapshot();
    const count = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_EVENT_LIMIT, 0), MAX_EVENT_LIMIT);
    return {
      enabled: isModelChoiceRecordingEnabled(settings),
      total: events.length,
      notes: buildModelChoiceNotes(events),
      events: count === 0 ? [] : events.slice(-count).reverse(),
      suggestions: await currentSuggestions(events, decisions, settings),
    };
  };

  /**
   * Approve writes the suggestion's settings, then records the answer; a
   * failed write records nothing, so the suggestion stays on offer. Only a
   * suggestion offered right now can be answered.
   */
  const decide = async (id, decision) => {
    const settings = await readSettings();
    const { events, decisions } = await store.snapshot();
    const suggestion = (await currentSuggestions(events, decisions, settings)).find((entry) => entry.id === id);
    if (!suggestion) throw new ModelChoiceStoreError('That suggestion is no longer offered', 404);
    if (decision === 'approved') await persistSettings(suggestion.settings);
    await store.decide(id, decision);
    return { id, decision, settings: decision === 'approved' ? suggestion.settings : null };
  };

  return { record, summary, decide, clear: () => store.clear() };
};
