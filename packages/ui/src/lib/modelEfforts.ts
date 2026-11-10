import { useUIStore } from '@/stores/useUIStore';

/**
 * A thinking level in the same three states the selection store uses: a
 * variant name, `null` for an explicit Default, and `undefined` for no choice.
 */
export type EffortChoice = string | null | undefined;

type EffortAgentPin = {
  name?: string;
  id?: string;
  model?: { providerID?: string; id?: string; variant?: string };
};

export const effortMemoryKey = (providerID: string, modelID: string): string => `${providerID}/${modelID}`;

const effortRevisions = new Map<string, number>();
export const readEffortRevision = (providerID: string, modelID: string): number =>
  effortRevisions.get(effortMemoryKey(providerID, modelID)) ?? 0;

/** The last chosen level for this model, across sessions and projects. */
export const readRememberedEffort = (providerID: string, modelID: string): EffortChoice => {
  if (!providerID || !modelID) return undefined;
  return (useUIStore.getState().lastUsedEfforts ?? {})[effortMemoryKey(providerID, modelID)];
};

/**
 * Records a picker choice or a successful composer's sent level.
 * `null` preserves an explicit Default.
 */
export const rememberEffort = (providerID: string, modelID: string, effort: EffortChoice, expectedRevision?: number): void => {
  if (!providerID || !modelID) return;
  const revision = readEffortRevision(providerID, modelID);
  if (expectedRevision !== undefined && revision !== expectedRevision) return;
  // Even choosing the same value supersedes an earlier in-flight send.
  effortRevisions.set(effortMemoryKey(providerID, modelID), revision + 1);
  useUIStore.getState().rememberLastUsedEffort(providerID, modelID, effort ?? null);
};

/**
 * The first source the model offers. A source it no longer offers is skipped,
 * so an old level never blocks a lower-priority one. `null` is an explicit
 * Default and stops the search, because Default is a choice of its own.
 */
export const resolveEffortChoice = (
  sources: readonly EffortChoice[],
  variants: readonly string[],
): EffortChoice => {
  for (const source of sources) {
    if (source === null) return null;
    if (source !== undefined && variants.includes(source)) return source;
  }
  return undefined;
};

/**
 * The level a new session or a model-only tool selection should use: the
 * agent's pin for this model, then its configured level, then its last choice.
 */
export const resolveEffortForModelSelection = ({
  providerID,
  modelID,
  variants,
  agents,
  agentName,
  configuredVariant,
  rememberedEffort = readRememberedEffort(providerID, modelID),
}: {
  providerID: string;
  modelID: string;
  variants: readonly string[];
  agents?: readonly EffortAgentPin[];
  agentName?: string | null;
  configuredVariant?: string | null;
  rememberedEffort?: EffortChoice;
}): EffortChoice => {
  if (variants.length === 0) return undefined;
  const wantedAgent = agentName?.trim() ?? '';
  const agent = wantedAgent
    ? agents?.find((entry) => entry.name === wantedAgent || entry.id === wantedAgent)
    : undefined;
  const agentModel = agent?.model;
  const agentVariant = agentModel?.providerID === providerID && agentModel?.id === modelID
    ? agentModel.variant
    : undefined;
  return resolveEffortChoice(
    [agentVariant, configuredVariant, rememberedEffort],
    variants,
  );
};
