import { fileURLToPath } from 'node:url';

export const UI_BLOCKS_GUIDANCE_PATH = fileURLToPath(
  new URL('../../../../../web/server/lib/session-knowledge/ui-blocks-guidance.js', import.meta.url),
);

/** The server-side module holding the agent's UI block guidance. */
export function renderUiBlocksGuidanceModule(guidance: string): string {
  return [
    '// Generated from packages/ui/src/components/chat/uiBlocks/guidance.ts by',
    '// `bun run --cwd packages/ui ui-blocks:generate`. Do not edit by hand.',
    `export const UI_BLOCKS_GUIDANCE = ${JSON.stringify(guidance)};`,
    '',
  ].join('\n');
}
