import { describe, expect, it } from 'vitest';
import { normalizeWalkthrough, parseModelJson, MAX_OBSERVATIONS, MAX_STOPS } from './schema.js';

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

  it('keeps valid observations and drops unknown kinds, empty notes and the surplus', () => {
    const observation = (kind, note = `A ${kind}.`) => ({ kind, note });
    const result = normalizeWalkthrough(walkthrough([{
      title: 'All',
      icon: 'doc',
      blurb: '',
      stops: [
        {
          title: 'One',
          hunks: ['h1'],
          importance: 'normal',
          prose: 'Text.',
          observations: [observation('decision'), observation('bug'), observation('cost', '  '), observation('cost'), observation('limitation')],
        },
        { title: 'Two', hunks: ['h2'], importance: 'normal', prose: 'Text.' },
        {
          title: 'Three',
          hunks: ['h3'],
          importance: 'normal',
          prose: 'Text.',
          observations: Array.from({ length: 2 }, () => observation('unproven')),
        },
      ],
    }]), ALIASES);

    const [one, two, three] = result.chapters[0].stops;
    expect(one.observations).toEqual([observation('decision'), observation('cost')]);
    expect(two.observations).toEqual([]);
    expect(three.observations).toHaveLength(2);
  });

  it('keeps a routine note only for a digest file a stop left uncovered', () => {
    const digestFiles = [
      { path: 'src/a.ts', hunks: [{ alias: 'h1' }, { alias: 'h2' }] },
      { path: 'src/b.ts', hunks: [{ alias: 'h3' }] },
    ];
    const result = normalizeWalkthrough({
      ...walkthrough([{ title: 'All', icon: 'doc', blurb: '', stops: [
        { title: 'One', hunks: ['h1', 'h3'], importance: 'normal', prose: 'Text.' },
      ] }]),
      routine: [
        { path: 'src/a.ts', note: 'Import order.' },
        { path: 'src/a.ts', note: 'Twice.' },
        { path: 'src/b.ts', note: 'Fully covered by a stop.' },
        { path: 'src/missing.ts', note: 'Not in the diff.' },
        { path: 'src/a.ts', note: '' },
      ],
    }, ALIASES, digestFiles);

    expect(result.routine).toEqual([{ path: 'src/a.ts', note: 'Import order.' }]);
  });

  it('caps observations across the whole walkthrough', () => {
    const aliases = new Map(Array.from({ length: 6 }, (_, index) => [`h${index + 1}`, `working:src/a.ts:${index}`]));
    const stops = Array.from({ length: 6 }, (_, index) => ({
      title: `Stop ${index}`,
      hunks: [`h${index + 1}`],
      importance: 'normal',
      prose: 'Text.',
      observations: [{ kind: 'cost', note: 'One.' }, { kind: 'decision', note: 'Two.' }],
    }));

    const result = normalizeWalkthrough(walkthrough([{ title: 'All', icon: 'doc', blurb: '', stops }]), aliases);

    const total = result.chapters[0].stops.reduce((sum, stop) => sum + stop.observations.length, 0);
    expect(total).toBe(MAX_OBSERVATIONS);
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
