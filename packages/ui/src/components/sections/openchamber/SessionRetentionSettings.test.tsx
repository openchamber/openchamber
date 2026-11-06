import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';

const state = {
  sessionRetentionOnlyArchived: false,
  sessionRetentionAction: 'archive' as 'archive' | 'delete',
  sessionWorkEnabled: true,
};

mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (value: typeof state) => T): T => selector(state),
}));
mock.module('@/hooks/useSessionAutoCleanup', () => ({
  useSessionAutoCleanup: () => ({
    candidates: [],
    isRunning: false,
    action: state.sessionRetentionOnlyArchived ? 'delete' : state.sessionRetentionAction,
    status: 'ready',
  }),
}));
mock.module('@/components/sections/shared/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SettingsFieldRow: ({ settingsItem, info }: { settingsItem?: string; info?: React.ReactNode }) => (
    settingsItem === 'sessions.retention-only-archived' ? <p>{info}</p> : null
  ),
  SettingsCheckboxRow: ({ settingsItem, disabled }: { settingsItem?: string; disabled?: boolean }) => (
    <i data-settings-item={settingsItem} aria-disabled={disabled} />
  ),
  SettingsChipGroup: () => null,
  SETTINGS_ICON_BUTTON_CLASS: '',
  SETTINGS_NUMBER_INPUT_CLASS: '',
  SETTINGS_NUMBER_STEPPER_ROW_CLASS: '',
  SETTINGS_NUMBER_UNIT_CLASS: '',
  SETTINGS_OPTION_STACK_CLASS: '',
}));

const { SessionRetentionSettings } = await import('./SessionRetentionSettings');

describe('retention target hint', () => {
  test('explains the actual time basis and action across scope changes', () => {
    const render = () => renderToStaticMarkup(<I18nProvider><SessionRetentionSettings /></I18nProvider>);

    state.sessionRetentionOnlyArchived = false;
    state.sessionRetentionAction = 'archive';
    expect(render()).toContain("Counts the retention period from the session&#x27;s last activity. Expired sessions are archived.");

    state.sessionRetentionAction = 'delete';
    expect(render()).toContain("Counts the retention period from the session&#x27;s last activity. Expired sessions are deleted.");

    state.sessionRetentionOnlyArchived = true;
    expect(render()).toContain('Counts the retention period from archiving. Expired sessions are deleted.');

    state.sessionRetentionOnlyArchived = false;
    state.sessionRetentionAction = 'archive';
    expect(render()).toContain("Counts the retention period from the session&#x27;s last activity. Expired sessions are archived.");
  });
});

describe('include In work checkbox', () => {
  test('shows only while sessions in work are on', () => {
    const render = () => renderToStaticMarkup(<I18nProvider><SessionRetentionSettings /></I18nProvider>);
    state.sessionWorkEnabled = true;
    expect(render()).toContain('data-settings-item="sessions.retention-include-in-work"');
    state.sessionWorkEnabled = false;
    expect(render()).not.toContain('data-settings-item="sessions.retention-include-in-work"');
    state.sessionWorkEnabled = true;
  });

  test('stays visible but disabled with the archived target', () => {
    const render = () => renderToStaticMarkup(<I18nProvider><SessionRetentionSettings /></I18nProvider>);
    const checkbox = '<i data-settings-item="sessions.retention-include-in-work" aria-disabled="true">';
    state.sessionRetentionOnlyArchived = true;
    expect(render()).toContain(checkbox);
    state.sessionRetentionOnlyArchived = false;
    expect(render()).not.toContain(checkbox);
    expect(render()).toContain('data-settings-item="sessions.retention-include-in-work"');
  });
});
