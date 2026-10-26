/// <reference lib="webworker" />

import { createStreamdownHighlighter } from './streamdownHighlighter';
import { packCodeTokens } from './streamdown-code-protocol';
import type { StreamdownCodeRequest, StreamdownCodeResponse } from './streamdown-code-protocol';

const highlight = createStreamdownHighlighter();
let queue = Promise.resolve();

async function run(data: StreamdownCodeRequest): Promise<void> {
  try {
    const tokens = await highlight(data.code, data.language, data.fullPass);
    const result = packCodeTokens(tokens.slice(data.fromLine ?? 0));
    const response: StreamdownCodeResponse = { id: data.id, result };
    self.postMessage(response, [result.lines.buffer, result.spans.buffer]);
  } catch {
    const response: StreamdownCodeResponse = { id: data.id, error: true };
    self.postMessage(response);
  }
}

self.onmessage = ({ data }: MessageEvent<StreamdownCodeRequest>) => {
  queue = queue.then(() => run(data)).catch(() => {});
};
