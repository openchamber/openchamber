export type ModelJson = null | boolean | number | string | ModelJson[] | ModelJsonObject;

export interface ModelJsonObject {
  [key: string]: ModelJson | undefined;
}

export type WalkthroughStop = {
  id: string;
  title: string;
  hunkIds: string[];
  importance: (typeof STOP_IMPORTANCE)[number];
  prose: string;
  observations: { kind: (typeof OBSERVATION_KINDS)[number]; note: string }[];
}

export type WalkthroughChapter = {
  id: string;
  title: string;
  icon: (typeof CHAPTER_ICONS)[number];
  blurb: string;
  stops: WalkthroughStop[];
}

export type Walkthrough = {
  title: string;
  focus: string;
  chapters: WalkthroughChapter[];
  routine: { path: string; note: string }[];
  droppedAnchors: number;
}

interface RoutineDigestFile {
  path: string;
  hunks: { alias: string }[];
}

const isModelObject = (value: ModelJson | undefined): value is ModelJsonObject => Boolean(value) && typeof value === 'object';
const isModelArray = (value: ModelJson | undefined): value is ModelJson[] => Array.isArray(value);
const isModelString = (value: ModelJson | undefined): value is string => typeof value === 'string';

export const WALKTHROUGH_VERSION = 1;

export const PROMPT_VERSION = 5;

export const MAX_CHAPTERS = 6;
export const MAX_STOPS = 16;
export const MAX_HUNKS_PER_STOP = 14;
export const MAX_CHAPTER_TITLE_CHARS = 24;
export const MAX_OBSERVATIONS = 6;
const MAX_OBSERVATIONS_PER_STOP = 2;
const MAX_ROUTINE_NOTES = 200;

const CHAPTER_ICONS: ['bug', 'wrench', 'path', 'flask', 'doc', 'gear'] = ['bug', 'wrench', 'path', 'flask', 'doc', 'gear'];
const STOP_IMPORTANCE: ['critical', 'normal', 'context'] = ['critical', 'normal', 'context'];
export const OBSERVATION_KINDS: ['decision', 'cost', 'limitation', 'asymmetry', 'unproven'] = ['decision', 'cost', 'limitation', 'asymmetry', 'unproven'];

const isChapterIcon = (value: ModelJson | undefined): value is WalkthroughChapter['icon'] => CHAPTER_ICONS.some((icon) => icon === value);
const isStopImportance = (value: ModelJson | undefined): value is WalkthroughStop['importance'] => STOP_IMPORTANCE.some((importance) => importance === value);
const isObservationKind = (value: ModelJson | undefined): value is WalkthroughStop['observations'][number]['kind'] => OBSERVATION_KINDS.some((kind) => kind === value);

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

const asString = (value: ModelJson | undefined, max?: number) => {
  if (!isModelString(value)) return '';
  const trimmed = value.trim();
  return max && trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

export function normalizeWalkthrough(raw: ModelJson, idByAlias: Map<string, string>, digestFiles: RoutineDigestFile[] = []): Walkthrough {
  if (!isModelObject(raw)) {
    throw Object.assign(new Error('Model returned no walkthrough object'), { code: 'invalid-walkthrough' });
  }

  const usedIds = new Set<string>();
  let droppedAnchors = 0;
  let stopCount = 0;
  let observationCount = 0;

  const chapters: WalkthroughChapter[] = [];
  for (const [chapterIndex, rawChapter] of (isModelArray(raw.chapters) ? raw.chapters : []).entries()) {
    if (chapters.length >= MAX_CHAPTERS) break;
    if (!isModelObject(rawChapter)) continue;

    const stops: WalkthroughStop[] = [];
    for (const rawStop of isModelArray(rawChapter.stops) ? rawChapter.stops : []) {
      if (stopCount >= MAX_STOPS) break;
      if (!isModelObject(rawStop)) continue;

      const hunkIds: string[] = [];
      for (const alias of isModelArray(rawStop.hunks) ? rawStop.hunks : []) {
        const id = idByAlias.get(isModelString(alias) ? alias.trim() : '');
        if (!id) {
          droppedAnchors += 1;
          continue;
        }
        if (usedIds.has(id)) continue;
        if (hunkIds.length >= MAX_HUNKS_PER_STOP) break;
        usedIds.add(id);
        hunkIds.push(id);
      }

      const prose = asString(rawStop.prose);
      if (hunkIds.length === 0 || !prose) continue;

      const observations: WalkthroughStop['observations'] = [];
      for (const rawObservation of isModelArray(rawStop.observations) ? rawStop.observations : []) {
        if (observations.length >= MAX_OBSERVATIONS_PER_STOP || observationCount >= MAX_OBSERVATIONS) break;
        const note = asString(isModelObject(rawObservation) ? rawObservation.note : undefined);
        if (!note || !isModelObject(rawObservation) || !isObservationKind(rawObservation.kind)) continue;
        observationCount += 1;
        observations.push({ kind: rawObservation.kind, note });
      }

      stopCount += 1;
      stops.push({
        id: `stop-${chapterIndex + 1}-${stops.length + 1}`,
        title: asString(rawStop.title) || `Step ${stopCount}`,
        hunkIds,
        importance: isStopImportance(rawStop.importance) ? rawStop.importance : 'normal',
        prose,
        observations,
      });
    }

    if (stops.length === 0) continue;

    chapters.push({
      id: `chapter-${chapters.length + 1}`,
      title: asString(rawChapter.title, MAX_CHAPTER_TITLE_CHARS) || `Part ${chapters.length + 1}`,
      icon: isChapterIcon(rawChapter.icon) ? rawChapter.icon : 'doc',
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

function normalizeRoutine(rawRoutine: ModelJson | undefined, digestFiles: RoutineDigestFile[], idByAlias: Map<string, string>, usedIds: Set<string>) {
  const leftOut = new Set(digestFiles
    .filter((file) => file.hunks.some((hunk) => {
      const id = idByAlias.get(hunk.alias);
      return id === undefined || !usedIds.has(id);
    }))
    .map((file) => file.path));
  const routine: Walkthrough['routine'] = [];
  const seen = new Set<string>();
  for (const entry of isModelArray(rawRoutine) ? rawRoutine : []) {
    if (routine.length >= MAX_ROUTINE_NOTES) break;
    const path = asString(isModelObject(entry) ? entry.path : undefined);
    const note = asString(isModelObject(entry) ? entry.note : undefined);
    if (!note || !leftOut.has(path) || seen.has(path)) continue;
    seen.add(path);
    routine.push({ path, note });
  }
  return routine;
}

export function parseModelJson(text: string): ModelJson {
  if (!isModelString(text) || !text.trim()) {
    throw Object.assign(new Error('Model returned an empty response'), { code: 'invalid-walkthrough' });
  }

  const withoutFence = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf('{');
    if (start === -1) {
      throw Object.assign(new Error('Model response contained no JSON object'), { code: 'invalid-walkthrough' });
    }

    for (let end = withoutFence.lastIndexOf('}'); end > start; end = withoutFence.lastIndexOf('}', end - 1)) {
      try {
        return JSON.parse(withoutFence.slice(start, end + 1));
      } catch {
        continue;
      }
    }

    throw Object.assign(new Error('Model response was not valid JSON'), { code: 'invalid-walkthrough' });
  }
}
