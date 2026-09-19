import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitGraphSegment } from './GitGraphSegment';

describe('GitGraphSegment', () => {
  test('renders connector paths at 0.75 stroke width without changing node circle strokes', () => {
    const markup = renderToStaticMarkup(
      <GitGraphSegment
        viewModel={{
          historyItem: {
            id: 'commit-a',
            parentIds: ['commit-root'],
            subject: 'subject',
            message: 'message',
            author: 'author',
            authorEmail: 'author@example.com',
            timestamp: '2024-01-01T00:00:00Z',
            statistics: { files: 0, insertions: 0, deletions: 0 },
            references: [],
          },
          inputSwimlanes: [{ id: 'commit-a', color: 'var(--chart-1)' }],
          outputSwimlanes: [{ id: 'commit-root', color: 'var(--chart-1)' }],
          nodeColor: 'var(--chart-1)',
          kind: 'node',
        }}
      />,
    );

    const pathMarkup = markup.match(/<path[^>]*stroke-width="([^"]+)"[^>]*>/g) ?? [];
    expect(pathMarkup.length).toBeGreaterThan(0);
    pathMarkup.forEach((path) => {
      expect(path).toContain('stroke-width="0.75"');
    });
    expect(markup).toContain('<circle cx="11" cy="11" r="5" fill="var(--chart-1)" stroke="var(--background)" stroke-width="2"></circle>');
  });
});
