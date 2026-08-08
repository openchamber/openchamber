import { beforeEach, describe, expect, test } from 'bun:test';

import {
  __resetOpenChamberEventBusForTesting,
  isWsEventPipelineActive,
  publishOpenChamberBusEvent,
  setWsEventPipelineActive,
  subscribeOpenChamberBusEvents,
  subscribeWsActiveChanged,
  type OpenChamberBusEvent,
} from './openchamberEventBus';

describe('openchamberEventBus', () => {
  beforeEach(() => {
    __resetOpenChamberEventBusForTesting();
  });

  describe('setWsEventPipelineActive / isWsEventPipelineActive', () => {
    test('defaults to inactive', () => {
      expect(isWsEventPipelineActive()).toBe(false);
    });

    test('transitions to active', () => {
      setWsEventPipelineActive(true);
      expect(isWsEventPipelineActive()).toBe(true);
    });

    test('transitions back to inactive', () => {
      setWsEventPipelineActive(true);
      setWsEventPipelineActive(false);
      expect(isWsEventPipelineActive()).toBe(false);
    });

    test('deduplicates — no listener fire on same value', () => {
      const calls: boolean[] = [];
      subscribeWsActiveChanged((active) => calls.push(active));

      setWsEventPipelineActive(true);
      setWsEventPipelineActive(true);
      setWsEventPipelineActive(true);

      expect(calls).toEqual([true]);
    });
  });

  describe('subscribeWsActiveChanged', () => {
    test('fires on true transition', () => {
      const calls: boolean[] = [];
      subscribeWsActiveChanged((active) => calls.push(active));

      setWsEventPipelineActive(true);

      expect(calls).toEqual([true]);
    });

    test('fires on false transition', () => {
      setWsEventPipelineActive(true);

      const calls: boolean[] = [];
      subscribeWsActiveChanged((active) => calls.push(active));

      setWsEventPipelineActive(false);

      expect(calls).toEqual([false]);
    });

    test('stops firing after unsubscribe', () => {
      const calls: boolean[] = [];
      const unsubscribe = subscribeWsActiveChanged((active) => calls.push(active));

      setWsEventPipelineActive(true);
      unsubscribe();
      setWsEventPipelineActive(false);

      expect(calls).toEqual([true]);
    });

    test('survives a listener throwing without breaking others', () => {
      const survivingCalls: boolean[] = [];
      subscribeWsActiveChanged(() => {
        throw new Error('boom');
      });
      subscribeWsActiveChanged((active) => survivingCalls.push(active));

      setWsEventPipelineActive(true);

      expect(survivingCalls).toEqual([true]);
    });
  });

  describe('publishOpenChamberBusEvent / subscribeOpenChamberBusEvents', () => {
    const sampleEvent: OpenChamberBusEvent = {
      type: 'openchamber:session-created',
      properties: { sessionId: 'ses_1' },
    };

    test('delivers to a single subscriber', () => {
      const received: OpenChamberBusEvent[] = [];
      subscribeOpenChamberBusEvents((event) => received.push(event));

      publishOpenChamberBusEvent(sampleEvent);

      expect(received).toEqual([sampleEvent]);
    });

    test('delivers to multiple subscribers', () => {
      const receivedA: OpenChamberBusEvent[] = [];
      const receivedB: OpenChamberBusEvent[] = [];
      subscribeOpenChamberBusEvents((event) => receivedA.push(event));
      subscribeOpenChamberBusEvents((event) => receivedB.push(event));

      publishOpenChamberBusEvent(sampleEvent);

      expect(receivedA).toEqual([sampleEvent]);
      expect(receivedB).toEqual([sampleEvent]);
    });

    test('stops delivering after unsubscribe', () => {
      const received: OpenChamberBusEvent[] = [];
      const unsubscribe = subscribeOpenChamberBusEvents((event) => received.push(event));

      publishOpenChamberBusEvent(sampleEvent);
      unsubscribe();
      publishOpenChamberBusEvent(sampleEvent);

      expect(received).toHaveLength(1);
    });

    test('survives a subscriber throwing without breaking others', () => {
      const surviving: OpenChamberBusEvent[] = [];
      subscribeOpenChamberBusEvents(() => {
        throw new Error('boom');
      });
      subscribeOpenChamberBusEvents((event) => surviving.push(event));

      publishOpenChamberBusEvent(sampleEvent);

      expect(surviving).toEqual([sampleEvent]);
    });
  });
});
