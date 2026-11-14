import {
  GUEST_STATUS_VIEW_ICON,
  GUEST_TONES,
  SERVICE_MARK_TEXT_MAX,
  hasGuestCapability,
  type GuestTone,
  type ServiceMark,
  type ServiceMarkTarget,
} from '@openchamber/sdk';
import { z } from 'zod';

import { normalizePath } from '@/lib/pathNormalization';

import { isGuestActive } from './capabilities.ts';
import { safeHttpsAddress } from './tool-presentation.ts';
import type { InstalledGuest } from './types.ts';

/** One mark as `GET /api/guests/marks` lists it: who set it, on what, and what it shows. */
export type GuestMarkEntry = { guestId: string; target: ServiceMarkTarget; mark: ServiceMark };

const entrySchema = z.object({
  guestId: z.string().min(1),
  target: z.union([
    z.object({ sessionId: z.string().min(1) }),
    z.object({ directory: z.string().min(1), branch: z.string().min(1).optional() }),
  ]),
  mark: z.object({
    icon: z.string().regex(GUEST_STATUS_VIEW_ICON),
    tone: z.enum(GUEST_TONES),
    text: z.string().trim().min(1).max(SERVICE_MARK_TEXT_MAX),
    url: z.string().optional(),
  }),
}) satisfies z.ZodType<GuestMarkEntry>;

const listSchema = z.object({ marks: z.array(z.unknown()) });

/**
 * The marks route's answer. `null` when it is not that answer at all, which a
 * caller treats as a failed read; one entry this build cannot read is left
 * out and the rest stay.
 */
export const parseGuestMarksJson = (content: string): GuestMarkEntry[] | null => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  const list = listSchema.safeParse(value);
  if (!list.success) return null;
  return list.data.marks.flatMap((entry) => {
    const parsed = entrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
};

/** A mark as a sidebar row draws it. */
export type RowGuestMark = {
  guestId: string;
  /** The extension's name, which the tooltip puts before `text`. */
  guestName: string;
  /** The extension's place in the catalog; rows list marks in this order. */
  order: number;
  icon: string;
  tone: GuestTone;
  text: string;
  /** The extension has a panel, and a click opens it. */
  panel: boolean;
  /** What a click opens when the extension has no panel; null when the mark gave no usable address. */
  url: string | null;
};

/** A folder the app knows and the project it belongs to: project roots and worktree paths, normalized. */
export type GuestMarkPlace = { path: string; projectId: string };

export type GuestMarkIndex = {
  bySession: ReadonlyMap<string, readonly RowGuestMark[]>;
  /** By the normalized folder of a `{ directory }` target. */
  byFolder: ReadonlyMap<string, readonly RowGuestMark[]>;
  /** By `guestBranchMarkKey` of the project the target's folder belongs to. */
  byBranch: ReadonlyMap<string, readonly RowGuestMark[]>;
};

const NO_MARKS: ReadonlyMap<string, readonly RowGuestMark[]> = new Map();

/** The one list every row without marks reads. */
export const NO_ROW_GUEST_MARKS: readonly RowGuestMark[] = [];

export const EMPTY_GUEST_MARK_INDEX: GuestMarkIndex = { bySession: NO_MARKS, byFolder: NO_MARKS, byBranch: NO_MARKS };

export const guestBranchMarkKey = (projectId: string, branch: string): string => JSON.stringify([projectId, branch]);

/** Whether the sidebar shows this extension's marks: it is on, approved, and its manifest asks for them. */
export const mayGuestShowMarks = (guest: InstalledGuest): boolean => (
  guest.marks === true && isGuestActive(guest) && hasGuestCapability(guest.capabilities, 'marks')
);

/** The project of the known folder that holds `directory`, by the longest match. */
const projectOfFolder = (directory: string, places: readonly GuestMarkPlace[]): string | null => {
  let best: GuestMarkPlace | null = null;
  for (const place of places) {
    if (best && place.path.length <= best.path.length) continue;
    if (directory === place.path || directory.startsWith(place.path.endsWith('/') ? place.path : `${place.path}/`)) best = place;
  }
  return best?.projectId ?? null;
};

const sameRowMark = (a: RowGuestMark, b: RowGuestMark): boolean => (
  a.guestId === b.guestId && a.guestName === b.guestName && a.order === b.order && a.icon === b.icon
  && a.tone === b.tone && a.text === b.text && a.panel === b.panel && a.url === b.url
);

/** `next` with every list that did not change taken from `previous`, and `previous` itself when none did. */
const keepUnchanged = (
  next: Map<string, RowGuestMark[]>,
  previous: ReadonlyMap<string, readonly RowGuestMark[]>,
): ReadonlyMap<string, readonly RowGuestMark[]> => {
  const kept = new Map<string, readonly RowGuestMark[]>();
  let changed = next.size !== previous.size;
  for (const [key, marks] of next) {
    const before = previous.get(key);
    if (before && before.length === marks.length && before.every((mark, index) => sameRowMark(mark, marks[index]))) {
      kept.set(key, before);
    } else {
      kept.set(key, marks);
      changed = true;
    }
  }
  return changed ? kept : previous;
};

/**
 * Joins what the server lists with what this client holds: the catalog says
 * whose marks may show, under what name and in what order, and the known
 * folders place a branch target in a project. A branch target in a folder of
 * no known project shows nowhere. One mark per extension per row key; of two
 * the later in the list stays. Lists and maps that did not change keep their
 * identity, so a row whose marks are the same does not render.
 */
export const joinGuestMarks = (
  entries: readonly GuestMarkEntry[],
  guests: readonly InstalledGuest[],
  places: readonly GuestMarkPlace[],
  previous: GuestMarkIndex,
): GuestMarkIndex => {
  const bySession = new Map<string, RowGuestMark[]>();
  const byFolder = new Map<string, RowGuestMark[]>();
  const byBranch = new Map<string, RowGuestMark[]>();
  const put = (into: Map<string, RowGuestMark[]>, key: string, mark: RowGuestMark): void => {
    const marks = into.get(key);
    if (!marks) {
      into.set(key, [mark]);
      return;
    }
    const own = marks.findIndex((entry) => entry.guestId === mark.guestId);
    if (own === -1) marks.push(mark);
    else marks[own] = mark;
  };
  guests.forEach((guest, order) => {
    if (!mayGuestShowMarks(guest)) return;
    const panel = Boolean(guest.entry);
    for (const { guestId, target, mark } of entries) {
      if (guestId !== guest.id) continue;
      const row: RowGuestMark = {
        guestId,
        guestName: guest.name,
        order,
        icon: mark.icon,
        tone: mark.tone,
        text: mark.text,
        panel,
        url: panel || mark.url === undefined ? null : safeHttpsAddress(mark.url),
      };
      if ('sessionId' in target) {
        put(bySession, target.sessionId, row);
        continue;
      }
      const directory = normalizePath(target.directory);
      if (!directory) continue;
      if (target.branch === undefined) {
        put(byFolder, directory, row);
        continue;
      }
      const projectId = projectOfFolder(directory, places);
      if (projectId) put(byBranch, guestBranchMarkKey(projectId, target.branch), row);
    }
  });
  const index = {
    bySession: keepUnchanged(bySession, previous.bySession),
    byFolder: keepUnchanged(byFolder, previous.byFolder),
    byBranch: keepUnchanged(byBranch, previous.byBranch),
  };
  return index.bySession === previous.bySession && index.byFolder === previous.byFolder && index.byBranch === previous.byBranch
    ? previous
    : index;
};

/**
 * The marks of one row from the lists that name it, most specific first (the
 * session's, the branch's, the folder's): one per extension, the first list
 * that has one wins, in catalog order. A single non-empty list is returned as
 * it is.
 */
export const mergeRowGuestMarks = (lists: ReadonlyArray<readonly RowGuestMark[]>): readonly RowGuestMark[] => {
  const filled = lists.filter((list) => list.length > 0);
  if (filled.length === 0) return NO_ROW_GUEST_MARKS;
  if (filled.length === 1) return filled[0];
  const byGuest = new Map<string, RowGuestMark>();
  for (const list of filled) {
    for (const mark of list) if (!byGuest.has(mark.guestId)) byGuest.set(mark.guestId, mark);
  }
  return [...byGuest.values()].sort((a, b) => a.order - b.order);
};

/** How many marks a row draws; the rest are listed in the row's tooltip. */
export const ROW_GUEST_MARKS_SHOWN = 2;
