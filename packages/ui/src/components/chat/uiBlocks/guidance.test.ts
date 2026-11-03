import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { UI_BLOCK_EXAMPLES, buildUiBlocksGuidance } from './guidance';
import { UI_BLOCKS_GUIDANCE_PATH, renderUiBlocksGuidanceModule } from './guidanceModule';
import { parseUiBlock } from './catalog';

describe('UI block guidance', () => {
  test('the server copy matches the catalog (run ui-blocks:generate after a catalog change)', () => {
    expect(readFileSync(UI_BLOCKS_GUIDANCE_PATH, 'utf8')).toBe(renderUiBlocksGuidanceModule(buildUiBlocksGuidance()));
  });

  test('every example the agent reads is a valid block', () => {
    for (const example of UI_BLOCK_EXAMPLES) {
      expect(buildUiBlocksGuidance()).toContain(example);
      expect(parseUiBlock(example, true).kind).toBe('ready');
    }
  });
});
