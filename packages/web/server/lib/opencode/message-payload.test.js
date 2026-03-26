import { describe, expect, it } from 'bun:test';

import {
  rewriteJsonSseBlock,
  sanitizeMessagePayload,
} from './message-payload.js';

const buildDiff = (lineCount) => Array.from({ length: lineCount }, (_, index) => `line-${index + 1}`).join('\n');

describe('message-payload helpers', () => {
  it('removes summary diff before/after snapshots inside message info', () => {
    const payload = [{
      info: {
        id: 'message-2',
        role: 'assistant',
        summary: {
          diffs: [{
            file: 'CLAUDE.md',
            before: buildDiff(230),
            after: buildDiff(240),
            additions: 10,
            deletions: 5,
            status: 'modified',
          }],
        },
      },
      parts: [],
    }];

    const nextPayload = sanitizeMessagePayload(payload);
    const diffEntry = nextPayload[0].info.summary.diffs[0];

    expect(nextPayload).not.toBe(payload);
    expect(diffEntry.before).toBeUndefined();
    expect(diffEntry.after).toBeUndefined();
    expect(diffEntry.additions).toBe(10);
    expect(diffEntry.deletions).toBe(5);
    expect(diffEntry.status).toBe('modified');
    expect(diffEntry.file).toBe('CLAUDE.md');
  });

  it('removes session-level diff snapshot arrays before/after fields', () => {
    const payload = [{
      file: 'README.md',
      before: buildDiff(205),
      after: buildDiff(206),
      additions: 3,
      deletions: 1,
      status: 'modified',
    }];

    const nextPayload = sanitizeMessagePayload(payload);
    const diffEntry = nextPayload[0];

    expect(nextPayload).not.toBe(payload);
    expect(diffEntry.before).toBeUndefined();
    expect(diffEntry.after).toBeUndefined();
    expect(diffEntry.additions).toBe(3);
    expect(diffEntry.deletions).toBe(1);
    expect(diffEntry.status).toBe('modified');
    expect(diffEntry.file).toBe('README.md');
  });

  it('does not modify unrelated payload objects', () => {
    const payload = {
      parts: [
        { id: 'part-1', type: 'text', text: 'hello' },
        { id: 'part-2', type: 'tool', state: { metadata: { diff: buildDiff(5) } } },
      ],
    };

    expect(sanitizeMessagePayload(payload)).toBe(payload);
  });

  it('rewrites JSON SSE blocks while preserving non-data lines', () => {
    const originalBlock = [
      'id: 10',
      'event: message',
      `data: ${JSON.stringify({ payload: { type: 'message.updated', properties: { info: { summary: { diffs: [{ file: 'CLAUDE.md', before: buildDiff(3), after: buildDiff(4), status: 'modified' }] } } } } })}`,
    ].join('\n');

    const result = rewriteJsonSseBlock(originalBlock, sanitizeMessagePayload);

    expect(result.changed).toBe(true);
    expect(result.block.startsWith('id: 10\nevent: message\ndata: ')).toBe(true);
    expect(result.parsedPayload?.properties?.info?.summary?.diffs?.[0]?.before).toBeUndefined();
    expect(result.parsedPayload?.properties?.info?.summary?.diffs?.[0]?.after).toBeUndefined();
    expect(result.parsedPayload?.properties?.info?.summary?.diffs?.[0]?.status).toBe('modified');
  });
});
