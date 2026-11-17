import { describe, expect, test } from 'bun:test';

import { goalSpecSectionHeadings, parseGoalSpecSections } from './goalSpec';

describe('goal spec sections (#1829)', () => {
  const spec = '## Objective\nShip it.\n\n## Requirements\n1. One\n\n## Done when\nTests pass.';

  test('lists the headings a per-section rewrite can target, in order', () => {
    expect(goalSpecSectionHeadings(spec)).toEqual(['Objective', 'Requirements', 'Done when']);
  });

  test('parses each section body, ignoring text before the first heading', () => {
    expect(parseGoalSpecSections(`preamble\n${spec}`)).toEqual([
      { heading: 'Objective', body: 'Ship it.' },
      { heading: 'Requirements', body: '1. One' },
      { heading: 'Done when', body: 'Tests pass.' },
    ]);
    expect(parseGoalSpecSections('no headings')).toEqual([]);
  });
});
