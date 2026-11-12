import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { parseTrackedItems, trackedItemKey } from '../tracked-items/items.js';
import { createFrontDoorTrackedItems, registerFrontDoorTrackedItemsRoutes } from './tracked-items.js';

const item = (number) => ({ provider: 'github', kind: 'issue', owner: 'acme', repo: 'app', number });
const items = (...numbers) => parseTrackedItems(numbers.map(item), 300);
const record = (value) => ({ key: trackedItemKey(value), item: value, state: null, fetchedAt: 1 });
const setup = async () => {
  const interest = vi.fn(async (options) => ({ states: JSON.parse(options.body).items.map(record) }));
  const upstream = { json: vi.fn(async (route, options) => route.endsWith('/presence') ? { ok: true } : interest(options)) };
  const service = createFrontDoorTrackedItems({ upstream });
  service.openConnection('ui-a');
  service.openConnection('ui-b');
  await service.setControlConnection('agent-a');
  upstream.json.mockClear();
  interest.mockClear();
  const bodies = () => interest.mock.calls.map(([options]) => JSON.parse(options.body));
  return { service, upstream, interest, bodies };
};

describe('front-door tracked items', () => {
  it('unions deduplicated items and answers only the requesting UI items', async () => {
    // Given one visible UI already showing an item.
    const { service, bodies } = await setup();
    await service.setInterest('ui-a', items(1));
    // When another UI replaces its interest with an overlapping set.
    const answer = await service.setInterest('ui-b', items(1, 2), { visible: false });
    // Then the upstream follows the union and each caller gets its own states.
    expect(bodies().at(-1)).toMatchObject({ visible: true, items: [item(1), item(2)] });
    expect(answer.map((state) => state.item.number)).toEqual([1, 2]);
    expect((await service.setInterest('ui-a', items(1))).map((state) => state.item.number)).toEqual([1]);
    expect(bodies()).toHaveLength(3);
  });

  it('uses only the upstream control id for every interest and visibility send', async () => {
    // Given interests on two UI connections.
    const { service, upstream, bodies } = await setup();
    await service.setInterest('ui-a', items(1));
    await service.setInterest('ui-b', items(2));
    // When both UIs hide, then any-visible becomes false without losing their union.
    await service.setPresence('ui-a', false);
    await service.setPresence('ui-b', false);
    expect(upstream.json.mock.calls.every(([, options]) => JSON.parse(options.body).connectionId === 'agent-a')).toBe(true);
    expect(bodies().at(-1)).toMatchObject({ visible: false });
    expect(bodies().at(-1).items.map((value) => value.number).sort()).toEqual([1, 2]);
  });

  it('removes closed UI interests and clears the agent when the last UI closes', async () => {
    // Given overlapping interests.
    const { service, bodies } = await setup();
    await service.setInterest('ui-a', items(1, 2));
    await service.setInterest('ui-b', items(2));
    // When each control connection closes, then only remaining interests survive.
    await service.closeConnection('ui-a');
    expect(bodies().at(-1).items).toEqual([item(2)]);
    await service.closeConnection('ui-b');
    expect(bodies().at(-1)).toEqual({ connectionId: 'agent-a', visible: false, items: [] });
    await expect(service.setInterest('ui-a', items(1))).rejects.toMatchObject({ code: 'unknown-connection' });
  });

  it('resends retained interests under the new upstream id after reconnect', async () => {
    // Given a registered interest and a disconnected upstream control stream.
    const { service, bodies } = await setup();
    await service.setInterest('ui-a', items(1));
    await service.setControlConnection(null);
    // When the stream reconnects, then it registers under the replacement id.
    await service.setControlConnection('agent-b');
    expect(bodies().at(-1)).toEqual({ connectionId: 'agent-b', visible: true, items: [item(1)] });
  });

  it('caps the union at 300, preferring visible and then more recent requests', async () => {
    // Given an older visible UI filling the bound and a newer hidden UI.
    const { service, bodies } = await setup();
    await service.setInterest('ui-a', items(...Array.from({ length: 300 }, (_, index) => index + 1)));
    await service.setInterest('ui-b', items(301, 302), { visible: false });
    expect(bodies().at(-1).items).toHaveLength(300);
    expect(bodies().at(-1).items.some((value) => value.number === 301)).toBe(false);
    // When the newer UI becomes visible, then its items displace the oldest tail.
    await service.setPresence('ui-b', true);
    expect(bodies().at(-1).items.map((value) => value.number)).toEqual([301, 302, ...Array.from({ length: 298 }, (_, index) => index + 1)]);
  });

  it.each([
    { states: [{ ...record(item(1)), state: { state: 'invented' } }] },
    { states: [{ ...record(item(1)), key: trackedItemKey(item(2)) }] },
    { states: Array.from({ length: 301 }, () => record(item(1))) },
  ])('rejects forged response states %#', async (answer) => {
    // Given an untrusted agent response.
    const { service, interest } = await setup();
    interest.mockResolvedValueOnce(answer);
    // When registering interest, then malformed authority never reaches the UI.
    await expect(service.setInterest('ui-a', items(1))).rejects.toMatchObject({ code: 'agent_invalid_response' });
  });

  it('strips unknown response fields and excludes items outside the union', async () => {
    // Given extra authority fields and an unrelated state in the agent answer.
    const { service, interest } = await setup();
    interest.mockResolvedValueOnce({ states: [{ ...record(item(1)), hostd: 'claim' }, record(item(2))], settings: {} });
    // When interest is sent, then only reconstructed requested states are returned.
    expect(await service.setInterest('ui-a', items(1))).toEqual([record(item(1))]);
  });

  it('serializes sends and rejects stale answers while reconnect queues the current union', async () => {
    // Given an interest send held in flight.
    const { service, interest, bodies } = await setup();
    const answer = Promise.withResolvers();
    const started = Promise.withResolvers();
    interest.mockImplementationOnce(() => { started.resolve(); return answer.promise; });
    const first = service.setInterest('ui-a', items(1));
    const rejected = expect(first).rejects.toMatchObject({ code: 'agent_control_unavailable' });
    await started.promise;
    // When another interest and a reconnect arrive, then no second send overlaps it.
    const second = service.setInterest('ui-b', items(2));
    const disconnect = service.setControlConnection(null);
    const reconnect = service.setControlConnection('agent-b');
    await new Promise((resolve) => setImmediate(resolve));
    expect(interest).toHaveBeenCalledOnce();
    answer.resolve({ states: [record(item(1))] });
    await rejected;
    await disconnect;
    expect((await second).map((state) => state.item.number)).toEqual([2]);
    await reconnect;
    expect(bodies().map((body) => body.connectionId)).toEqual(['agent-a', 'agent-b']);
  });

  it('retains interests after failure so a repeated request retries the send', async () => {
    // Given one failed upstream write.
    const { service, interest, bodies } = await setup();
    interest.mockRejectedValueOnce(new Error('offline'));
    await expect(service.setInterest('ui-a', items(1))).rejects.toThrow('offline');
    // When the UI retries, then the unchanged union is sent again.
    expect(await service.setInterest('ui-a', items(1))).toEqual([record(item(1))]);
    expect(bodies()).toHaveLength(2);
  });

  it('keeps route validation and rejects a UI id unknown to the local control stream', async () => {
    // Given real local routes with an upstream that knows no UI connection ids.
    const { service, bodies } = await setup();
    const app = express();
    registerFrontDoorTrackedItemsRoutes(app, { service });
    // When requests reach the local boundary, then malformed/closed requests stay local.
    await request(app).post('/api/tracked-items/interest').send({ connectionId: 'closed', items: [item(1)] }).expect(409);
    await request(app).post('/api/tracked-items/interest').send({ connectionId: 'ui-a', items: Array(301).fill(item(1)) }).expect(400);
    await request(app).post('/api/tracked-items/presence').send({ connectionId: 'ui-a', visible: 'yes' }).expect(400);
    const response = await request(app).post('/api/tracked-items/interest').send({ connectionId: 'ui-a', items: [item(1)] }).expect(200);
    expect(response.body.states).toEqual([record(item(1))]);
    expect(bodies().map((body) => body.connectionId)).toEqual(['agent-a']);
  });
});
