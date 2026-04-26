import type { Agent } from '@opencode-ai/sdk/v2';

export type MobileControlsPanel = 'model' | 'agent' | 'variant' | null;

export const isPrimaryMode = (mode?: string) => mode === 'primary' || mode === 'all' || mode === undefined || mode === null;

export const getCyclablePrimaryAgents = (agents: Agent[]) => agents.filter((agent) => agent.mode === 'primary');

export const getCycledPrimaryAgentName = (
    agents: Agent[],
    currentAgentName: string | undefined,
    direction: 1 | -1 = 1,
) => {
    const primaryAgents = getCyclablePrimaryAgents(agents);
    if (primaryAgents.length <= 1) {
        return null;
    }

    const currentIndex = primaryAgents.findIndex((agent) => agent.name === currentAgentName);
    const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (safeCurrentIndex + direction + primaryAgents.length) % primaryAgents.length;
    return primaryAgents[nextIndex]?.name ?? null;
};

export const capitalizeLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export const getAgentDisplayName = (agents: Agent[], agentName?: string) => {
    if (agentName) {
        const agent = agents.find((entry) => entry.name === agentName);
        return agent ? capitalizeLabel(agent.name) : capitalizeLabel(agentName);
    }

    const primaryAgents = agents.filter((agent) => isPrimaryMode(agent.mode));
    const buildAgent = primaryAgents.find((agent) => agent.name === 'build');
    const fallbackAgent = buildAgent || primaryAgents[0] || agents[0];
    return fallbackAgent ? capitalizeLabel(fallbackAgent.name) : 'Select agent';
};

type ProviderModel = { id?: string; name?: string };

export const getModelDisplayName = (
    provider: { models?: ProviderModel[] } | undefined,
    modelId: string | undefined,
) => {
    if (!provider || !modelId) {
        return 'Not selected';
    }
    const models = Array.isArray(provider.models) ? provider.models : [];
    const model = models.find((entry) => entry.id === modelId);
    if (typeof model?.name === 'string' && model.name.trim().length > 0) {
        return model.name;
    }
    if (typeof model?.id === 'string' && model.id.trim().length > 0) {
        return model.id;
    }
    return modelId;
};

export const formatEffortLabel = (variant?: string) => {
    if (!variant || variant.trim().length === 0) {
        return 'Default';
    }
    const trimmed = variant.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        return trimmed;
    }
    return capitalizeLabel(trimmed);
};

export const DEFAULT_EFFORT_KEY = 'default';

export const serializeEffortVariant = (variant?: string) => {
    const trimmed = typeof variant === 'string' ? variant.trim() : '';
    return trimmed.length > 0 ? trimmed : DEFAULT_EFFORT_KEY;
};

export const parseEffortVariant = (variant: string) => {
    return variant === DEFAULT_EFFORT_KEY ? undefined : variant;
};

const EFFORT_RANKS: Record<string, number> = {
    max: 6,
    maximum: 6,
    xhigh: 5,
    high: 4,
    medium: 3,
    default: 2,
    low: 1,
    min: 0,
    minimal: 0,
};

export const getEffortRank = (variant?: string) => {
    if (!variant || variant.trim().length === 0) {
        return EFFORT_RANKS.default;
    }
    const normalized = variant.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(EFFORT_RANKS, normalized)) {
        return EFFORT_RANKS[normalized];
    }
    const numeric = Number.parseFloat(normalized);
    return Number.isFinite(numeric) ? numeric : 0;
};

export const getQuickEffortOptions = (variants: string[]) => {
    const options = new Map<string, string | undefined>();
    options.set('default', undefined);
    for (const variant of variants) {
        options.set(variant, variant);
    }

    const ordered = Array.from(options.values()).sort((a, b) => getEffortRank(b) - getEffortRank(a));
    if (ordered.length <= 4) {
        return ordered;
    }

    const top = ordered.slice(0, 3);
    const lowest = ordered[ordered.length - 1];
    if (top.some((item) => item === lowest)) {
        return top;
    }
    return [...top, lowest];
};
