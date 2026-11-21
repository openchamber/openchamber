import { expect, test } from 'bun:test';
import { dict as en } from './en';
import { dict as de } from './de';
import { dict as fr } from './fr';
import { dict as nl } from './nl';
import { dict as es } from './es';
import { dict as ja } from './ja';
import { dict as ptBR } from './pt-BR';
import { dict as uk } from './uk';
import { dict as ko } from './ko';
import { dict as pl } from './pl';
import { dict as zhCN } from './zh-CN';
import { dict as zhTW } from './zh-TW';
import { dict as tr } from './tr';
import { dict as ar } from './ar';
import { dict as he } from './he';

const keys = [
  'sessions.scheduledTasks.dialog.description',
  'sessions.scheduledTasks.dialog.status.queued',
  'sessions.scheduledTasks.dialog.status.sent',
  'sessions.scheduledTasks.dialog.status.skipped',
  'sessions.scheduledTasks.dialog.status.cancelled',
  'sessions.scheduledTasks.editor.description',
  'sessions.scheduledTasks.editor.sessionMode',
  'sessions.scheduledTasks.editor.newSession',
  'sessions.scheduledTasks.editor.existingSession',
  'sessions.scheduledTasks.editor.targetSession',
  'sessions.scheduledTasks.editor.targetHint',
  'sessions.scheduledTasks.editor.targetRequired',
  'sessions.scheduledTasks.editor.target.search',
  'sessions.scheduledTasks.editor.target.empty',
  'sessions.scheduledTasks.editor.target.noMatch',
  'sessions.scheduledTasks.editor.target.subagentOf',
  'sessions.scheduledTasks.editor.target.keepTyping',
  'sessions.scheduledTasks.dialog.loopFile.enableOnThisComputer',
  'sessions.scheduledTasks.dialog.loopFile.changedSinceEnabled',
] as const;

test('scheduled task session choices and outcomes are translated in every catalog', () => {
  for (const catalog of [de, fr, nl, es, ja, ptBR, uk, ko, pl, zhCN, zhTW, tr, ar, he]) {
    for (const key of keys) {
      expect(catalog[key]).toBeTruthy();
      expect(catalog[key]).not.toBe(en[key]);
    }
  }
});

test('a subagent target names its parent in every catalog', () => {
  for (const catalog of [en, de, fr, nl, es, ja, ptBR, uk, ko, pl, zhCN, zhTW, tr, ar, he]) {
    expect(catalog['sessions.scheduledTasks.editor.target.subagentOf']).toContain('{parent}');
    expect(catalog['sessions.scheduledTasks.editor.target.subagent']).toBeTruthy();
  }
});

test('scheduled queue outcomes sit beside the legacy status keys', () => {
  const statuses = ['success', 'error', 'running', 'idle', 'queued', 'sent', 'skipped', 'cancelled'];
  for (const catalog of [en, de, fr, nl, es, ja, ptBR, uk, ko, pl, zhCN, zhTW, tr, ar, he]) {
    const catalogKeys = Object.keys(catalog);
    const start = catalogKeys.indexOf('sessions.scheduledTasks.dialog.status.success');
    expect(catalogKeys.slice(start, start + statuses.length)).toEqual(statuses.map((status) => `sessions.scheduledTasks.dialog.status.${status}`));
  }
});
