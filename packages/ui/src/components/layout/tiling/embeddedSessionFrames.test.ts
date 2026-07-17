import { describe, expect, test } from 'bun:test';

import type { SplitNode } from './splitTree';
import { mapTileIdsToGroupIds } from './tileGroupIds';

describe('mapTileIdsToGroupIds', () => {
  test('maps every tile through nested split branches', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'horizontal',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'group', id: 'left', tileIds: ['chat'], activeTileId: 'chat' },
        {
          kind: 'split',
          direction: 'vertical',
          sizes: [0.5, 0.5],
          children: [
            { kind: 'group', id: 'top', tileIds: ['diff'], activeTileId: 'diff' },
            { kind: 'group', id: 'bottom', tileIds: ['preview'], activeTileId: 'preview' },
          ],
        },
      ],
    };

    const result = mapTileIdsToGroupIds(root);

    expect([...result]).toEqual([['chat', 'left'], ['diff', 'top'], ['preview', 'bottom']]);
  });
});
