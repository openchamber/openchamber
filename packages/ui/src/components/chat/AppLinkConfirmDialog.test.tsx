import React from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

const { AppLinkConfirmDialog } = await import('./AppLinkConfirmDialog');
const {
  getAppLinkConfirmationSnapshot,
  openAppLinkWithConfirmation,
  settleAppLinkConfirmation,
} = await import('./appLinkConfirmation');

describe('AppLinkConfirmDialog', () => {
  beforeEach(() => {
    if (getAppLinkConfirmationSnapshot()) {
      settleAppLinkConfirmation('cancel');
    }
  });

  test('keeps cancel visible and focused beside both open choices', () => {
    void openAppLinkWithConfirmation('obsidian://open?vault=Notebook');

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AppLinkConfirmDialog />
      </I18nProvider>,
    );

    expect(markup).toContain('>Cancel</button>');
    expect(markup).toContain('autofocus=""');
    expect(markup).toContain('>Open once</button>');
    expect(markup).toContain('>Trust and open</button>');

    settleAppLinkConfirmation('cancel');
  });
});
