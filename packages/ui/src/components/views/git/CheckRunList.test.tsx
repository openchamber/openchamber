import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';

import { I18nProvider } from '@/lib/i18n';
import { dict as en } from '@/lib/i18n/messages/en';
import type { CIRun } from '@/lib/source-control/types';

import { CheckRunList } from './CheckRunList';
import type { CheckRunExpansion } from './checkRunState';

const baseRun: CIRun = {
  provider: 'github',
  instance: 'github.com',
  id: '99',
  name: 'test',
  status: 'completed',
  conclusion: 'failure',
};

const renderList = (run: CIRun) => {
  const runKey = `${run.id}:${run.name}:0`;
  const expansion: CheckRunExpansion = {
    runs: new Set([runKey]),
    steps: new Set(),
    toggleRun: () => {},
    toggleStep: () => {},
  };
  return renderToStaticMarkup(
    <I18nProvider>
      <CheckRunList runs={[run]} now={0} expansion={expansion} formatTimestamp={() => ''} />
    </I18nProvider>,
  );
};

describe('CheckRunList annotations truncation (#1743)', () => {
  test('shows the incomplete-annotations notice for a truncated run with no annotations', () => {
    const html = renderList({ ...baseRun, annotationsTruncated: true });
    expect(html).toContain(en['gitView.pr.checks.annotationsTruncated']);
  });

  test('shows no truncation notice for a run that is not truncated', () => {
    const html = renderList({ ...baseRun, annotations: [{ message: 'Failure' }] });
    expect(html).not.toContain(en['gitView.pr.checks.annotationsTruncated']);
  });
});
