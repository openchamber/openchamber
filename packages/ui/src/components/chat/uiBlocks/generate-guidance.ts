import { writeFileSync } from 'node:fs';
import { buildUiBlocksGuidance } from './guidance';
import { UI_BLOCKS_GUIDANCE_PATH, renderUiBlocksGuidanceModule } from './guidanceModule';

writeFileSync(UI_BLOCKS_GUIDANCE_PATH, renderUiBlocksGuidanceModule(buildUiBlocksGuidance()));
