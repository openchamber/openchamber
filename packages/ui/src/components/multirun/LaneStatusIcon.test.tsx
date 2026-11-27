import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { LaneStatus } from '@/lib/multirun/laneStatus';
import { LaneStatusIcon } from './LaneStatusIcon';

const glyphClass = (status: LaneStatus): string => {
  const markup = renderToStaticMarkup(<I18nProvider><LaneStatusIcon status={status} /></I18nProvider>);
  return markup.match(/<svg[^>]*class="([^"]*)"/)?.[1] ?? '';
};

test('a lane waiting on the user takes the sidebar colour, not the running blue or the failure red', () => {
  for (const status of ['permission', 'question'] as const) {
    const classes = glyphClass(status);
    expect(classes).toContain('text-status-warning');
    expect(classes).not.toContain('text-status-info');
    expect(classes).not.toContain('text-destructive');
  }
});

test('a working lane is blue like a running session in the sidebar, not the waiting amber', () => {
  const classes = glyphClass('working');
  expect(classes).toContain('text-status-info');
  expect(classes).not.toContain('status-warning');
});
