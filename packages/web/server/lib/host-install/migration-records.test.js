import { expect, it } from 'vitest';
import { createBotItem, botItemSchema } from '../bots/schema.js';
import { validateOwnerBotsProject as runtimeProject } from '../bots/owner-config.js';
import { botWatchAuthoritySchema } from '../pr-fix-loop/runtime.js';
import { parseQueuedItemInput } from '../message-queue/runtime.js';
import { botNoticeIds } from '../message-queue/bot-notice.js';
import { readBotItem, readBotWatchAuthority, readQueuedItem, validateOwnerBotsProject } from './migration-records.js';

const accepts = (read, value) => { try { read(value); return true; } catch { return false; } };
const item = () => createBotItem({ id: 'i', botId: 'b', source: { kind: 'manual', id: 'original' }, title: 'Work', now: 1 });

it.each(['plain', 'effects', 'future-field', 'bad-state', 'duplicate-effect', 'terminal-missing-time', 'bad-session', 'bad-source', 'oversize-title', 'malformed-effect'])('retains runtime item acceptance for %s without normalizing records', (kind) => {
  const value = item();
  const effect = { key: 'effect', kind: 'git.push', inputDigest: 'a'.repeat(64), authority: { service: 'git', identityId: 'identity', revision: 1, target: 'origin' },
    state: 'outcome-unknown', code: 'lost', createdAt: 1, updatedAt: 2 };
  if (kind === 'effects') value.effects = [effect];
  if (kind === 'future-field') value.future = true;
  if (kind === 'bad-state') value.state = 'unknown';
  if (kind === 'duplicate-effect') value.effects = [effect, effect];
  if (kind === 'terminal-missing-time') value.state = 'done';
  if (kind === 'bad-session') value.sessions = { foreign: 'ses_other' };
  if (kind === 'bad-source') value.source.kind = 'unknown';
  if (kind === 'oversize-title') value.title = 'a'.repeat(100_001);
  if (kind === 'malformed-effect') value.effects = [{ ...effect, state: 'toString' }];
  const before = JSON.stringify(value);
  expect(accepts(readBotItem, value)).toBe(botItemSchema.safeParse(value).success);
  expect(JSON.stringify(value)).toBe(before);
});

it.each(['plain', 'configured', 'duplicate-definition', 'bad-model', 'bad-approval', 'bad-schedule', 'bad-grant', 'embedded-secret'])('retains runtime project acceptance for %s and preserves unknown fields', (kind) => {
  const value = { version: 1, future: ['preserve'], bots: { definitions: [{ id: 'b', name: 'Bot', mission: 'Work' }], approvals: {} }, scheduledTasks: [] };
  const bot = value.bots.definitions[0];
  if (kind === 'configured') Object.assign(bot, { isolated: true, space: { placeId: 'docker', network: { mode: 'allowlist', domains: ['example.com'] },
    grants: [{ kind: 'model', provider: 'provider', upstream: 'http://private.local/v1', secret: { kind: 'env', name: 'MODEL_KEY' } }] },
    models: { fixing: { useDefaults: false, providerID: 'provider', modelID: 'model' } }, limits: { dailyTokens: 5000 },
    discord: { channels: [{ guildId: '123456', channelId: '987654' }] } });
  if (kind === 'duplicate-definition') value.bots.definitions.push(bot);
  if (kind === 'bad-model') bot.models = { fixing: { useDefaults: false } };
  if (kind === 'bad-approval') value.bots.approvals = { '.agents/areas/one.md': 'invalid' };
  if (kind === 'bad-schedule') bot.schedule = { kind: 'weekly', weekdays: [] };
  if (kind === 'bad-grant') bot.space = { grants: [{ kind: 'model', provider: 'provider', upstream: 'https://model.example/?credential=invalid', secret: { kind: 'env', name: 'MODEL_KEY' } }] };
  if (kind === 'embedded-secret') bot.space = { grants: [{ kind: 'model', provider: 'provider', upstream: 'https://model.example', secret: { kind: 'typed', value: 'not-a-real-secret' } }] };
  const before = JSON.stringify(value);
  expect(accepts(validateOwnerBotsProject, value)).toBe(accepts(runtimeProject, value));
  expect(JSON.stringify(value)).toBe(before);
});

it('retains strict private Bot watch authority while preserving its raw record', () => {
  const value = { project: { id: 'p', path: '/project' }, botId: 'b', itemId: 'i', identityId: 'identity', identityRevision: 4,
    publicationBranch: 'task/ONE', target: { repositoryId: 'R_one', owner: 'acme', repo: 'app' } };
  expect(readBotWatchAuthority(value)).toBe(value);
  for (const candidate of [{ ...value, unknown: true }, { ...value, identityRevision: 0 }, { ...value, target: { ...value.target, repo: '' } }]) {
    expect(accepts(readBotWatchAuthority, candidate)).toBe(botWatchAuthoritySchema.safeParse(candidate).success);
  }
});

it.each(['ordinary', 'bot', 'bad-notice', 'attachment', 'bad-context', 'bad-selection', 'bot-model'])('validates captured queue payloads for %s without rewriting IDs or payloads', (kind) => {
  const value = { id: 'queued-user', createdAt: 1, content: 'Display', text: 'Captured text', attachments: [], context: [], sendConfig: { providerID: 'provider', modelID: 'model' } };
  if (['bot', 'bad-notice', 'bot-model'].includes(kind)) {
    const notice = { source: 'openchamber-notice', kind: 'bot', projectId: 'p', itemId: 'i', eventId: 'original-event' };
    const ids = botNoticeIds(notice);
    Object.assign(value, { id: ids.itemId, messageId: ids.messageId, notice, origin: { kind: 'bot', id: 'i' }, sendConfig: {} });
    if (kind === 'bad-notice') value.notice.kind = 'fix-loop';
    if (kind === 'bot-model') value.sendConfig = { providerID: 'provider', modelID: 'model' };
  }
  if (kind === 'attachment') value.attachments.push({ id: 'a', filename: 'a.txt', mimeType: 'text/plain', size: 3, source: 'server', agentPath: '/kept/a.txt', dataUrl: 'data:text/plain;base64,YWJj' });
  if (kind === 'bad-context') value.context.push({ kind: 'context', text: 'Payload' });
  if (kind === 'bad-selection') value.sendConfig = {};
  const before = JSON.stringify(value);
  expect(accepts(readQueuedItem, value)).toBe(accepts(parseQueuedItemInput, value));
  expect(JSON.stringify(value)).toBe(before);
});
