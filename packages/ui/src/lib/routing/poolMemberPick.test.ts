import { describe, expect, test } from 'bun:test';

import type { ModelSelection } from '@/lib/opencode/model';
import { applyPoolPick, POOL_PICK_TIMINGS, poolPickMenuFor, remoteActionFor, type PoolPickTiming } from './poolMemberPick';

const gemini: ModelSelection = { providerID: 'github-copilot', id: 'gemini-4-carbon', variant: 'high' };
const opus: ModelSelection = { providerID: 'github-copilot', id: 'claude-opus-5.5', variant: 'max' };

const pool = (id: string, targets: unknown[]) => ({ id, settings: { opencodeRoute: { targets } } });
const providers = [
    { id: 'github-copilot', models: [{ id: 'gemini-4-carbon' }, { id: 'claude-opus-5.5' }] },
    {
        id: 'opencode-route',
        models: [
            pool('strong-pool', [gemini, opus, { providerID: 'opencode-route', id: 'fast-pool' }]),
            pool('fast-pool', [{ providerID: 'github-copilot', id: 'gemini-4-carbon' }]),
            pool('pattern-pool', []),
        ],
    },
];

// The oracle is the timing table in poolMemberPick.ts's module comment.
const EXPECTED = {
    'next-input': { idle: null, running: null },
    'next-step': { idle: 'switch-session', running: 'switch-session' },
    immediately: { idle: 'switch-session', running: 'restart-turn' },
} satisfies Record<PoolPickTiming, { idle: string | null; running: string | null }>;

const recorder = (fail?: 'switch' | 'restart') => {
    const calls: string[] = [];
    return {
        calls,
        deps: {
            isCurrent: () => true,
            switchSessionModel: async (model: ModelSelection) => {
                calls.push(`switch:${model.id}`);
                if (fail === 'switch') throw new Error('refused');
            },
            restartTurn: async (model: ModelSelection) => {
                calls.push(`restart:${model.id}`);
                if (fail === 'restart') throw new Error('refused');
            },
            selectComposerModel: (model: ModelSelection) => {
                calls.push(`select:${model.id}`);
            },
        },
    };
};

describe('remoteActionFor', () => {
    test('matches the timing table for every timing, idle and running', () => {
        for (const timing of POOL_PICK_TIMINGS) {
            expect(remoteActionFor(timing, false)).toBe(EXPECTED[timing].idle);
            expect(remoteActionFor(timing, true)).toBe(EXPECTED[timing].running);
        }
    });
});

describe('applyPoolPick', () => {
    test('runs the session change first, then the composer, for every timing', async () => {
        for (const timing of POOL_PICK_TIMINGS) {
            for (const running of [false, true]) {
                const { calls, deps } = recorder();
                await applyPoolPick(gemini, timing, running, deps);
                const action = remoteActionFor(timing, running);
                const remote = action === 'switch-session' ? ['switch:gemini-4-carbon'] : action === 'restart-turn' ? ['restart:gemini-4-carbon'] : [];
                expect(calls).toEqual([...remote, 'select:gemini-4-carbon']);
            }
        }
    });

    test('a refused switch or restart leaves the composer selection alone', async () => {
        const switching = recorder('switch');
        await expect(applyPoolPick(gemini, 'next-step', true, switching.deps)).rejects.toThrow('refused');
        expect(switching.calls).toEqual(['switch:gemini-4-carbon']);

        const restarting = recorder('restart');
        await expect(applyPoolPick(gemini, 'immediately', true, restarting.deps)).rejects.toThrow('refused');
        expect(restarting.calls).toEqual(['restart:gemini-4-carbon']);
    });

    test('a stale scope never changes the composer or starts another request', async () => {
        const { calls, deps } = recorder();
        let current = true;
        await applyPoolPick(gemini, 'next-step', true, {
            ...deps,
            isCurrent: () => current,
            switchSessionModel: async (model) => {
                await deps.switchSessionModel(model);
                current = false;
            },
        });
        expect(calls).toEqual(['switch:gemini-4-carbon']);
        await applyPoolPick(gemini, 'immediately', true, { ...deps, isCurrent: () => false });
        expect(calls).toEqual(['switch:gemini-4-carbon']);
    });
});

describe('poolPickMenuFor', () => {
    test('a selected pool offers its concrete members with their variants, not nested pools', () => {
        expect(poolPickMenuFor(providers, 'opencode-route', 'strong-pool')).toEqual({
            kind: 'members',
            poolID: 'strong-pool',
            members: [gemini, opus],
        });
    });

    test('a directly picked model offers every pool that lists it', () => {
        expect(poolPickMenuFor(providers, 'github-copilot', 'gemini-4-carbon')).toEqual({
            kind: 'return',
            pools: ['strong-pool', 'fast-pool'],
        });
        expect(poolPickMenuFor(providers, 'github-copilot', 'claude-opus-5.5')).toEqual({ kind: 'return', pools: ['strong-pool'] });
    });

    test('offers nothing for a pool without listed members, a model in no pool, or no selection', () => {
        expect(poolPickMenuFor(providers, 'opencode-route', 'pattern-pool')).toEqual({ kind: 'none' });
        expect(poolPickMenuFor(providers, 'openai', 'gpt-6-luna')).toEqual({ kind: 'none' });
        expect(poolPickMenuFor(providers, '', '')).toEqual({ kind: 'none' });
    });

    test('hides pool members that are disabled or missing from the catalog', () => {
        const route = providers[1];
        if (!route) throw new Error('missing pool provider');
        expect(poolPickMenuFor([
            { id: 'github-copilot', models: [{ id: 'gemini-4-carbon', enabled: false }, { id: 'claude-opus-5.5' }] },
            route,
        ], 'opencode-route', 'strong-pool')).toEqual({ kind: 'members', poolID: 'strong-pool', members: [opus] });
    });
});
