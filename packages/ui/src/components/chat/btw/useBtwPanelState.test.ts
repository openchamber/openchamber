import { describe, expect, test } from 'bun:test';

import { btwHoldsDock, type BtwPanelState } from './useBtwPanelState';

const panel = (patch: Partial<BtwPanelState>): BtwPanelState => ({
    parentPromoted: false,
    btwSessionId: 'ses_fork',
    btwDirectory: '/repo',
    boundaryMessageID: null,
    collapsed: false,
    creating: false,
    pending: false,
    ...patch,
});

describe('btwHoldsDock', () => {
    test('an open BTW keeps the dock over the parent request', () => {
        expect(btwHoldsDock(panel({}), true)).toBe(true);
        expect(btwHoldsDock(panel({ btwSessionId: null, btwDirectory: null, pending: true }), true)).toBe(true);
    });

    test('a collapsed BTW gives the dock to the parent request', () => {
        expect(btwHoldsDock(panel({ collapsed: true }), true)).toBe(false);
        expect(btwHoldsDock(panel({ btwSessionId: null, btwDirectory: null, pending: true, collapsed: true }), true)).toBe(false);
    });

    test('a collapsed BTW keeps its strip when the parent asks nothing', () => {
        expect(btwHoldsDock(panel({ collapsed: true }), false)).toBe(true);
    });

    test('no BTW holds nothing', () => {
        expect(btwHoldsDock(panel({ btwSessionId: null, btwDirectory: null }), false)).toBe(false);
    });
});
