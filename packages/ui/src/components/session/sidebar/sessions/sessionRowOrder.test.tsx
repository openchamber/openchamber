import { beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { installHookTestDom } from '../test-utils/testDom';
import {
  SessionRowOrderProvider,
  createSessionRowOrderRegistry,
  useRegisterSessionRowOrder,
  useSessionRowOrderRegistry,
  type SessionRowOrderRegistry,
} from './sessionRowOrder';
import { toSessionRowOrderIds, type SessionRowOrderEntry } from './sessionRowOrderUtils';

const entry = (id: string, scopeKey: string | null = 'project-a', archived = false): SessionRowOrderEntry => ({
  id,
  scopeKey,
  archived,
});

type ProviderCapture = {
  registry: SessionRowOrderRegistry | null;
  observed: readonly string[] | null;
};

type ConsumerCapture = {
  registry: SessionRowOrderRegistry | null;
};

describe('session row order registry', () => {
  test('flattens segments by their order, not by registration order', () => {
    const registry = createSessionRowOrderRegistry();
    registry.register('late', { order: 2, entries: [entry('c')] });
    registry.register('early', { order: 0, entries: [entry('a')] });
    registry.register('middle', { order: 1, entries: [entry('b1'), entry('b2')] });

    expect(registry.getOrderedIds()).toEqual(['a', 'b1', 'b2', 'c']);
    expect(registry.getOrderedEntries()).toEqual([
      entry('a'),
      entry('b1'),
      entry('b2'),
      entry('c'),
    ]);
  });

  test('includes every model row, including ones virtualization keeps unmounted', () => {
    const registry = createSessionRowOrderRegistry();
    const offscreen = Array.from({ length: 2000 }, (_, index) => entry(`row-${index}`));
    registry.register('recent', { order: 0, entries: [entry('row-0')] });
    registry.register('project', { order: 1000, entries: offscreen });

    const orderedIds = registry.getOrderedIds();
    expect(orderedIds).toHaveLength(2001);
    expect(orderedIds[0]).toBe('row-0');
    expect(orderedIds[orderedIds.length - 1]).toBe('row-1999');
    expect(orderedIds.filter((id) => id === 'row-0')).toHaveLength(2);
  });

  test('unregisters a segment and rebuilds the cached order', () => {
    const registry = createSessionRowOrderRegistry();
    registry.register('a', { order: 0, entries: [entry('a')] });
    registry.register('b', { order: 1, entries: [entry('b')] });
    expect(registry.getOrderedIds()).toEqual(['a', 'b']);

    registry.unregister('a');
    expect(registry.getOrderedIds()).toEqual(['b']);

    registry.unregister('missing');
    expect(registry.getOrderedIds()).toEqual(['b']);
  });
});

describe('session row order provider', () => {
  test('registers each list in a layout effect before later passive effects read it', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const capture: ProviderCapture = {
      registry: null,
      observed: null,
    };
    const Segment = ({ order, entries }: { order: number; entries: readonly SessionRowOrderEntry[] }) => {
      useRegisterSessionRowOrder(order, entries);
      return null;
    };
    const Capture = () => {
      const registry = useSessionRowOrderRegistry();
      capture.registry = registry;
      React.useEffect(() => {
        capture.observed = registry?.getOrderedIds() ?? null;
      }, [registry]);
      return null;
    };

    try {
      await act(async () => root.render(
        <SessionRowOrderProvider>
          <Segment order={2} entries={[entry('late')]} />
          <Segment order={0} entries={[entry('early')]} />
          <Capture />
        </SessionRowOrderProvider>,
      ));

      expect(capture.registry).not.toBeNull();
      expect(capture.observed).toEqual(['early', 'late']);
      if (!capture.registry) throw new Error('registry was not provided');
      expect(capture.registry.getOrderedIds()).toEqual(['early', 'late']);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('re-registering entries does not re-render stable context consumers', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    let setEntries: React.Dispatch<React.SetStateAction<readonly SessionRowOrderEntry[]>> = () => undefined;
    let consumerRenders = 0;
    const consumerCapture: ConsumerCapture = { registry: null };
    const Consumer = React.memo(() => {
      consumerRenders += 1;
      consumerCapture.registry = useSessionRowOrderRegistry();
      return null;
    });
    const Segment = ({ entries }: { entries: readonly SessionRowOrderEntry[] }) => {
      useRegisterSessionRowOrder(0, entries);
      return null;
    };
    const Harness = () => {
      const [entries, setEntriesState] = React.useState<readonly SessionRowOrderEntry[]>([entry('a')]);
      setEntries = setEntriesState;
      return (
        <SessionRowOrderProvider>
          <Consumer />
          <Segment entries={entries} />
        </SessionRowOrderProvider>
      );
    };

    try {
      await act(async () => root.render(<Harness />));
      expect(consumerRenders).toBe(1);
      const consumerRegistry = consumerCapture.registry;
      if (!consumerRegistry) throw new Error('consumer did not receive the registry');
      expect(consumerRegistry.getOrderedIds()).toEqual(['a']);

      await act(async () => setEntries([entry('b')]));
      expect(consumerRenders).toBe(1);
      expect(consumerRegistry.getOrderedIds()).toEqual(['b']);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

describe('shift-range selection inputs', () => {
  beforeEach(() => {
    const initial = useSessionMultiSelectStore.getInitialState();
    useSessionMultiSelectStore.setState(initial, true);
  });

  test('consumes registry order across mounted and unmounted rows', () => {
    const registry = createSessionRowOrderRegistry();
    registry.register('pinned-recent', { order: 0, entries: [entry('pinned')] });
    registry.register('project-section', {
      order: 1000,
      entries: Array.from({ length: 500 }, (_, index) => entry(`row-${index}`)),
    });

    const orderedIds = toSessionRowOrderIds(registry.getOrderedEntries());
    const descendantsById = new Map([['row-10', ['row-10-child']]]);
    useSessionMultiSelectStore.getState().setRange('row-0', 'row-10', orderedIds, 'project-a', descendantsById);

    const state = useSessionMultiSelectStore.getState();
    expect(state.anchorId).toBe('row-0');
    expect(state.selectedIds.has('pinned')).toBe(false);
    expect(state.selectedIds.has('row-0')).toBe(true);
    expect(state.selectedIds.has('row-10')).toBe(true);
    expect(state.selectedIds.has('row-10-child')).toBe(true);
    expect(state.selectedIds.has('row-11')).toBe(false);
    expect(state.selectedIds.size).toBe(12);
  });

  test('uses the first registered row when the stored anchor is no longer registered', () => {
    const registry = createSessionRowOrderRegistry();
    registry.register('section', { order: 1000, entries: [entry('first'), entry('second'), entry('third')] });

    const orderedIds = toSessionRowOrderIds(registry.getOrderedEntries());
    useSessionMultiSelectStore.getState().setRange('removed', 'second', orderedIds, 'project-a');

    const state = useSessionMultiSelectStore.getState();
    expect(state.anchorId).toBe('first');
    expect([...state.selectedIds].sort()).toEqual(['first', 'second']);
  });
});
