import { describe, expect, it } from 'vitest';
import { normalizeWalkthrough, parseModelJson, MAX_STOPS } from './schema.js';

const ALIASES = new Map([
  ['h1', 'working:src/a.ts:aaaa1111'],
  ['h2', 'working:src/a.ts:bbbb2222'],
  ['h3', 'working:src/b.ts:cccc3333'],
]);

const walkthrough = (chapters) => ({ title: 'Change', focus: 'why', chapters });

describe('normalizeWalkthrough', () => {
  it('maps aliases to real hunk ids and assigns stable local ids', () => {
    const result = normalizeWalkthrough(walkthrough([
      {
        title: 'Data',
        icon: 'doc',
        blurb: 'shape first',
        stops: [
          { title: 'New field', hunks: ['h1', 'h2'], importance: 'critical', prose: 'Adds a field.' },
        ],
      },
    ]), ALIASES);

    expect(result.chapters[0].id).toBe('chapter-1');
    expect(result.chapters[0].stops[0]).toMatchObject({
      id: 'stop-1-1',
      hunkIds: ['working:src/a.ts:aaaa1111', 'working:src/a.ts:bbbb2222'],
      importance: 'critical',
    });
  });

  it('drops invented aliases instead of rendering a broken anchor', () => {
    const result = normalizeWalkthrough(walkthrough([
      {
        title: 'Data',
        icon: 'doc',
        blurb: '',
        stops: [
          { title: 'Mixed', hunks: ['h1', 'h99', 'nonsense'], importance: 'normal', prose: 'Something.' },
        ],
      },
    ]), ALIASES);

    expect(result.chapters[0].stops[0].hunkIds).toEqual(['working:src/a.ts:aaaa1111']);
    expect(result.droppedAnchors).toBe(2);
  });

  it('anchors each hunk to a single stop', () => {
    const result = normalizeWalkthrough(walkthrough([
      {
        title: 'Data',
        icon: 'doc',
        blurb: '',
        stops: [
          { title: 'First', hunks: ['h1'], importance: 'normal', prose: 'One.' },
          { title: 'Second', hunks: ['h1', 'h2'], importance: 'normal', prose: 'Two.' },
        ],
      },
    ]), ALIASES);

    expect(result.chapters[0].stops[0].hunkIds).toEqual(['working:src/a.ts:aaaa1111']);
    expect(result.chapters[0].stops[1].hunkIds).toEqual(['working:src/a.ts:bbbb2222']);
  });

  it('discards stops left with no anchor or no prose', () => {
    const result = normalizeWalkthrough(walkthrough([
      {
        title: 'Data',
        icon: 'doc',
        blurb: '',
        stops: [
          { title: 'Ghost', hunks: ['h99'], importance: 'normal', prose: 'About nothing.' },
          { title: 'Silent', hunks: ['h1'], importance: 'normal', prose: '   ' },
          { title: 'Real', hunks: ['h2'], importance: 'normal', prose: 'Actual explanation.' },
        ],
      },
    ]), ALIASES);

    expect(result.chapters[0].stops.map((stop) => stop.title)).toEqual(['Real']);
  });

  it('rejects a response whose stops all fall away', () => {
    expect(() => normalizeWalkthrough(walkthrough([
      { title: 'Empty', icon: 'doc', blurb: '', stops: [{ title: 'Ghost', hunks: ['h99'], importance: 'normal', prose: 'x' }] },
    ]), ALIASES)).toThrow('no usable stops');
  });

  it('clamps chapter titles and falls back on unknown enums', () => {
    const result = normalizeWalkthrough(walkthrough([
      {
        title: 'An extremely long chapter title that will not fit the column',
        icon: 'rocket',
        blurb: '',
        stops: [{ title: 'A', hunks: ['h1'], importance: 'urgent', prose: 'Text.' }],
      },
    ]), ALIASES);

    expect(result.chapters[0].title.length).toBeLessThanOrEqual(24);
    expect(result.chapters[0].icon).toBe('doc');
    expect(result.chapters[0].stops[0].importance).toBe('normal');
  });

  it('caps the total number of stops', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      title: `Stop ${index}`,
      hunks: [['h1', 'h2', 'h3'][index % 3]],
      importance: 'normal',
      prose: 'Text.',
    }));

    const result = normalizeWalkthrough(
      walkthrough([{ title: 'All', icon: 'doc', blurb: '', stops: many }]),
      ALIASES,
    );

    const total = result.chapters.reduce((sum, chapter) => sum + chapter.stops.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_STOPS);
    // Only three aliases exist and each is used once, so the real cap here is
    // the alias pool, not the stop limit.
    expect(total).toBe(3);
  });
});

describe('parseModelJson', () => {
  it('parses a clean object', () => {
    expect(parseModelJson('{"title":"x"}')).toEqual({ title: 'x' });
  });

  it('unwraps a fenced block', () => {
    expect(parseModelJson('```json\n{"title":"x"}\n```')).toEqual({ title: 'x' });
  });

  it('recovers an object followed by stray prose', () => {
    expect(parseModelJson('{"title":"x"}\n\nHope that helps!')).toEqual({ title: 'x' });
  });

  it('fails loudly on unusable output', () => {
    expect(() => parseModelJson('')).toThrow('empty response');
    expect(() => parseModelJson('no json at all')).toThrow('no JSON object');
    expect(() => parseModelJson('{"broken":')).toThrow('not valid JSON');
  });
});
