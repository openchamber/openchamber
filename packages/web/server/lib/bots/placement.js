import { z } from 'zod';
import { createBotAdapterState } from './adapter-state.js';
import { BotServiceError } from './services/contracts.js';

const text = z.string().min(1);
const placementSchema = z.object({ version: z.literal(1), projectId: text, itemId: text,
  botId: text, hostDirectory: text, isolated: z.boolean() }).strict();
const runSchema = z.object({ projectId: text, itemId: text, directory: text,
  stage: z.enum(['investigation', 'fixing', 'judge']), dispatchedAt: z.number(),
  bot: z.object({ id: text, isolated: z.boolean() }) });
const refuse = () => { throw new BotServiceError('BOT_PLACEMENT_MISMATCH', 'Repair the recorded execution placement before resuming this item.'); };

/** An item's first captured execution decides its runtime for every later stage. */
export function createBotPlacement({ dataDir, journal, isolated, getSpaceArchive = () => null }) {
  const records = createBotAdapterState({ dataDir, name: 'placements', schema: placementSchema });
  const resolve = async ({ projectId, itemId, bot, directory, sessionId, sessions = {}, capturedRun }) => {
    const key = { projectId, itemId };
    return records.own(key, async () => {
      const previous = await records.read(key);
      if (previous) {
        if (previous.botId !== bot.id || previous.hostDirectory !== directory) refuse();
        return previous;
      }
      const binding = await isolated.readBinding(key);
      const execution = await journal.read(projectId, itemId);
      const runs = Object.values(execution.data.runs ?? {}).map((entry) => runSchema.parse(entry));
      if (capturedRun) runs.push(runSchema.parse(capturedRun));
      runs.sort((left, right) => left.dispatchedAt - right.dispatchedAt);
      const first = runs[0];
      if (!binding && !first && (sessionId || Object.keys(sessions).length)) refuse();
      if (first && (first.projectId !== projectId || first.itemId !== itemId || first.bot.id !== bot.id || first.directory !== directory)) refuse();
      if (binding && (binding.botId !== bot.id || binding.hostDirectory !== directory || first && !first.bot.isolated)) refuse();
      return records.write(key, { version: 1, ...key, botId: bot.id, hostDirectory: directory,
        isolated: binding ? true : first ? first.bot.isolated : bot.isolated });
    });
  };
  const sessionDirectories = async ({ projectId, item }) => {
    if (!Object.keys(item.sessions).length || !item.worktree) return {};
    const placement = await resolve({ projectId, itemId: item.id, bot: { id: item.botId }, directory: item.worktree, sessions: item.sessions });
    if (!placement.isolated) return Object.fromEntries(Object.values(item.sessions).map((id) => [id, placement.hostDirectory]));
    const binding = await isolated.readBinding({ projectId, itemId: item.id });
    if (!binding || binding.botId !== item.botId || binding.hostDirectory !== placement.hostDirectory) refuse();
    return Object.fromEntries(Object.entries(item.sessions).flatMap(([stage, id]) => {
      const session = Object.values(binding.sessions).find((entry) => entry.id === id && entry.stage === stage);
      if (!session || session.directory !== binding.directory) return [];
      const directory = binding.state === 'removed' ? getSpaceArchive()?.sessionDirectory(binding.spaceId, id) : session.directory;
      return directory ? [[id, directory]] : [];
    }));
  };
  return { resolve, sessionDirectories, read: records.read };
}
