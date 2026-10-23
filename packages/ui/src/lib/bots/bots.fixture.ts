import type { Session } from '@/lib/opencode/model';
import { newBotDraft, type BotsConfig } from './config';
import type { BotItem } from './items';

export const configuredBot = () => ({ ...newBotDraft(), id: 'bot-1', name: 'Repository bot', mission: 'Maintain the repository' });
export const botsConfig = (): BotsConfig => ({ concurrency: 2, retentionDays: 90, definitions: [configuredBot()] });
export const botItem = (patch: Partial<BotItem> = {}): BotItem => ({
  id: 'item-1', botId: 'bot-1', source: { kind: 'manual', id: 'source-1' }, title: 'Repair parser', description: '',
  state: 'queued', revision: 0, createdAt: 1, updatedAt: 1, owner: null, sessions: {}, evidence: [],
  proof: { status: 'absent', reason: 'Test unavailable' },
  tokens: { total: 0, byStage: { investigation: 0, fixing: 0, judge: 0 }, byDay: {} },
  transitions: [], effects: [], ...patch,
});
export const botSession = (id: string, patch: Partial<Session> = {}): Session => ({
  id, projectID: 'project-1', directory: '/repo', title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  ...patch,
});
