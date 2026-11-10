import { describe, expect, test } from 'bun:test';
import type { Agent } from '@/lib/opencode/model';
import { isAgentMissingForDirectory, isAgentMissingFromCatalog } from './agentAvailability';

const catalog = (names: string[], agentsLoaded = true) => ({ agentsLoaded, agents: names.map((name) => ({ name })) });
const agents = (names: string[]): Agent[] => names.map((name) => ({
    id: name, name, displayName: name, mode: 'primary', hidden: false,
    request: { settings: {}, headers: {}, body: {} }, permissions: [],
}));

describe('isAgentMissingFromCatalog (#5522)', () => {
    test('marks an agent the loaded catalog of the folder does not list', () => {
        expect(isAgentMissingFromCatalog(catalog(['build', 'plan']), 'stock')).toBe(true);
    });

    test('leaves a listed agent, a loading catalog and no agent unmarked', () => {
        expect(isAgentMissingFromCatalog(catalog(['build', 'stock']), 'stock')).toBe(false);
        expect(isAgentMissingFromCatalog(catalog([], false), 'stock')).toBe(false);
        expect(isAgentMissingFromCatalog(catalog(['build']), undefined)).toBe(false);
    });
});

describe('isAgentMissingForDirectory', () => {
    // The main chat is in a chat folder; a pinned chat is in the project that defines `stock`.
    const state = {
        activeDirectoryKey: '/chats/one',
        agents: agents(['build', 'plan']),
        agentsLoaded: true,
        providersLoaded: true,
        directoryScoped: {
            '/repo/project': {
                agents: agents(['build', 'plan', 'stock']), agentsLoaded: true,
                providers: [], agentModelSelections: {}, defaultProviders: {},
                selectedProviderId: '', currentProviderId: '', currentModelId: '', currentAgentName: undefined,
            },
            '/repo/cold': {
                agents: [], agentsLoaded: false,
                providers: [], agentModelSelections: {}, defaultProviders: {},
                selectedProviderId: '', currentProviderId: '', currentModelId: '', currentAgentName: undefined,
            },
        },
    };

    test('checks each composer against its own folder catalog', () => {
        expect(isAgentMissingForDirectory(state, '/chats/one', 'stock')).toBe(true);
        expect(isAgentMissingForDirectory(state, '/repo/project', 'stock')).toBe(false);
    });

    test('a folder whose catalog has not loaded, and a draft, use what is known', () => {
        expect(isAgentMissingForDirectory(state, '/repo/cold', 'stock')).toBe(false);
        expect(isAgentMissingForDirectory(state, undefined, 'stock')).toBe(true);
    });
});
