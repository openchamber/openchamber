import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { dict as enDict } from '@/lib/i18n/messages/en';

type MockDialogProps = React.PropsWithChildren<{ open?: boolean }>;

let shortcutOverrides: Record<string, string> = {};

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open = true }: MockDialogProps) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: MockDialogProps) => <div>{children}</div>,
  DialogDescription: ({ children }: MockDialogProps) => <p>{children}</p>,
  DialogHeader: ({ children }: MockDialogProps) => <div>{children}</div>,
  DialogTitle: ({ children }: MockDialogProps) => <h2>{children}</h2>,
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name }: { name: string }) => <i data-icon={name} />,
}));

mock.module('@/components/icons/DiffIcon', () => ({
  DiffIcon: () => <i data-icon="diff" />,
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    isHelpDialogOpen: true,
    setHelpDialogOpen: () => {},
    shortcutOverrides,
  }),
}));

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: keyof typeof enDict) => enDict[key] ?? key,
  }),
}));

mock.module('@/lib/desktop', () => ({
  isDesktopShell: () => true,
  isVSCodeRuntime: () => false,
}));

mock.module('@/lib/utils', () => ({
  isMacOS: () => true,
}));

const { HelpDialog } = await import('./HelpDialog');
const { getShortcutAction } = await import('@/lib/shortcuts');

const renderHelpDialog = (overrides: Record<string, string> = {}) => {
  shortcutOverrides = overrides;
  return renderToStaticMarkup(<HelpDialog />);
};

describe('HelpDialog', () => {
  test('Open Changes references a registered shortcut action', () => {
    expect(getShortcutAction('open_diff_panel')).toBeDefined();
  });

  test('shows Open Changes with its semantic icon', () => {
    const markup = renderHelpDialog();

    expect(markup).toContain('Open Changes Surface');
    expect(markup).toContain('data-icon="diff"');
  });

  test('omits project switching and the rejected extra rows', () => {
    const markup = renderHelpDialog();

    expect(markup).not.toContain('Switch Project');
    expect(markup).not.toContain('Open conversation timeline');
    expect(markup).not.toContain('New Mini Chat window');
  });

  test('reflects the Open Changes shortcut override', () => {
    const markup = renderHelpDialog({
      open_diff_panel: 'mod+8',
    });

    expect(markup).toContain('⌘ + 8');
  });
});
