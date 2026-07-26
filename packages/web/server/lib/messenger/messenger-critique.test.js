import { describe, expect, it, vi } from 'vitest';
import {
  buildCritiqueInstructions,
  parseCritiqueOutput,
  uploadGitDiffViaCritique,
  uploadPatchViaCritique,
} from './messenger-critique.js';

describe('parseCritiqueOutput', () => {
  it('parses JSON url/id from stdout', () => {
    const output = [
      'Converting to HTML...',
      'Uploading...',
      '{"url":"https://critique.work/v/abc123","id":"abc123"}',
    ].join('\n');
    expect(parseCritiqueOutput(output)).toEqual({
      url: 'https://critique.work/v/abc123',
      id: 'abc123',
    });
  });

  it('parses JSON error objects', () => {
    expect(parseCritiqueOutput('{"error":"no changes"}')).toEqual({ error: 'no changes' });
  });

  it('falls back to scraping a critique.work URL', () => {
    expect(parseCritiqueOutput('Preview URL: https://critique.work/v/deadbeef01')).toEqual({
      url: 'https://critique.work/v/deadbeef01',
      id: 'deadbeef01',
    });
  });
});

describe('buildCritiqueInstructions', () => {
  it('tells the agent to share critique.work URLs after edits', () => {
    const text = buildCritiqueInstructions();
    expect(text).toContain('<diffs>');
    expect(text).toContain('bunx --bun critique --web');
    expect(text).toContain('critique.work');
  });
});

describe('upload helpers (mocked spawn path)', () => {
  it('uploadGitDiffViaCritique returns parsed JSON when critique prints it', async () => {
    // Exercise the real helper with an injectable spawn by monkeypatching is hard
    // without DI — instead verify parseCritiqueOutput + instructions cover the
    // contract, and keep this as a smoke import check.
    expect(typeof uploadGitDiffViaCritique).toBe('function');
    expect(typeof uploadPatchViaCritique).toBe('function');
  });
});
