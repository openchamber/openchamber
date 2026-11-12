import type { EditPermissionMode } from "../types/sessionTypes";

type PermissionEffect = 'allow' | 'deny' | 'ask';

/** One entry of an OpenCode 2 ruleset; evaluation is last-match-wins. */
type PermissionRule = {
    action: string;
    resource: string;
    effect: PermissionEffect;
};

type ConfigStoreAgent = {
    name: string;
    permissions?: PermissionRule[];
};

type ConfigStoreState = {
    agents?: ConfigStoreAgent[];
};

type ConfigStoreRef = { getState?: () => ConfigStoreState };

const resolveConfigStore = (): ConfigStoreRef | undefined => {
    if (typeof window === 'undefined') {
        return undefined;
    }
    // SAFETY: `useConfigStore` publishes itself on `window` under this name at
    // module load; the optional property covers the window before it does.
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

/**
 * What the agent's resolved ruleset says about an action with no particular
 * resource. The scan runs backwards because the last matching rule wins.
 */
const resolvePermissionEffect = (ruleset: PermissionRule[] | undefined, action: string): PermissionEffect => {
    if (!ruleset || ruleset.length === 0) {
        return 'ask';
    }

    for (let index = ruleset.length - 1; index >= 0; index -= 1) {
        const rule = ruleset[index];
        if (rule.action === action && rule.resource === '*') {
            return rule.effect;
        }
    }

    for (let index = ruleset.length - 1; index >= 0; index -= 1) {
        const rule = ruleset[index];
        if (rule.action === '*' && rule.resource === '*') {
            return rule.effect;
        }
    }

    return 'ask';
};

export const getAgentDefaultEditPermission = (agentName?: string): EditPermissionMode => {
    const agent = getAgentDefinition(agentName);
    if (!agent) {
        return 'ask';
    }

    return resolvePermissionEffect(agent.permissions, 'edit');
};
