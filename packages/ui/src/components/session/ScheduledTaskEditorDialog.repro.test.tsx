/**
 * Reproduction test for issue #2342:
 * Close (X) button doesn't work on the "New Task" dialog.
 *
 * Root cause: The `hasOpenFloatingMenu()` function in ScheduledTaskEditorDialog
 * uses a selector that matches ANY popup element (even closed/during-animation),
 * while the equivalent functions in MultiRunWindow.tsx and SettingsWindow.tsx
 * correctly filter by `[data-open]` to only match OPEN popups.
 *
 * Additionally, the X button goes through the Dialog's `onOpenChange` handler
 * which has the `hasOpenFloatingMenu()` guard, while the Cancel button calls
 * `props.onOpenChange(false)` directly, bypassing the guard entirely.
 */
import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type MockDialogProps = React.PropsWithChildren<{ open?: boolean; className?: string }>;

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open = true }: MockDialogProps) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: MockDialogProps) => <div>{children}</div>,
  DialogDescription: ({ children }: MockDialogProps) => <p>{children}</p>,
  DialogHeader: ({ children }: MockDialogProps) => <div>{children}</div>,
  DialogTitle: ({ children }: MockDialogProps) => <h2>{children}</h2>,
}));

mock.module('@/components/sections/agents/ModelSelector', () => ({
  ModelSelector: () => React.createElement('div'),
}));

mock.module('@/components/sections/commands/AgentSelector', () => ({
  AgentSelector: () => React.createElement('div'),
}));

mock.module('@/components/chat/CommandAutocomplete', () => ({
  CommandAutocomplete: React.forwardRef(() => React.createElement('div')),
}));

mock.module('@/components/chat/FileMentionAutocomplete', () => ({
  FileMentionAutocomplete: React.forwardRef(() => React.createElement('div')),
}));

mock.module('@/components/chat/SnippetAutocomplete', () => ({
  SnippetAutocomplete: React.forwardRef(() => React.createElement('div')),
}));

mock.module('@/hooks/useProviderLogo', () => ({
  useProviderLogo: () => ({ src: null, onError: () => {}, hasLogo: false }),
}));

// Import after mocks so dependencies resolve
const { ScheduledTaskEditorDialog } = await import('./ScheduledTaskEditorDialog');

describe('Issue #2342: New Task dialog X close button bug', () => {
  test('hasOpenFloatingMenu selector is missing [data-open] filter', () => {
    const correctSelector =
      '[data-slot="dropdown-menu-content"][data-open], [data-slot="select-content"][data-open]';
    const buggySelector =
      '[data-slot="dropdown-menu-content"], [data-slot="select-content"]';

    const source = fs.readFileSync(
      path.join(__dirname, 'ScheduledTaskEditorDialog.tsx'),
      'utf-8',
    );

    // ScheduledTaskEditorDialog uses selectors WITHOUT [data-open] (bug)
    expect(source).toContain(buggySelector);
    expect(source).not.toContain(correctSelector);

    // MultiRunWindow uses selectors WITH [data-open] (correct)
    expect(
      fs.readFileSync(path.join(__dirname, '../views/MultiRunWindow.tsx'), 'utf-8'),
    ).toContain(correctSelector);

    // SettingsWindow uses selectors WITH [data-open] (correct)
    expect(
      fs.readFileSync(path.join(__dirname, '../views/SettingsWindow.tsx'), 'utf-8'),
    ).toContain(correctSelector);
  });

  test('Cancel button bypasses guard while X button goes through it', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'ScheduledTaskEditorDialog.tsx'),
      'utf-8',
    );

    // Cancel button: calls props.onOpenChange(false) directly — ALWAYS works
    expect(source).toContain('onClick={() => onOpenChange(false)}');

    // Dialog onOpenChange: has hasOpenFloatingMenu guard — can be BLOCKED
    expect(source).toContain('if (!next && hasOpenFloatingMenu())');

    // This asymmetry means Cancel always closes, but X can be silently blocked.
  });
});
