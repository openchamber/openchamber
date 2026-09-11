import { describe, expect, test } from 'bun:test';
import { linearPanelI18n } from './linear-panel.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const requiredKeys = [
  'contextPanel.mode.linear',
  'contextRail.surface.linear.description',
  'contextPanel.linear.actions.backToList',
  'contextPanel.linear.actions.startSession',
  'contextPanel.linear.actions.closeIssue',
  'contextPanel.linear.actions.closeSearch',
  'contextPanel.linear.label.status',
  'contextPanel.linear.label.team',
  'contextPanel.linear.label.assignee',
  'contextPanel.linear.label.unassigned',
  'contextPanel.linear.label.priority',
  'contextPanel.linear.label.labels',
  'contextPanel.linear.priority.none',
  'contextPanel.linear.priority.urgent',
  'contextPanel.linear.priority.high',
  'contextPanel.linear.priority.medium',
  'contextPanel.linear.priority.low',
  'contextPanel.linear.label.comments',
  'contextPanel.linear.label.statusAria',
  'contextPanel.linear.label.workspace',
  'contextPanel.linear.label.workspaceAria',
  'contextPanel.linear.filter.statusAria',
  'contextPanel.linear.filter.assigneeAria',
  'contextPanel.linear.filter.teamAria',
  'contextPanel.linear.filter.priorityAria',
  'contextPanel.linear.filter.searchAria',
  'contextPanel.linear.filter.clear',
  'contextPanel.linear.filter.clearAria',
  'contextPanel.linear.filter.status.all',
  'contextPanel.linear.filter.status.backlog',
  'contextPanel.linear.filter.status.todo',
  'contextPanel.linear.filter.status.started',
  'contextPanel.linear.filter.status.inReview',
  'contextPanel.linear.filter.status.completed',
  'contextPanel.linear.filter.status.canceled',
  'contextPanel.linear.filter.status.duplicate',
  'contextPanel.linear.filter.assignee.any',
  'contextPanel.linear.filter.assignee.me',
  'contextPanel.linear.filter.team.all',
  'contextPanel.linear.filter.priority.all',
  'contextPanel.linear.empty.noDescription',
  'contextPanel.linear.empty.noComments',
  'contextPanel.linear.empty.noMatchingIssues',
  'contextPanel.linear.loading.issue',
  'contextPanel.linear.toast.statusUpdated',
  'contextPanel.linear.toast.statusUpdateFailed',
  'contextPanel.linear.toast.closeFailed',
  'contextPanel.linear.toast.workspaceSwitched',
  'contextPanel.linear.toast.workspaceSwitchFailed',
  'contextPanel.linear.error.noCompletedState',
] as const;

const matchingEnglishAllowed = new Set<string>([
  'contextPanel.mode.linear',
  'contextPanel.linear.label.status',
  'contextPanel.linear.label.team',
]);

describe('linear panel translations', () => {
  test('provides every required key in every supported locale', () => {
    const english = linearPanelI18n.en;
    for (const locale of locales) {
      for (const key of requiredKeys) {
        const value = linearPanelI18n[locale][key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !matchingEnglishAllowed.has(key)) {
          expect(value).not.toBe(english[key]);
        }
      }
    }
  });
});
