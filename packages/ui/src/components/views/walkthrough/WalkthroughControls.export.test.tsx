import React from 'react';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { I18nProvider } from '@/lib/i18n';
import { buildWalkthroughView } from '@/lib/walkthrough/model';
import type { WalkthroughResult } from '@/lib/walkthrough/types';
import { WalkthroughExportMenu } from './WalkthroughControls';

const result: WalkthroughResult = {
  source: { kind: 'working-tree', scope: 'all' },
  walkthrough: { title: 'T', focus: '', chapters: [] },
  hunks: [],
  hunkCount: 0,
};

const exportOffered = (blocked: Parameters<typeof WalkthroughExportMenu>[0]['review']['blocked']): boolean =>
  renderToStaticMarkup(
    <I18nProvider>
      <TooltipProvider>
        <WalkthroughExportMenu review={{ view: buildWalkthroughView(result), entry: { result }, blocked, showStages: false }} />
      </TooltipProvider>
    </I18nProvider>,
  ).includes('Export walkthrough');

test('export is offered only while the panel shows the walkthrough', () => {
  expect(exportOffered(undefined)).toBe(true);
  // A failed regeneration keeps the previous result in the store, but the panel shows the blocker.
  expect(exportOffered({ reason: 'context-too-small', model: undefined, requiredChars: 10, availableChars: 5 })).toBe(false);
});
