import { strict as assert } from 'node:assert';
import test from 'node:test';

import { deriveTurnHistorySignals } from './historySignals';
import type { SessionMemoryState } from '@/stores/types/sessionTypes';

test('deriveTurnHistorySignals honors buffered turns even when history complete', () => {
    const memoryState: SessionMemoryState = {
        lastAccessedAt: Date.now(),
        viewportAnchor: 0,
        isStreaming: false,
        historyComplete: true,
        hasMoreAbove: false,
        hasMoreTurnsAbove: false,
        backgroundMessageCount: 0,
    };

    const signals = deriveTurnHistorySignals({
        memoryState,
        loadedMessageCount: 80,
        loadedTurnCount: 10,
        turnStart: 3,
        defaultHistoryLimit: 60,
    });

    assert.equal(signals.hasBufferedTurns, true, 'turnStart > 0 should expose buffered turns');
    assert.equal(signals.hasMoreAboveTurns, false, 'historyComplete should suppress load-more signal');
    assert.equal(signals.canLoadEarlier, true, 'buffered turns should still allow reveal action');
});

test('deriveTurnHistorySignals keeps hasMoreAbove for background metadata', () => {
    const memoryState: SessionMemoryState = {
        lastAccessedAt: Date.now(),
        viewportAnchor: 0,
        isStreaming: false,
        historyComplete: false,
        hasMoreAbove: true,
        hasMoreTurnsAbove: true,
        loadedTurnCount: 8,
        backgroundMessageCount: 12,
    };

    const signals = deriveTurnHistorySignals({
        memoryState,
        loadedMessageCount: 40,
        loadedTurnCount: 8,
        turnStart: 0,
        defaultHistoryLimit: 200,
    });

    assert.equal(signals.hasMoreAboveTurns, true, 'explicit turn metadata should drive load-more availability');
    assert.equal(signals.canLoadEarlier, true, 'background metadata should keep navigation path active');
});
