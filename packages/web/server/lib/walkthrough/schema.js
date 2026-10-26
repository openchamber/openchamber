// Shape of the walkthrough the model must produce, plus normalization of what
// it actually produced. The model is only ever trusted for prose and grouping —
// every anchor it returns is re-resolved against the digest here, and anything
// that does not resolve is dropped rather than rendered as a broken stop.

export const WALKTHROUGH_VERSION = 1;

// Bumping this invalidates every cached walkthrough, which is the point: a
// changed prompt produces different output and old entries would misrepresent
// what the current code would say.
export const PROMPT_VERSION = 5;

export const MAX_CHAPTERS = 6;
export const MAX_STOPS = 16;
export const MAX_HUNKS_PER_STOP = 14;
export const MAX_CHAPTER_TITLE_CHARS = 24;
// Observations are meant to be rare; past these the reader stops telling the
// one that matters from the rest, so the surplus is dropped.
export const MAX_OBSERVATIONS = 6;
const MAX_OBSERVATIONS_PER_STOP = 2;
// One note per file left out of the stops; a bound so a runaway answer cannot
// bloat the cache entry.
const MAX_ROUTINE_NOTES = 200;

const CHAPTER_ICONS = ['bug', 'wrench', 'path', 'flask', 'doc', 'gear'];
const STOP_IMPORTANCE = ['critical', 'normal', 'context'];
export const OBSERVATION_KINDS = ['decision', 'cost', 'limitation', 'asymmetry', 'unproven'];

export const responseSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    focus: { type: 'string' },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          icon: { type: 'string', enum: CHAPTER_ICONS },
          blurb: { type: 'string' },
          stops: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                hunks: { type: 'array', items: { type: 'string' } },
                importance: { type: 'string', enum: STOP_IMPORTANCE },
                prose: { type: 'string' },
                observations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      kind: { type: 'string', enum: OBSERVATION_KINDS },
                      note: { type: 'string' },
                    },
                    required: ['kind', 'note'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['title', 'hunks', 'importance', 'prose', 'observations'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'icon', 'blurb', 'stops'],
        additionalProperties: false,
      },
    },
    routine: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['path', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'focus', 'chapters', 'routine'],
  additionalProperties: false,
};

const asString = (value, max) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return max && trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

/**
 * Turn a raw model response into a walkthrough anchored to real hunk ids.
 *
 * @param {object} raw parsed model JSON
 * @param {Map<string,string>} idByAlias alias → real hunk id, from the digest
 * @param {Array<{path: string, hunks: Array<{alias: string}>}>} digestFiles the digest's files, to place routine notes
 * @returns {{title: string, focus: string, chapters: Array<object>, routine: Array<{path: string, note: string}>, droppedAnchors: number}}
 */
export function normalizeWalkthrough(raw, idByAlias, digestFiles = []) {
  if (!raw || typeof raw !== 'object') {
    throw Object.assign(new Error('Model returned no walkthrough object'), { code: 'invalid-walkthrough' });
  }

  const usedIds = new Set();
  let droppedAnchors = 0;
  let stopCount = 0;
  let observationCount = 0;

  const chapters = [];
  for (const [chapterIndex, rawChapter] of (Array.isArray(raw.chapters) ? raw.chapters : []).entries()) {
    if (chapters.length >= MAX_CHAPTERS) break;
    if (!rawChapter || typeof rawChapter !== 'object') continue;

    const stops = [];
    for (const rawStop of Array.isArray(rawChapter.stops) ? rawChapter.stops : []) {
      if (stopCount >= MAX_STOPS) break;
      if (!rawStop || typeof rawStop !== 'object') continue;

      const hunkIds = [];
      for (const alias of Array.isArray(rawStop.hunks) ? rawStop.hunks : []) {
        const id = idByAlias.get(typeof alias === 'string' ? alias.trim() : '');
        if (!id) {
          droppedAnchors += 1;
          continue;
        }
        // One hunk belongs to exactly one stop; a model that anchors the same
        // code twice would otherwise render it twice in the stream.
        if (usedIds.has(id)) continue;
        if (hunkIds.length >= MAX_HUNKS_PER_STOP) break;
        usedIds.add(id);
        hunkIds.push(id);
      }

      const prose = asString(rawStop.prose);
      if (hunkIds.length === 0 || !prose) continue;

      const observations = [];
      for (const rawObservation of Array.isArray(rawStop.observations) ? rawStop.observations : []) {
        if (observations.length >= MAX_OBSERVATIONS_PER_STOP || observationCount >= MAX_OBSERVATIONS) break;
        const note = asString(rawObservation?.note);
        if (!note || !OBSERVATION_KINDS.includes(rawObservation.kind)) continue;
        observationCount += 1;
        observations.push({ kind: rawObservation.kind, note });
      }

      stopCount += 1;
      stops.push({
        id: `stop-${chapterIndex + 1}-${stops.length + 1}`,
        title: asString(rawStop.title) || `Step ${stopCount}`,
        hunkIds,
        importance: STOP_IMPORTANCE.includes(rawStop.importance) ? rawStop.importance : 'normal',
        prose,
        observations,
      });
    }

    if (stops.length === 0) continue;

    chapters.push({
      id: `chapter-${chapters.length + 1}`,
      title: asString(rawChapter.title, MAX_CHAPTER_TITLE_CHARS) || `Part ${chapters.length + 1}`,
      icon: CHAPTER_ICONS.includes(rawChapter.icon) ? rawChapter.icon : 'doc',
      blurb: asString(rawChapter.blurb),
      stops,
    });
  }

  if (chapters.length === 0) {
    throw Object.assign(
      new Error('Model returned no usable stops for this diff'),
      { code: 'invalid-walkthrough' },
    );
  }

  return {
    title: asString(raw.title) || 'Change walkthrough',
    focus: asString(raw.focus),
    chapters,
    routine: normalizeRoutine(raw.routine, digestFiles, idByAlias, usedIds),
    droppedAnchors,
  };
}

/**
 * A note belongs to a file the digest has and a stop left at least partly
 * uncovered: that is where the reader meets it, in the uncovered tail.
 */
function normalizeRoutine(rawRoutine, digestFiles, idByAlias, usedIds) {
  const leftOut = new Set(digestFiles
    .filter((file) => file.hunks.some((hunk) => !usedIds.has(idByAlias.get(hunk.alias))))
    .map((file) => file.path));
  const routine = [];
  const seen = new Set();
  for (const entry of Array.isArray(rawRoutine) ? rawRoutine : []) {
    if (routine.length >= MAX_ROUTINE_NOTES) break;
    const path = asString(entry?.path);
    const note = asString(entry?.note);
    if (!note || !leftOut.has(path) || seen.has(path)) continue;
    seen.add(path);
    routine.push({ path, note });
  }
  return routine;
}

/**
 * Extract a JSON object from a model response that may or may not honour the
 * schema — some providers wrap it in prose or a fenced block.
 */
export function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw Object.assign(new Error('Model returned an empty response'), { code: 'invalid-walkthrough' });
  }

  const withoutFence = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  try {
    return JSON.parse(withoutFence);
  } catch {
    // Fall through to a bounded scan for the outermost object.
  }

  const start = withoutFence.indexOf('{');
  if (start === -1) {
    throw Object.assign(new Error('Model response contained no JSON object'), { code: 'invalid-walkthrough' });
  }

  for (let end = withoutFence.lastIndexOf('}'); end > start; end = withoutFence.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(withoutFence.slice(start, end + 1));
    } catch {
      // Keep shrinking from the right.
    }
  }

  throw Object.assign(new Error('Model response was not valid JSON'), { code: 'invalid-walkthrough' });
}
