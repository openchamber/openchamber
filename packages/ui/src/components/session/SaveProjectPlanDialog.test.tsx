import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

type MockDialogProps = React.PropsWithChildren<{ open?: boolean; className?: string }>;

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open = true }: MockDialogProps) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: MockDialogProps) => <div>{children}</div>,
  DialogDescription: ({ children }: MockDialogProps) => <p>{children}</p>,
  DialogFooter: ({ children }: MockDialogProps) => <div>{children}</div>,
  DialogHeader: ({ children }: MockDialogProps) => <div>{children}</div>,
  DialogTitle: ({ children }: MockDialogProps) => <h2>{children}</h2>,
}));

const { SaveProjectPlanDialog } = await import('./SaveProjectPlanDialog');

describe('SaveProjectPlanDialog', () => {
  test('associates the title label with the title input', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <SaveProjectPlanDialog
          open={true}
          onOpenChange={() => {}}
          initialTitle="Implementation plan"
          sourceText="Plan content"
          onSave={() => {}}
        />
      </I18nProvider>,
    );

    const labelMatch = markup.match(/<label[^>]*for="([^"]+)"[^>]*>Title<\/label>/);
    expect(labelMatch?.[1]).toBeTruthy();
    expect(markup).toContain(`id="${labelMatch?.[1]}"`);
  });
});
