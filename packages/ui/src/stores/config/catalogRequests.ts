import { opencodeClient } from '@/lib/opencode/client';
import { fromDirectoryKey, toConfigDirectoryKey } from './directories';
import { captureConfigRuntimeContext, type ConfigRuntimeContext } from './runtime';
import { _agentsLoadedAt } from './catalogLifecycle';
import { useConfigStore } from '../useConfigStore';

export const _inFlightProviders = new Map<string, Promise<void>>();
export const _inFlightAgents = new Map<string, Promise<boolean>>();
export const _agentsLoadGeneration = new Map<string, number>();

export const getConfigLoadKey = (context: ConfigRuntimeContext, directoryKey: string): string => (
    JSON.stringify([context.generation, context.runtimeKey, directoryKey])
);

export const invalidateConfigAgentsLoad = (directory?: string | null): void => {
    const runtimeContext = captureConfigRuntimeContext();
    const directoryKey = toConfigDirectoryKey(directory ?? fromDirectoryKey(useConfigStore.getState().activeDirectoryKey));
    const inFlightKey = getConfigLoadKey(runtimeContext, directoryKey);
    _agentsLoadedAt.delete(directoryKey);
    _agentsLoadGeneration.set(inFlightKey, (_agentsLoadGeneration.get(inFlightKey) ?? 0) + 1);
    _inFlightAgents.delete(inFlightKey);
    opencodeClient.invalidateAgentList(fromDirectoryKey(directoryKey));
};
