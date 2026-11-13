import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTrackedItems } from '../tracked-items/items.js';
import { createTrackedItemsService } from '../tracked-items/service.js';
import { createFrontDoorTrackedItems } from './tracked-items.js';

const item = { provider: 'github', kind: 'issue', owner: 'acme', repo: 'app', number: 1 };
const items = () => parseTrackedItems([item], 300);
const agents = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const agent of agents.splice(0)) agent.dispose();
  vi.useRealTimers();
});

const setup = async () => {
  let state = 'open';
  const events = [];
  const sourceControl = vi.fn(async ({ issues }) => ({ status: 'ok', issues: issues.map((ref) => ({ ...ref, title: 'Current issue', state })) }));
  const agent = createTrackedItemsService({
    readers: { sourceControl },
    isConnectionOpen: (id) => id === 'agent',
    send: (_id, event) => { events.push(event); return true; },
  });
  agents.push(agent);
  const service = createFrontDoorTrackedItems({ upstream: {
    json: async (route, options) => {
      const body = JSON.parse(options.body);
      if (route === '/api/tracked-items/presence') {
        agent.setPresence(body.connectionId, body.visible);
        return { ok: true };
      }
      return { states: agent.setInterest(body.connectionId, parseTrackedItems(body.items, 300), { visible: body.visible }) };
    },
  } });
  service.openConnection('ui-a');
  service.openConnection('ui-b');
  await service.setControlConnection('agent');
  return { service, sourceControl, events, completeIssue: () => { state = 'completed'; } };
};

describe('front-door tracked item lifecycle against the real agent service', () => {
  it('answers a new UI with current state when an unchanged union has resolved since registration', async () => {
    // Given the first UI registered an unknown item which the agent then resolved.
    const { service } = await setup();
    await service.setInterest('ui-a', items());
    await vi.advanceTimersByTimeAsync(0);
    // When a new UI asks about the same item without changing the union.
    const answer = await service.setInterest('ui-b', items());
    // Then its initial answer contains the agent's current state.
    expect(answer).toHaveLength(1);
    expect(answer[0].state.state).toBe('open');
  });

  it('refreshes aged items immediately when the aggregate becomes visible again', async () => {
    // Given a resolved issue hidden for more than the 15-second return floor.
    const { service, sourceControl, events, completeIssue } = await setup();
    await service.setInterest('ui-a', items());
    await vi.advanceTimersByTimeAsync(0);
    await service.setPresence('ui-a', false);
    await vi.advanceTimersByTimeAsync(16_000);
    completeIssue();
    // When the interested UI returns before the normal five-minute cadence.
    await service.setPresence('ui-a', true);
    await vi.advanceTimersByTimeAsync(0);
    // Then the real agent refreshes and emits the changed state immediately.
    expect(sourceControl).toHaveBeenCalledTimes(2);
    expect(events.at(-1).properties.states[0].state.state).toBe('completed');
  });
});
