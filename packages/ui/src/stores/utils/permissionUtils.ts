import type { EditPermissionMode } from "../types/sessionTypes";

type PermissionAction = 'allow' | 'deny' | 'ask';

type PermissionRule = {
    permission: string;
    pattern: string;
    action: PermissionAction;
};

type ConfigStoreAgent = {
    name: string;
    permission?: PermissionRule[];
};

type ConfigStoreState = {
    agents?: ConfigStoreAgent[];
};

type ConfigStoreRef = { getState?: () => ConfigStoreState };

const resolveConfigStore = (): ConfigStoreRef | undefined => {
    if (typeof window === 'undefined') {
        return undefined;
    }
    return (window as { __zustand_config_store__?: ConfigStoreRef }).__zustand_config_store__;
};

const getAgentDefinition = (agentName?: string): ConfigStoreAgent | undefined => {
    if (!agentName) {
        return undefined;
    }

    try {
        const configStore = resolveConfigStore();
        if (configStore?.getState) {
            const state = configStore.getState();
            return state.agents?.find?.((agent) => agent.name === agentName);
        }
    } catch {
        /* ignored */
    }

    return undefined;
};

const resolvePermissionAction = (ruleset: PermissionRule[] | undefined, permission: string): PermissionAction => {
    if (!ruleset || ruleset.length === 0) {
        return 'ask';
    }

    // Prefer explicit rule for the tool at wildcard pattern.
    for (let index = ruleset.length - 1; index >= 0; index -= 1) {
        const rule = ruleset[index];
        if (rule.permission === permission && rule.pattern === '*') {
            return rule.action;
        }
    }

    // Fall back to global wildcard.
    for (let index = ruleset.length - 1; index >= 0; index -= 1) {
        const rule = ruleset[index];
        if (rule.permission === '*' && rule.pattern === '*') {
            return rule.action;
        }
    }

    return 'ask';
};

export const getAgentDefaultEditPermission = (agentName?: string): EditPermissionMode => {
    const agent = getAgentDefinition(agentName);
    if (!agent) {
        return 'ask';
    }

    const action = resolvePermissionAction(agent.permission, 'edit');
    return action;
};