import { describe, expect, test } from 'bun:test';

import type { ModelSelection } from '@/lib/opencode/model';
import { applyPoolPick, isPinnedMember, pinActionFor, POOL_PICK_TIMINGS, poolPickMenuFor, returnActionFor, type PoolPickTiming } from './poolMemberPick';

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
const RETURN_EXPECTED = {
    'next-input': { idle: null, running: null },
    'next-step': { idle: 'switch-session', running: 'switch-session' },
    immediately: { idle: 'switch-session', running: 'restart-turn' },
} satisfies Record<PoolPickTiming, { idle: string | null; running: string | null }>;
const PIN_EXPECTED = {
    'next-input': { idle: 'pin', running: 'pin-when-idle' },
    'next-step': { idle: 'pin', running: 'pin' },
    immediately: { idle: 'pin', running: 'pin-and-restart' },
} satisfies Record<PoolPickTiming, { idle: string; running: string }>;

const recorder = (options: { fail?: 'switch' | 'restart' | 'pin'; idle?: boolean } = {}) => {
    const calls: string[] = [];
    return {
        calls,
        deps: {
            isCurrent: () => true,
            whenIdle: async () => {
                calls.push('wait-idle');
                return options.idle ?? true;
            },
            setPin: async (poolID: string, member: ModelSelection | null) => {
                calls.push(`pin:${poolID}:${member?.id ?? 'none'}`);
                if (options.fail === 'pin') throw new Error('refused');
            },
            switchSessionModel: async (model: ModelSelection) => {
                calls.push(`switch:${model.id}`);
                if (options.fail === 'switch') throw new Error('refused');
            },
            restartTurn: async (model: ModelSelection) => {
                calls.push(`restart:${model.id}`);
                if (options.fail === 'restart') throw new Error('refused');
            },
            selectComposerModel: (model: ModelSelection) => {
                calls.push(`select:${model.id}`);
            },
        },
    };
};

const pinGemini = { kind: 'pin', poolID: 'strong-pool', member: gemini } as const;
const backToPool = { kind: 'return', poolID: 'strong-pool' } as const;

describe('timing tables', () => {
    test('match the module comment for every timing, idle and running', () => {
        for (const timing of POOL_PICK_TIMINGS) {
            expect(returnActionFor(timing, false)).toBe(RETURN_EXPECTED[timing].idle);
            expect(returnActionFor(timing, true)).toBe(RETURN_EXPECTED[timing].running);
            expect(pinActionFor(timing, false)).toBe(PIN_EXPECTED[timing].idle);
            expect(pinActionFor(timing, true)).toBe(PIN_EXPECTED[timing].running);
        }
    });
});

describe('applyPoolPick', () => {
    test('a pin keeps the session and the composer on the pool, for every timing', async () => {
        for (const timing of POOL_PICK_TIMINGS) {
            for (const running of [false, true]) {
                const { calls, deps } = recorder();
                await applyPoolPick(pinGemini, timing, running, deps);
                const action = pinActionFor(timing, running);
                expect(calls).toEqual([
                    ...(action === 'pin-when-idle' ? ['wait-idle'] : []),
                    'pin:strong-pool:gemini-4-carbon',
                    ...(action === 'pin-and-restart' ? ['restart:strong-pool'] : []),
                ]);
            }
        }
    });

    test('clearing a pin sends no member', async () => {
        const { calls, deps } = recorder();
        await applyPoolPick({ kind: 'pin', poolID: 'strong-pool', member: null }, 'next-step', false, deps);
        expect(calls).toEqual(['pin:strong-pool:none']);
    });

    test('a pin waiting for the turn to finish is dropped when the scope goes first', async () => {
        const { calls, deps } = recorder({ idle: false });
        await applyPoolPick(pinGemini, 'next-input', true, deps);
        expect(calls).toEqual(['wait-idle']);
    });

    test('a refused pin starts no restart', async () => {
        const { calls, deps } = recorder({ fail: 'pin' });
        await expect(applyPoolPick(pinGemini, 'immediately', true, deps)).rejects.toThrow('refused');
        expect(calls).toEqual(['pin:strong-pool:gemini-4-carbon']);
    });

    test('going back to a pool switches the session first, then the composer, for every timing', async () => {
        for (const timing of POOL_PICK_TIMINGS) {
            for (const running of [false, true]) {
                const { calls, deps } = recorder();
                await applyPoolPick(backToPool, timing, running, deps);
                const action = returnActionFor(timing, running);
                const remote = action === 'switch-session' ? ['switch:strong-pool'] : action === 'restart-turn' ? ['restart:strong-pool'] : [];
                expect(calls).toEqual([...remote, 'select:strong-pool']);
            }
        }
    });

    test('a refused switch or restart leaves the composer selection alone', async () => {
        const switching = recorder({ fail: 'switch' });
        await expect(applyPoolPick(backToPool, 'next-step', true, switching.deps)).rejects.toThrow('refused');
        expect(switching.calls).toEqual(['switch:strong-pool']);

        const restarting = recorder({ fail: 'restart' });
        await expect(applyPoolPick(backToPool, 'immediately', true, restarting.deps)).rejects.toThrow('refused');
        expect(restarting.calls).toEqual(['restart:strong-pool']);
    });

    test('a stale scope never changes the composer or starts another request', async () => {
        const { calls, deps } = recorder();
        let current = true;
        await applyPoolPick(backToPool, 'next-step', true, {
            ...deps,
            isCurrent: () => current,
            switchSessionModel: async (model) => {
                await deps.switchSessionModel(model);
                current = false;
            },
        });
        expect(calls).toEqual(['switch:strong-pool']);
        await applyPoolPick(pinGemini, 'immediately', true, { ...deps, isCurrent: () => false });
        expect(calls).toEqual(['switch:strong-pool']);
    });
});

describe('isPinnedMember', () => {
    test('matches provider, model and variant', () => {
        expect(isPinnedMember(gemini, gemini)).toBe(true);
        expect(isPinnedMember({ ...gemini, variant: 'low' }, gemini)).toBe(false);
        expect(isPinnedMember({ providerID: 'p', id: 'm' }, { providerID: 'p', id: 'm', variant: null })).toBe(true);
        expect(isPinnedMember(undefined, gemini)).toBe(false);
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
