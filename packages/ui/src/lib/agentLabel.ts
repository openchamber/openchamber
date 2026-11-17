import type { Agent } from '@/lib/opencode/model';

export function agentLabel(agent: Pick<Agent, 'name' | 'displayName'>): string {
    const displayName = agent.displayName?.trim();
    if (displayName) return displayName;
    return agent.name.charAt(0).toUpperCase() + agent.name.slice(1);
}
