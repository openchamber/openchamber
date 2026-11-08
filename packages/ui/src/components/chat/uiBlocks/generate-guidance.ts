import { writeFileSync } from 'node:fs';
import { buildUiBlocksGuidance } from './guidance';
import { UI_BLOCKS_GUIDANCE_PATH, renderUiBlocksGuidanceModule } from './guidanceModule';

// Run after changing the catalog: `bun run --cwd packages/ui ui-blocks:generate`.
writeFileSync(UI_BLOCKS_GUIDANCE_PATH, renderUiBlocksGuidanceModule(buildUiBlocksGuidance()));
