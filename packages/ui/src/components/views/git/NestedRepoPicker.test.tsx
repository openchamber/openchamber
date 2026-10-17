import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

import { NestedRepoPicker } from './NestedRepoPicker';

const triggerLabel = (selectedRepository: string): string => renderToStaticMarkup(
  <I18nProvider>
    <NestedRepoPicker
      repositories={['/project', '/project/one']}
      selectedRepository={selectedRepository}
      onSelectRepository={() => {}}
      repositoryRoot="/project"
    />
  </I18nProvider>,
);

describe('NestedRepoPicker', () => {
  test('names the root option instead of showing its full path', () => {
    expect(triggerLabel('/project')).toContain('Project root');
  });

  test('keeps nested entries relative to the root', () => {
    const markup = triggerLabel('/project/one');
    expect(markup).toContain('one');
    expect(markup).not.toContain('Project root');
  });
});
