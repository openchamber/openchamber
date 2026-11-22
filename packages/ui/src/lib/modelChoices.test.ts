import { afterEach, describe, expect, test } from 'bun:test';

import { describeModelChoice, inputSizeBucket, recordGoalWriterChoice } from './modelChoices';
import { useUIStore } from '@/stores/useUIStore';

const originalFetch = globalThis.fetch;

type Sent = { url: string; body: unknown };

const captureFetch = (): Sent[] => {
  const sent: Sent[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response('{"recorded":true}', { status: 200 });
  }, { preconnect: async () => {} });
  return sent;
};

// The send is fire-and-forget; let its promise run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  globalThis.fetch = originalFetch;
  useUIStore.setState({ modelChoiceRecordingEnabled: true });
});

describe('model choice helpers', () => {
  test('buckets an input by length, never by content', () => {
    expect(inputSizeBucket(null)).toBe('unknown');
    expect(inputSizeBucket(0)).toBe('empty');
    expect(inputSizeBucket(280)).toBe('short');
    expect(inputSizeBucket(281)).toBe('medium');
    expect(inputSizeBucket(2_000)).toBe('medium');
    expect(inputSizeBucket(2_001)).toBe('long');
  });

  test('a pick of what was already in effect is no choice', () => {
    const base = { surface: 'composer' as const, sessionModel: null, inputSize: 'unknown' as const };
    expect(describeModelChoice({ ...base, chosen: { model: 'a/b', variant: null }, replaced: { model: 'a/b', variant: null } })).toBeNull();
    expect(describeModelChoice({ ...base, chosen: { model: 'a/b', variant: 'low' }, replaced: { model: 'a/b', variant: null } })?.kind).toBe('effort');
    expect(describeModelChoice({ ...base, chosen: { model: 'a/c', variant: null }, replaced: { model: 'a/b', variant: null } })?.kind).toBe('model');
    expect(describeModelChoice({ ...base, chosen: { model: 'a/c', variant: null }, replaced: null })?.kind).toBe('model');
  });
});

describe('recordGoalWriterChoice', () => {
  const writer = { providerID: 'anthropic', modelID: 'claude-opus', variant: 'low' };
  const sessionModel = { providerID: 'anthropic', modelID: 'claude-sonnet' };

  test('sends the pick, the default it replaced and a size bucket', async () => {
    const sent = captureFetch();
    recordGoalWriterChoice({ writer, writerDefault: null, sessionModel, inputLength: 5_000 });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/api/openchamber/model-choices');
    expect(sent[0].body).toEqual({
      surface: 'goal-writer',
      kind: 'model',
      chosen: { model: 'anthropic/claude-opus', variant: 'low' },
      replaced: { model: 'anthropic/claude-sonnet', variant: null },
      sessionModel: 'anthropic/claude-sonnet',
      inputSize: 'long',
    });
  });

  test('prefers the Settings writer model as the replaced default', async () => {
    const sent = captureFetch();
    recordGoalWriterChoice({
      writer,
      writerDefault: { providerID: 'anthropic', modelID: 'claude-opus', variant: 'high' },
      sessionModel,
      inputLength: 10,
    });
    await settle();
    expect(sent[0].body).toMatchObject({ kind: 'effort', replaced: { model: 'anthropic/claude-opus', variant: 'high' }, inputSize: 'short' });
  });

  test('sends nothing while recording is off', async () => {
    const sent = captureFetch();
    useUIStore.setState({ modelChoiceRecordingEnabled: false });
    recordGoalWriterChoice({ writer, writerDefault: null, sessionModel, inputLength: 10 });
    await settle();
    expect(sent).toEqual([]);
  });
});
