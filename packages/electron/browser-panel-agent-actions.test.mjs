import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_POPUP_WINDOW_MS, createBrowserPanelAgentActions } from './browser-panel-agent-actions.mjs';

const tracker = () => {
  let clock = 1_000;
  const actions = createBrowserPanelAgentActions({ now: () => clock });
  return { actions, page: {}, advance: (ms) => { clock += ms; } };
};

test('gives a popup to the session acting on the page while its action runs', () => {
  const { actions, page, advance } = tracker();
  assert.equal(actions.actingSession(page), null);
  actions.start(page, 'ses_a');
  advance(60_000);
  assert.deepEqual(actions.actingSession(page), { sessionId: 'ses_a' });
});

test('still gives the session a popup the page opens shortly after its action, as after an alert or a timer', () => {
  const { actions, page, advance } = tracker();
  actions.start(page, 'ses_a');
  actions.end(page);
  advance(AGENT_POPUP_WINDOW_MS - 1);
  assert.deepEqual(actions.actingSession(page), { sessionId: 'ses_a' });
  advance(1);
  assert.equal(actions.actingSession(page), null);
});

test('hands the page back to the user once they press a key or click it after the action', () => {
  const { actions, page } = tracker();
  actions.start(page, 'ses_a');
  actions.userInput(page);
  assert.deepEqual(actions.actingSession(page), { sessionId: 'ses_a' }, 'input during the action is the agent\'s own');
  actions.end(page);
  actions.userInput(page);
  assert.equal(actions.actingSession(page), null);
});

test('keeps pages apart and lets a later action take over the page', () => {
  const { actions, page } = tracker();
  const other = {};
  actions.start(page, 'ses_a');
  actions.end(page);
  actions.start(page, 'ses_b');
  assert.deepEqual(actions.actingSession(page), { sessionId: 'ses_b' });
  assert.equal(actions.actingSession(other), null);
});
