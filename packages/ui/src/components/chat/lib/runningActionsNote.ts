/**
 * Tells the agent which project actions the user has running.
 *
 * An agent that does not know the app is already up starts a second copy of
 * the stack, which often takes the running one down. So a prompt carries a
 * short note about the running actions that open a page in the browser. The
 * note rides with a message the user sends and never starts a turn of its own.
 * Each session hears about a run once, and once more when that run is gone;
 * an action started and stopped between two messages is never mentioned.
 */
import { AUTO_DISCOVER_ACTION_ID } from '@/lib/projectActions';
import type { ProjectActionsRunner } from '@/components/layout/useProjectActionsRunner';
import { useTerminalStore } from '@/stores/useTerminalStore';

export type RunningAction = {
  executionId: string;
  name: string;
  /** Empty when the app found the command itself and the list does not hold it. */
  command: string;
  directory: string;
  /** The address the action opened, once known. */
  url: string | null;
};

/** What each session was last told is running: execution id to action name. Lost on reload, which repeats a note once. */
const toldBySession = new Map<string, Map<string, string>>();

type RunningActionsNote = {
  /** The note to send, or null when the session knows everything already. */
  text: string | null;
  /** Records the note as delivered to the session that took the message. */
  commit: (sessionId: string) => void;
};

const describe = (action: RunningAction): string => {
  const command = action.command ? ` (\`${action.command}\`)` : '';
  const url = action.url ? `, open at ${action.url}` : '';
  return `- "${action.name}"${command} in ${action.directory}${url}`;
};

export const planRunningActionsNote = (sessionId: string | null, running: readonly RunningAction[]): RunningActionsNote => {
  const told = (sessionId ? toldBySession.get(sessionId) : undefined) ?? new Map<string, string>();
  const started = running.filter((action) => !told.has(action.executionId));
  const runningIds = new Set(running.map((action) => action.executionId));
  const stopped = [...told].filter(([executionId]) => !runningIds.has(executionId)).map(([, name]) => name);

  const lines: string[] = [];
  if (started.length > 0) {
    lines.push(
      'The user started these project actions from the app, and they are running now. Use what they serve instead of starting the same thing again, and leave them running:',
      ...started.map(describe),
    );
  }
  if (stopped.length > 0) {
    lines.push(`These project actions are no longer running: ${stopped.map((name) => `"${name}"`).join(', ')}.`);
  }

  return {
    text: lines.length > 0 ? `<project-actions>\n${lines.join('\n')}\n</project-actions>` : null,
    commit: (targetSessionId) => {
      if (running.length === 0) toldBySession.delete(targetSessionId);
      else toldBySession.set(targetSessionId, new Map(running.map((action) => [action.executionId, action.name])));
    },
  };
};

/** The running actions set to open a page in the browser, for the folder the composer works in. */
export const collectRunningActions = (runner: ProjectActionsRunner | null): RunningAction[] => {
  if (!runner?.available) return [];
  const running: RunningAction[] = [];
  for (const action of runner.actions) {
    if (action.autoOpenUrl !== true && action.id !== AUTO_DISCOVER_ACTION_ID) continue;
    const run = runner.runOf(action);
    if (!run || run.status === 'stopping') continue;
    const tab = useTerminalStore.getState().getDirectoryState(run.directory)?.tabs.find((candidate) => candidate.id === run.tabId);
    running.push({
      executionId: run.executionId,
      name: action.name,
      command: action.command,
      directory: run.directory,
      url: tab?.previewUrl ?? null,
    });
  }
  return running;
};
