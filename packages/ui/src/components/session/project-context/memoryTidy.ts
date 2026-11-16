import type { AgentMemoryEntry, AgentMemoryScope } from '@/lib/agentMemoryApi';
import { captureDefaultSendSelection } from '@/lib/defaultSendSelection';
import { loadMagicPrompts, type MagicPromptId } from '@/lib/magicPrompts';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const formatDate = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);

const formatEntry = (entry: AgentMemoryEntry, scope: AgentMemoryScope): string => {
  const meta = [
    `memoryId: ${entry.id}`,
    `scope: ${scope}`,
    `type: ${entry.type}`,
    `created ${formatDate(entry.createdAt)}`,
    `updated ${formatDate(entry.updatedAt)}`,
    ...(entry.flagged ? ['flagged'] : []),
  ].join(' | ');
  return `#### ${entry.title}\n${meta}\n\n${entry.body}`;
};

const formatScope = (heading: string, entries: AgentMemoryEntry[], scope: AgentMemoryScope): string => (
  entries.length === 0
    ? `### ${heading}\n\nNo entries.`
    : `### ${heading}\n\n${entries.map((entry) => formatEntry(entry, scope)).join('\n\n')}`
);

/**
 * The whole store, bodies included, for the tidy-up instructions. Handing the
 * agent every entry up front saves it a read call per entry.
 */
export const formatMemoryForTidy = (memory: { global: AgentMemoryEntry[]; project: AgentMemoryEntry[] }): string => [
  formatScope('About the user (scope: global)', memory.global, 'global'),
  formatScope('About this project (scope: project)', memory.project, 'project'),
].join('\n\n');

type MemoryTidyOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'no-model' | 'create-failed' | 'send-failed' };

/**
 * Starts a session in the project that tidies the memory on its own, with the
 * default model and agent, and makes it the current session.
 */
export const startMemoryTidy = (input: {
  projectPath: string;
  title: string;
  memory: { global: AgentMemoryEntry[]; project: AgentMemoryEntry[] };
}): Promise<MemoryTidyOutcome> => startMemorySession({
  projectPath: input.projectPath,
  title: input.title,
  prompts: ['memory.tidy.visible', 'memory.tidy.instructions'],
  entries: formatMemoryForTidy(input.memory),
});

/**
 * Starts a session that moves the project entries the last dreaming pass
 * found belong in the project's agent docs, in a session the user watches:
 * the edits stay in the working tree for them to review.
 */
export const startMemoryToDocs = (input: {
  projectPath: string;
  title: string;
  entries: AgentMemoryEntry[];
}): Promise<MemoryTidyOutcome> => startMemorySession({
  projectPath: input.projectPath,
  title: input.title,
  prompts: ['memory.toDocs.visible', 'memory.toDocs.instructions'],
  entries: input.entries.map((entry) => formatEntry(entry, 'project')).join('\n\n'),
});

const startMemorySession = async (input: {
  projectPath: string;
  title: string;
  prompts: [MagicPromptId, MagicPromptId];
  entries: string;
}): Promise<MemoryTidyOutcome> => {
  const selection = captureDefaultSendSelection();
  if (!selection) return { ok: false, reason: 'no-model' };

  // Throws when the prompts cannot be read; nothing has been created yet.
  const prompts = await loadMagicPrompts(input.projectPath);
  const visiblePrompt = prompts.render(input.prompts[0]);
  const instructions = prompts.render(input.prompts[1], { memory_entries: input.entries });

  const store = useSessionUIStore.getState();
  const session = await store.createSession(input.title, input.projectPath, undefined, {
    model: { providerID: selection.providerID, id: selection.modelID, variant: selection.variant },
    agent: selection.agentName,
  });
  if (!session?.id) return { ok: false, reason: 'create-failed' };

  const directory = session.directory ?? input.projectPath;
  store.initializeNewOpenChamberSession(session.id, useConfigStore.getState().agents ?? []);
  store.setCurrentSession(session.id, directory);
  try {
    await store.sendMessage(
      visiblePrompt,
      selection.providerID,
      selection.modelID,
      selection.agentName,
      undefined,
      undefined,
      [{ synthetic: true, text: instructions }],
      selection.variant,
      undefined,
      { sessionId: session.id, directory },
    );
  } catch {
    return { ok: false, reason: 'send-failed' };
  }
  return { ok: true, sessionId: session.id };
};
