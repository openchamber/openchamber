import { fileURLToPath } from 'node:url';

export const UI_BLOCKS_GUIDANCE_PATH = fileURLToPath(
  new URL('../../../../../web/server/lib/session-knowledge/ui-blocks-guidance.js', import.meta.url),
);

export function renderUiBlocksGuidanceModule(guidance: string): string {
  return [
    `export const UI_BLOCKS_GUIDANCE = ${JSON.stringify(guidance)};`,
    '',
  ].join('\n');
}
