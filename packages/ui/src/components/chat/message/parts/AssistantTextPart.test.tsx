import React from 'react';
import { describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createOpencodeClient, type Part } from '@opencode-ai/sdk/v2';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import AssistantTextPart from './AssistantTextPart';
import type { StreamPhase } from '../types';

// Bun does not implement Vite's asset-query imports. Preserve the real asset
// URL while keeping the renderer and worker client modules unchanged.
plugin({
  name: 'assistant-text-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const unavailable = (): never => { throw new Error('Assistant text rendering must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); },
  get git() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
  get tools() { return unavailable(); },
};
const sdk = createOpencodeClient({
  baseUrl: 'http://localhost',
  fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
});
const TestProviders = ({ children }: { children: React.ReactNode }) => (
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <SyncProvider sdk={sdk} directory="">
      <I18nProvider>{children}</I18nProvider>
    </SyncProvider>
  </RuntimeAPIContext.Provider>
);

type TextPartFixture = Extract<Part, { type: 'text' }>;

// Regression tests for issue #3484: a text part that has ended (`time.end`)
// never streams, even while its message keeps running tool calls, so the
// block-level reveal releases its last paragraph at once.
describe('AssistantTextPart streaming gating (issue #3484)', () => {
  // One paragraph, no trailing line break: the shape the reveal holds entirely.
  const QUESTION_PREFACE = 'Before I continue I need to know which database you want to target.';
  const RENDERED_TEXT_MARKER = 'group/assistant-text';

  const makeTextPart = (time: TextPartFixture['time']): TextPartFixture => ({
    id: 'prt_text_3484',
    sessionID: 'ses_3484',
    messageID: 'msg_3484',
    type: 'text',
    text: QUESTION_PREFACE,
    time,
  });

  // The render mode defaults to 'live', where the reveal runs. Markdown lands in
  // effects, so static markup shows only whether the part rendered at all; a
  // held paragraph renders nothing.
  const renderPart = (part: TextPartFixture, streamPhase: StreamPhase): string =>
    renderToStaticMarkup(
      <TestProviders>
        <AssistantTextPart part={part} messageId="msg_3484" streamPhase={streamPhase} />
      </TestProviders>,
    );

  for (const streamPhase of ['streaming', 'cooldown'] as const) {
    test(`a finished text part renders while the message is still ${streamPhase}`, () => {
      const markup = renderPart(makeTextPart({ start: 1_000, end: 2_000 }), streamPhase);

      expect(markup).toContain(RENDERED_TEXT_MARKER);
    });
  }

  test('a live text part holds its incomplete paragraph', () => {
    const markup = renderPart(makeTextPart({ start: 1_000 }), 'streaming');

    expect(markup).not.toContain(RENDERED_TEXT_MARKER);
  });

  test('a completed message renders a text part that never received time.end', () => {
    const markup = renderPart(makeTextPart({ start: 1_000 }), 'completed');

    expect(markup).toContain(RENDERED_TEXT_MARKER);
  });
});
